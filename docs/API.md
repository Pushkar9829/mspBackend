# mspNode API — auth, users, roles, tenants, platform

Base path: `/api/v1`. JSON in/out. Errors: `{ message, code, requestId, fields? }`.
- `400 VALIDATION_ERROR`: `message` = first problem (`"email: Invalid email"`), `fields` = **every** failing path → message (`{ "email": "...", "roleId": "..." }`; path without the `body`/`query`/`params` prefix; `"_"` for whole-object issues).
- `409 DUPLICATE` (Mongo E11000): `message` names the meaningful field, never the scoping `tenantId` (`"SKU is already in use in this store"`), plus `field` and `fields: { sku: "..." }`.
- `409 CONFLICT` (optimistic concurrency) carries `currentVersion`.
Every response carries `X-Request-Id` (an incoming safe `X-Request-Id` is reused).
List endpoints are paginated: `?page=&limit=` (limit ≤ 100) → `{ data: [...], meta: { total, page, limit, pages } }`.
Bodies are validated with zod; unknown fields are stripped, a missing body is treated as `{}`.

## Auth model

| Token | Where | Lifetime | Notes |
| --- | --- | --- | --- |
| Access token (JWT HS256) | `Authorization: Bearer …` | `JWT_ACCESS_TTL` (8h default) | Payload `{ sub, tenantId, role, tv }`. `tv` must equal `User.tokenVersion`. |
| Refresh token (JWT HS256) | httpOnly cookie `refreshToken` (path `/api/v1/auth`) | `JWT_REFRESH_TTL` (7d) — cookie `Max-Age` derived from it | Payload `{ sub, sid, tv, jti }`. One `RefreshSession` per login/device. |

- **Web** clients never see the refresh token in JSON; it lives only in the cookie.
- **Mobile** clients send `X-Client: mobile`: login/refresh/change-password responses then include `refreshToken`, and `/auth/refresh` and `/auth/logout` accept `{ refreshToken }` in the body.
- **Rotation & reuse detection:** every refresh swaps the session's token. Presenting the immediately previous token within 30 s → `401 REFRESH_RACE` (concurrent tabs; retry with the cookie). Presenting any other old token → `401 TOKEN_REUSE`; all of the user's sessions and access tokens are revoked.
- **Revocation (`tokenVersion` bump):** logout-all, password change, password reset, role change, status change (suspend), refresh-token reuse, account deletion. Revoked access tokens → `401 TOKEN_REVOKED`.
- **Account / tenant checks on every request, refresh and socket connect:** user status must be `active` (`403 ACCOUNT_INACTIVE`); staff of a `suspended`/`archived` tenant are rejected (`403 TENANT_SUSPENDED`). Buyers are not tenant members, so a store suspension does not lock buyers out.
- **Login delay (lockout):** after 5 failures within an hour, a temporary per-account delay applies (30 s, 1 m, 2 m … capped at 15 m) → `429 LOGIN_DELAYED` with `Retry-After`. The status is not changed and existing sessions are not killed.
- **No user enumeration:** login → generic `Invalid credentials`; register → identical `201` whether or not the email exists (an existing owner gets an email instead); forgot-password → identical response; the reset token is only emailed (logged to the console only with `NODE_ENV=development`).
- **Email verification:** new buyers start `emailVerified: false`. Browsing works; checkout requires a verified email when `REQUIRE_EMAIL_VERIFICATION=true` (default in production) — enforced via `requireVerifiedEmail` (`403 EMAIL_NOT_VERIFIED`). Accounts that existed before this feature, admin-created users and seeded users are verified. A password reset also verifies the email.

## Tenancy model

- **Staff** (`tenant_admin`, `support_agent`, custom roles): `tenantId` = their store.
- **Buyers** (system `buyer` role): `tenantId: null`; `homeTenantId` = the store they signed up through (`tenantSlug`), storefront affinity only.
- **Platform admin**: system role with `scope: "platform"` (`super_admin`). Only this role yields `req.isPlatformAdmin`; `"*"` / `tenants.*` stored on any other role are ignored.
- `resolveTenant` middleware: platform admin → `X-Tenant-Id` / `?tenantId=` (or all tenants); staff → own tenant (a different `X-Tenant-Id` is `403`); **buyers pass through** with `req.tenantId = null`, `req.isBuyer = true`, `req.homeTenantId`; anyone else without a tenant → `403`. Buyer-facing handlers must scope by `req.user._id`. Staff-only routers add `requireStaff` or `requireTenant`.

## Endpoints

### Auth (`/auth`)

| Method & path | Auth | Body | Notes |
| --- | --- | --- | --- |
| `POST /register` | — | `{ name, email, password, phone?, company?, tenantSlug? }` | Rate limited (10/h/IP). `201 { ok, email, message }`. |
| `POST /login` | — | `{ email, password }` | Rate limited (20/15 min/IP). `{ user, accessToken, refreshToken? (mobile) }` + cookie. |
| `POST /refresh` | cookie / body (mobile) | `{ refreshToken? }` | `{ accessToken, refreshToken? }` + rotated cookie. |
| `POST /logout` | none required | `{ refreshToken? }` | Revokes this device's session; works with an expired access token. |
| `POST /logout-all` | Bearer | — | Revokes all sessions + access tokens. |
| `POST /verify-email` | — | `{ token }` | Single-use, 24 h. |
| `POST /resend-verification` | optional Bearer | `{ email? }` | Generic response. |
| `GET /me` | Bearer | — | Public user incl. `emailVerified`, `homeTenantId`, ledger summary. |
| `PATCH /me` | Bearer | `{ name?, phone?, profile? }` | `profile`: company, gstin, addressLine1, preferredSizes, location. |
| `GET /me/export` | Bearer | — | Own profile, addresses, orders summary, wishlist (JSON download). |
| `DELETE /me` | Bearer (buyers only) | `{ password }` | Anonymises the account; `409 OPEN_ORDERS` while orders are in progress. Orders/invoices are retained (tax law). |
| `POST /forgot-password` | — | `{ email }` | Rate limited (5/15 min). Generic response. |
| `POST /reset-password` | — | `{ token, password }` | Revokes all sessions. |
| `POST /change-password` | Bearer | `{ currentPassword, newPassword }` | Revokes other sessions, returns fresh `accessToken` (+ cookie). |

### Users (`/users`) — staff only (`requireStaff`)

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /` | `users.view` | Filters: `q, status, role, roleId, staff=true\|false` (false = buyers only), `emailVerified=true\|false, homeTenantId, from, to` (YYYY-MM-DD = IST day), `sort=createdAt\|name\|email\|lastLoginAt\|status\|updatedAt`, `order=asc\|desc` (default `createdAt desc`). Staff see their members plus buyers whose `homeTenantId` is their store (read-only). Rows: public user + `homeTenant: { id, name, slug } \| null`. |
| `GET /:id` | `users.view` | Includes `homeTenant`. |
| `POST /:id/sign-out-everywhere` | `users.edit` | Platform admin: any user. Store staff: members of their own store whose role does not exceed their permissions (buyers / platform users → 404/403). Bumps `tokenVersion` + revokes refresh sessions. `{ ok, id, revokedAt }`. Audited (`sign_out_everywhere`). |
| `POST /` | `users.create` | `{ name, email, password, roleId, phone?, tenantId? (platform only), status? (active/pending/suspended), profile? }`. Role must be a system tenant role or a role of the same tenant, and (non-platform actors) contain only permissions the actor holds. Buyer role → `tenantId: null`, `homeTenantId` = tenant. |
| `PATCH /:id` | `users.edit` | `{ name?, phone?, roleId?, status?, profile? }`. Members of own tenant only; cannot change own role/status; role/status change bumps `tokenVersion`. |
| `DELETE /:id` | `users.delete` | Suspends + revokes tokens. |

### Roles & permissions — staff only

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /permissions` | `roles.view` | Array of `{ _id, key, resource, action, group, label, description, platformOnly }` sorted by group. Platform-only keys hidden from tenant staff. |
| `GET /roles` | `roles.view` | Paginated. Staff: own tenant's roles + system tenant roles **except the buyer role**. Platform: all; `scope=platform\|tenant\|staff\|buyer`, `system=true\|false`, `q`. Each row has `usersCount` (holders, not deleted; within the store for staff / a selected tenant). |
| `GET /roles/:id` | `roles.view` | Buyer role → 404 for staff. |
| `POST /roles` | `roles.create` | `{ name, slug?, permissions[], description?, tenantId? (platform only) }`. Custom roles always belong to a tenant. `"*"` and `tenants.*` are never assignable; non-platform actors may only grant permissions they hold. |
| `PATCH /roles/:id` | `roles.edit` | `{ name?, permissions?, description? }`. System role permissions are code-defined (read-only). Actor must hold every permission of the role. |
| `DELETE /roles/:id` | `roles.delete` | `409 ROLE_IN_USE` while any user holds it. |

Permission catalog: `src/config/constants.js` (`PERMISSIONS`). Tenant admins get every key except platform-only ones (incl. `ledger.view`, `ledger.manage`, `reviews.moderate`, `media.upload`, `returns.manage`).

### Tenants (`/tenants`)

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /public` | — | Public store directory (active/trial, paginated, rate limited): `{ id, name, displayName, slug, city, state, logo, rating, ratingCount, productCount, deliveryModes, minOrderValue }`. See Storefront support, part 3. |
| `GET /public/:idOrSlug` | — | Public store info (active/trial only): `{ id, name, displayName, slug, status, branding, pickupCity, deliveryZones[{ name, etaDaysMin, etaDaysMax }] }`. `displayName` = setting `store.displayName` or the store name. |
| `GET /` | `tenants.view` (platform) | `q, status` (comma list), `sort=createdAt\|updatedAt\|name\|slug\|status`, `order`. Rows include `staffCount`. Sales stats: `/reports/tenants`. |
| `GET /me` | any user | Staff: own tenant. Buyers: public info of `homeTenantId` incl. `displayName` (or `null`). |
| `PATCH /me` | `settings.edit` | `{ name?, branding?, businessProfile?, taxSettings?, orderRules?, deliveryZones?, pickupAddress?, notificationPreferences? }`. Nested objects are merged field-by-field; no status/slug changes. |
| `GET /` · `GET /:id` | `tenants.view` (platform) | |
| `POST /` | `tenants.create` (platform) | Optional `admin: { name, email, password }`. |
| `PATCH /:id` | `tenants.edit` (platform) | Status → `suspended`/`archived` emits `TENANT_SUSPENDED` and blocks the tenant's staff immediately. |

### Platform (outside `/api/v1`)

| Path | Notes |
| --- | --- |
| `GET /api/health` | Liveness (process up). |
| `GET /api/ready` | Readiness: `503` unless MongoDB is connected. Render `healthCheckPath`. |
| `GET\|POST /api/internal/cron/:name` | `Authorization: Bearer $CRON_SECRET` (timing-safe). `503` if `CRON_SECRET` unset. Calls `runJob(name)` from `src/jobs/index.js`. |
| `GET /uploads/*` | Only png/jpg/webp/gif/pdf are served; `X-Content-Type-Options: nosniff`, `Content-Security-Policy: …; sandbox`, `Content-Disposition: inline` for images, `attachment` otherwise. |

## Uploads

`utils/storage.js`: folder names are whitelisted (`UPLOAD_FOLDERS`, otherwise `general`), the client filename/MIME are ignored, the type is sniffed from magic bytes (png, jpeg, webp, gif, pdf only) and the extension derived from it; 10 MB limit. Local disk only: on Vercel the default is `/tmp/uploads` (ephemeral, per instance) and on Render the disk is wiped on deploy — persistent uploads need object storage (S3/R2/Cloudinary), not implemented.

## Deployment

- **Render** (`render.yaml`): `NODE_ENV=production`, health check `/api/ready`, every variable declared (`sync: false` → set in dashboard). Free plan sleeps: in-process cron pauses; use a paid plan or an external scheduler calling the cron endpoint.
- **Vercel** (`vercel.json`, `api/index.js`): no WebSockets (Socket.IO needs a long-running server), no in-process cron — `crons` call `/api/internal/cron/{reservation-timeout,scheduled-publish,low-stock,retry-events,cleanup}`. Sub-daily schedules need a Pro plan (Hobby allows daily crons only); otherwise point an external scheduler (e.g. cron-job.org) at the endpoint with the bearer secret.
- **Process:** `unhandledRejection`/`uncaughtException` are logged; SIGTERM/SIGINT stop cron (`stopJobs`), close sockets and HTTP, disconnect Mongo (10 s hard timeout).
- **Startup (`prepareRuntime`):** connect → warn if not a replica set → permission catalog + system roles sync → optional seed (`SEED_ON_START`, demo only with `SEED_DEMO` and never in production) → auth migrations (`RUN_MIGRATIONS`, default on) → `syncIndexes()` for all models (`SYNC_INDEXES`, default on outside production) → `ensureProductSlugs()`.
- **Logging:** one JSON line per request (`requestId, method, path, status, ms, userId`); level via `LOG_LEVEL`.
- **Rate limits** are in-memory per process — use a shared store when running several instances.

### Required environment (production)

`NODE_ENV=production`, `MONGODB_URI` (replica set/Atlas), `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (≥ 32 chars, different, not the example values — startup fails otherwise), `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` (≥ 12 chars, non-default), `CORS_ORIGIN` / `FRONTEND_URL` (exact origins), `CRON_SECRET`, `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true` for a cross-site frontend, `SMTP_*` (verification/reset mail), plus `RAZORPAY_*`, `MSG91_AUTH_KEY` + `MSG91_DLT_ENTITY_ID` + `MSG91_TEMPLATE_<EVENT>` DLT template ids, `NOTIFICATION_UNSUBSCRIBE_SECRET`, `DELHIVERY_*`, `MAPS_API_KEY`, `PUBLIC_API_URL` as used. Full list: `.env.example`.

## Settings

`GET/PUT /settings/...` only accept keys declared in `src/modules/settings/registry.js`; any other key now returns `404`. Add new keys to the registry before using them.

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /settings/public` | — | `?tenantId=` or `?tenantSlug=` optional. `delivery.etaDaysMin/Max` + `etaSource` are always set (platform estimate without a store; setting `delivery.etaDays`). `{ name, slogan, currency, supportEmail, mapsProvider, festival, platformFee*, deliveryPartners, codEnabled, freeDeliveryAbove, returnsEnabled, returnWindowDays, taxInclusive, feeTaxRate, delivery, store }` (see Storefront support); with a store the store's overrides apply and `store = { id, name, displayName, slug, branding }` (else `null`). |
| `GET /settings` | settings.view/edit | Stored rows of the caller's scope. |
| `GET /settings/keys` | settings.view/edit | `{ scope, keys: string[], definitions: [{ key, type, label, description, group, scopes, overridable, default, secret, public, min?, max?, enum? }] }`. |
| `GET /settings/commerce` | settings.view/edit | Effective commerce settings for the caller's store. |
| `PUT /settings/:key` | `settings.edit` | `{ value }`. Platform admin without tenant → platform value; staff (or platform with `X-Tenant-Id`/`?tenantId=`) → store override. Invalid → `400` with `fields: { "value.x": msg }`. |
| `DELETE /settings/:key?scope=tenant[&tenantId=]` | `settings.edit` | Removes a store override so the platform default applies again. `{ ok, key, scope, tenantId, removed, previous, effective, source }`. Only `scope=tenant`; key must be store-writable. Audited (`delete_override`). |

Where keys are used: `platform.supportEmail` → public settings, every email footer + `Reply-To`; `platform.currency` → public settings; `platform.mapsProvider` → geocoding (Google only when `"google"` **and** `MAPS_API_KEY`), public settings; `platform.defaultTaxRate` → `taxClass` of new products without a rate when the store's `taxSettings.defaultTaxRate` is 0; `store.displayName` → public store info.

## Retention

TTL indexes: notifications `NOTIFICATION_TTL_DAYS` (90), analytics raw events `ANALYTICS_RETENTION_DAYS` (180; daily rollups kept), audit log `AUDIT_RETENTION_DAYS` (365). Audit `before`/`after` snapshots are capped at ~10 KB.

## Data migrations

| Command / trigger | What |
| --- | --- |
| Automatic on start (`RUN_MIGRATIONS`, `src/seeds/migrations.js`) | Buyers with a `tenantId` → `homeTenantId` (tenantId cleared); legacy `status: "locked"` → `active`; pre-existing users get `emailVerified: true`; `tokenVersion` backfilled. Idempotent. |
| Automatic on start (`SYNC_INDEXES=true`) | `Model.syncIndexes()` for every model (drops undeclared indexes, builds new unique/TTL/partial ones). Run once with `SYNC_INDEXES=true` after deploying in production. |
| Background on start (`registerNotificationListeners()`) | Notification, audit, analytics and address index/retention migrations (Agent D). |
| Automatic on start (`RUN_MIGRATIONS`, `runStorefrontMigrations`) | Settings / order mojibake repair; default CMS pages (insert + seed-hash refresh of unedited pages); order item `slug`/`image` backfill; address `state` → full name + `stateCode`. Idempotent. |
| `node src/modules/catalog/migrate.js` | Catalog: uppercase SKUs, restock-alert normalisation/dedupe, product slug backfill + wishlist rows, catalog index sync. Idempotent. |
| `npm run seed` | Foundation (system roles, super admin if absent, default settings); demo data only with `SEED_DEMO=true` outside production. |

Old refresh tokens (issued before `RefreshSession`) are no longer accepted: users sign in again once after the deploy.

## Platform additions (agent 2)

### Audit (`/audit`, `audit.view`, tenant-scoped for staff)

- `GET /audit` filters: `action` / `resource` / `method` (comma lists), `outcome=success|failure`, `actorId`, `resourceId`, `requestId`, `ip`, `statusCode`, `from`/`to` (YYYY-MM-DD = IST day, or ISO), `q`, `order=asc|desc`. Paginated.
- `GET /audit/:id` → one entry (actor + tenant populated). `404` outside the caller's tenant.
- Entry: `{ actorId, tenantId, action, resource, resourceId, outcome, error?, before, after, ip, userAgent, requestId, metadata: { method, path, statusCode, query, params, input } }`.
  - `before` = the document as it was **before** the handler ran (PATCH/PUT/DELETE, and POST on `/:id` routes) for known resources (`user, role, tenant, product, category, brand, variant, media, review, cms, order, coupon, offer, priceList, warehouse, notification, settings`); secrets stripped, capped at 10 KB. Never kept for failed calls.
  - Failed mutating calls (4xx/5xx, incl. validation and permission failures on routes where `audit()` runs first) are recorded with `outcome: "failure"` and `error: { message, code, fields }`.
  - Login / logout record the account as `actorId` (also for failed logins of an existing account).

### Reviews moderation — `GET /products/reviews/manage` (`reviews.moderate` or `products.edit`)

Query: `status=published|hidden, productId, userId, rating=1..5` (comma list) or `minRating/maxRating`, `verified=true|false`, `q` (review text, author, product name/SKU/slug, buyer name/email), `sort=createdAt|updatedAt|rating|moderatedAt`, `order`, `page`, `limit`.
Row: `{ id, authorName, rating, body, verifiedPurchase, createdAt, updatedAt, status, tenant: { id, name, slug }, buyer: { id, name, email }, product: { id, name, slug, sku }, productId, userId, tenantId, orderId, moderation: { status, moderatedAt, moderatedBy: { id, name, email } | null, note } }`.

### Catalog

- `specifications` (create/PATCH/bulk JSON): object of key → scalar | null | list of scalars | one-level object of scalars | list of `{ label|name|key, value, unit? }`; or the whole value as a list of `{ label|name|key, value }` rows (stored as an object). ≤ 50 keys, ≤ 16 KB.
- `status: "scheduled"` (create/PATCH) needs `products.publish` and a future `scheduledAt` (also to move the time of a scheduled product). Leaving `scheduled` clears `scheduledAt`. The scheduler (`publishScheduledProducts()`) re-checks that the user who scheduled is active, still in the store, still holds `products.publish`, and that the store is active; otherwise the product returns to `draft` with `scheduleError`.
- New products without `taxClass.rate` get the store's `taxSettings.defaultTaxRate`, else `platform.defaultTaxRate`, else 0.
- `GET /products/export` honours `q, categoryId, brandId, status` (comma list; default all but archived), `tag, bulkEligible`.
- Variant `attributes.custom: {}` removes every custom attribute (PATCH); a non-empty `custom` replaces the set.
- `POST /products/bulk-upload?dryRun=true[&availableQtyMode=set|skip]`: dry run → `200 { dryRun: true, ok, availableQtyMode, summary: { total, valid, invalid, create, update }, rows: [{ index, sku, action: create|update|null, ok, errors: { field: msg }, stock: { mode, qty } | null }] }`, nothing written. Real run → `201 { created, updated, errors[{ index, sku, message, code, fields? }], ok, availableQtyMode }`. **`availableQty` sets the absolute sellable stock** of the product's primary variant through `inventory.setAvailableQty` (in `warehouseId` or the default warehouse) — it is not added to existing stock. `availableQtyMode=skip` ignores the stock column. Bulk JSON rows also accept `scheduledAt` and `specifications`.
- Media folders: `catalog, products, brands, categories, cms, avatars`.

### Notifications (`/notifications`)

- `POST /` (`notifications.send`): the audience comes **only from the body** (`audienceType`, `tenantId`, `roleSlug`, `userIds`); `X-Tenant-Id` / `?tenantId=` never change it. `audienceType=role` without `tenantId` (platform admins only) reaches holders of that role in every store. `channels.email: true` also emails a broadcast audience in the background (batches of `BROADCAST_EMAIL_BATCH`=25, `BROADCAST_EMAIL_PAUSE_MS`=1000 between batches, max `BROADCAST_EMAIL_MAX`=5000), each recipient through their email preference for the category + signed unsubscribe link; progress on the notification as `emailDelivery: { status: pending|sending|done|failed, recipients, sent, skipped, failed }`. Audited (`announce`; `POST /:id/cancel` → `cancel_announcement`).
- `GET /sent`: with a tenant filter (platform `?tenantId=`/`X-Tenant-Id`) platform-wide `all` announcements are included (`includeGlobal=false` to hide; store staff opt in with `includeGlobal=true`). Rows carry `scope: all|store|role|user`, `global`, `tenant { id, name, slug }`, `createdBy { name, email }`. Filter `audienceType`.

### Sockets

- `order:updated` — forwarded from the domain event `ORDER_UPDATED` (`{ order }`) to rooms `tenant:<tenantId>` (store staff), `user:<buyerId>` and `platform:admins`. Payload `{ order: { id, _id, orderNumber, tenantId, buyerId, status, paymentStatus, updatedAt, …paymentMethod/fulfillmentMode/grandTotal/itemsCount when the event carries them }, orderId, status }`; refetch `GET /orders/:id` for detail.
- Role announcements (other than `super_admin`) are pushed to each holder's `user:<id>` room.

### CMS

- `PATCH /cms/admin/:id`: optional `If-Match: <version>` (or `"3"`, `W/"3"`) or body `expectedVersion` → `409 CONFLICT { currentVersion }` on mismatch. A PATCH that changes nothing returns the page unchanged (no version bump). `scheduledAt` must be in the future and the page a draft / in review (`409 INVALID_STATE` for published/unpublished).
- Transitions `POST /:id/review | /publish | /unpublish | /draft` (body `{ expectedVersion? }`) bump `version` and write a version entry (`action` = review/publish/unpublish/draft, `toStatus`).
- `POST /:id/schedule` (`cms.publish`) `{ scheduledAt: ISO | null, expectedVersion? }` — schedule / cancel; version entry `schedule` / `unschedule`. The scheduler's publish also writes a `publish` version entry.
- `GET /cms/admin?includeGlobal=true` → the store's pages + global pages (rows carry `global`); platform `?globalOnly=true`.
- Public `GET /cms/pages` and `GET /cms/pages/:slug` accept `tenantId`, `tenantSlug` or `tenant` (id or slug); unknown/inactive store → 404. A store page falls back to the global page of the same slug.
- Public `GET /cms/pages/:slug` fills settings tokens (`{{supportEmail}}`, `{{etaDays}}`, `{{returnWindowDays}}`, …) and resolves the `returns` ↔ `refunds` alias (`aliasOf`). The admin API returns raw tokens. See Storefront support, part 3.
- Version entries: `GET /cms/admin/:id/versions` → `[{ version, action, toStatus, actorId { name, email }, at, snapshot }]`.

### Chat

`GET /chat/:id/messages?envelope=1` → `{ data, hasMore, nextBefore }` (headers `X-Has-More` / `X-Next-Before` are still sent; without `envelope` the body stays a plain array).

## Storefront support

Buyer-facing gaps for the storefront. All paths are under `/api/v1`. Tests: `src/tests/storefront.js` (95 checks). No data migration is needed: legacy duplicate cart lines are merged when the cart is first read, and the new coupon fields have defaults. New env vars are optional (`FRONTEND_ORDER_PATH`, `FRONTEND_STAFF_ORDER_PATH`, `FRONTEND_PRODUCT_PATH`).

### Cart: one line per variant (changed model)

A cart now has **one line per variant**. Whether a line is "bulk" is **derived from its quantity**; it is no longer chosen by the client.

- **Bulk range.** A product has a bulk range only when it is bulk-eligible (`wholesale.bulkEligible`). The range starts at `bulkFrom` = MOQ rounded up to the pack multiple. When MOQ and pack are both 1, `bulkFrom` is 1, so every quantity of that product is bulk.
- **Rules inside the bulk range.** The pack multiple applies (`400 PACK_MULTIPLE`). The per-order max applies across the product's bulk-range lines (`400 MAX_QTY`).
- **Rules below the bulk range.** The line is a regular purchase, and any quantity of 1 or more is valid. The old `MOQ` error is gone.
- **Slab prices.** For every bulk-eligible product, the slab (tier) price is chosen automatically from the line quantity.
- **Coupons and offers.** `appliesTo: bulk|regular` still works: each line's derived `bulk` flag decides it.
- **Order lead time.** `wholesale.leadTimeDays` is added to the ETA for lines in the bulk range.
- **`POST /cart/items` input.** It still accepts `bulk: boolean` and now also `mode: "regular"|"single"|"bulk"`. Both are hints only:
  - Adding to an existing line of the variant adds to its quantity.
  - A **new** line added with `bulk: true` / `mode: "bulk"` starts at `bulkFrom`.
  - `bulk: true` on a product that is not bulk-eligible is still `400 NOT_BULK`.
- **`fulfillmentMode` on add.** When it is omitted, the existing line keeps its mode.
- **Legacy carts.** A cart that has two lines of one variant (regular + bulk) is merged when it is first read (`getOrCreateCart`), in a transaction:
  - The first line keeps its id. The other lines' holds are released.
  - The merged line takes one hold for the total. If stock is short, the line stays without a hold and shows up in `unavailable`.
- **Guest-cart merge.** It clamps to the same rules: stock first, then pack and max in the bulk range.

Trade-offs (old behaviour that changed):
- A buyer can no longer hold a regular line and a bulk line of the same pack at the same time.
- Adding 1 unit to a line that is in the bulk range can fail with `PACK_MULTIPLE`. The UI should step by `rules.step`.
- A bulk-eligible product with MOQ 1 and pack 1 is "bulk" at every quantity:
  - "regular-only" coupons never apply to it;
  - "bulk-only" coupons always apply to it.
- `src/tests/e2eSmoke.js` asserted the two-line model. It was updated to the new model, but it was not run here: it needs a running server with seeded demo data.

### Cart quote line (`GET /cart`, every cart mutation, `POST /checkout/preview`) (changed)

Line (`groups[].items[]`):
```
{ cartItemId, tenantId, productId, variantId, sku,
  slug,                      // the product's real public slug (was the lower-cased SKU)
  name, brand, image, pack, attributes, hsn, warehouseId, wholesale,
  bulk,                      // derived: bulk-eligible product AND qty >= bulkFrom
  qty, fulfillmentMode, easyReturn, deliveryModes,
  listPrice, baseUnitPrice, unitPrice, lineSubtotal, couponShare, taxRate, taxableValue, tax, lineTotal, breakdown,
  tierPrices: [{ minQty, maxQty, catalogUnitPrice, unitPrice, unitPricePerBaseUnit }],   // charged slabs (bulk-eligible products)
  appliedSlab: { minQty, maxQty, unitPrice } | null,
  nextSlab: { minQty, unitPrice, saveEach, addQty } | null,     // next cheaper slab
  unitPricePerBaseUnit: { amount, unit: "kg"|"L"|"pc"|"m", label: "₹180/kg" } | null,   // from packSize
  rules: { min, step, max, bulkEligible, bulkFrom, bulk: { min, step, max } | null },    // min/step/max = range qty is in
  hold: { expiresAt, reservedQty } | null }
```
`unavailable[]` rows have the same identity fields (`productId, variantId, sku, slug`), `bulk`, `rules`, and `hold: null`.

Cart level: a new `holdExpiresAt` (the earliest live line hold, or null), `taxableValue`, and `fees: { delivery, platform, partner, total, tax }`.

Store group (`groups[]`) always has:
```
{ tenantId, items, subtotal, couponCode, couponId, couponDiscount,
  taxableValue, tax, productTax, feeTax,
  fees: { delivery, platform, partner, total, taxableValue, tax, parts: [{ key, gross, taxableValue, tax }] },
  deliveryFee, platformFee, partnerFee, total, grandTotal /* = total */, hasDelivery, deliveryPartner, ...,
  freeDeliveryAbove, freeDelivery, freeDeliveryRemaining, codEnabled, serviceability, eta }
```
Invariant: `productTax + feeTax = tax`. The client never computes GST.

### `POST /checkout` (changed)

The response adds per-store totals in the same shape as the preview groups:
```
{ orders, idempotent, razorpay, payableOrderIds,
  groups: [{ orderId, orderNumber, tenantId, paymentMethod, subtotal, couponDiscount, taxableValue, productTax, feeTax, tax,
             fees: { delivery, platform, partner, total, taxableValue, tax, parts }, grandTotal, taxInclusive }],
  grandTotal }
```

### `GET /checkout/payment-options?addressId=` (new)

Auth: same as checkout (buyer with `orders.create`; verified email when required). `addressId` is optional. With it, the totals include delivery fees, as at checkout.
```
{ addressId, grandTotal, hasIssues,
  groups: [{ tenantId, store: { id, name, slug }, total, grandTotal,
             credit: { creditEnabled, purchaseOrderEnabled, paymentDays, spendable, available, advance, outstanding, creditLimit } | null,
             methods: [{ method, label, enabled, reason, code, requiresPoNumber }] }],
  methods: [{ method, label, enabled, reason, code, requiresPoNumber }],   // one checkout = one method for all stores (intersection)
  defaultMethod }
```
How each method is decided:
- `upi`, `card`, `netbanking`: allowed when Razorpay is configured. Otherwise `code: PAYMENT_UNAVAILABLE`.
- `cod`: allowed when both the store and the platform allow COD. Otherwise `COD_DISABLED`.
- `credit_terms` / `purchase_order`: allowed when the store enabled the term for this buyer (otherwise `TERMS_NOT_ENABLED`) and `spendable` covers the group total (otherwise `INSUFFICIENT_CREDIT`).

### `GET /ledger/me` (changed)

The response adds `stores[]`, and every `ledgers[]` row gets the same fields merged in. `tenantId` stays populated.
```
stores: [{ tenantId, store: { id, name, slug } | null, creditEnabled, purchaseOrderEnabled, paymentDays,
           creditLimit, spendable, spendablePaise, outstanding, available, advance,
           methods: ["credit_terms"?, "purchase_order"?] }]
```

### `GET /orders/:id` (changed)

The response adds two blocks:
- `totals`: the same shape as a checkout group, without the ids.
- `allowedActions`, computed with the same rules the endpoints enforce:
```
allowedActions: { cancel, return, reorder, invoice, track, pay, returnUntil, reasons: { cancel?, return?, invoice? } }
```
The rules:
- `cancel`:
  - buyer: the status is in pending, confirmed, processing or ready_to_ship, and the buyer has `orders.cancel` (or `orders.update`);
  - staff: the cancellable statuses plus the permission.
- `return`: returns are enabled, the order is delivered, no return was requested yet, it has an easy-return item, and it is inside the window.
- `reorder`: the caller is the buyer and has `orders.create`.
- `invoice`: an invoice exists, or the status is invoiceable (confirmed onwards).
- `track`: there is a live tracking number, or the status is shipped or later.
- `pay`: an online-payment order that is still pending and unpaid (`POST /checkout/pay`).

### `GET /cart/coupons` (changed)

Optional query: `tenantId` (the store being browsed). Works with an empty cart and for guests.

Stores considered:
- the stores in the cart;
- the optional `tenantId`;
- for a signed-in buyer, their `homeTenantId` and every store they have ordered from.

Only active or trial stores count.

Coupons listed:
- `status: active` and inside `startsAt`/`endsAt`;
- **public** (`visibility != "private"`) with no `customerIds`, or targeted at this buyer (`customerIds` contains them).

Never listed:
- private codes;
- coupons targeted at other buyers.
```
{ cartEmpty,
  coupons: [{ id, code, name, description, type, value, minCartValue, appliesTo, firstOrderOnly, startsAt, endsAt,
              targeted, tenantId, store: { id, name, slug } | null,
              inCart,            // the cart has items from this store
              appliesToCart,     // = eligible: would discount the current cart (previewed on that store's group only)
              eligible, savings, reason, applied, best }],
  best: <coupon row> | null }
```
Coupon model changes, also accepted by `POST/PATCH /coupons`:
- `visibility: "public"|"private"` (default `public`);
- `customerIds: ObjectId[]`. When it is non-empty, only those buyers can apply the coupon; anyone else gets `400 COUPON_NOT_ELIGIBLE`, and guests are told to log in;
- `description` (string, max 300).

### `GET /location/serviceability` (changed)

The query now also takes `approximate=true|false|1|0`. Earlier the validator stripped it; it is now passed to `checkServiceability`. With `true`, radius zones are skipped because stub-geocoded coordinates are not real positions. `latitude` and `longitude` are range-checked.

### `GET /products/:slug/serviceability?pincode=` (new)

Public. Rate limited to 30 requests per minute per IP (`429 RATE_LIMIT`, plus `RateLimit` headers). This endpoint was chosen over opening `/shipping/serviceability`, which is the Delhivery carrier PIN check and knows nothing about the store's zones, fees or the product.

Query: `pincode` (6 digits; `postalCode` is an alias), optional `latitude`, `longitude`, `approximate`. An invalid PIN code returns `400 VALIDATION_ERROR`.

It uses the same zone rules as the cart.
```
{ deliverable, reasonCode: null | "NOT_SERVICEABLE" | "PICKUP_ONLY" | "OUT_OF_STOCK", reason,
  pincode, inStock, pickupAvailable, codAvailable, freeDeliveryAbove,
  etaDaysMin, etaDaysMax, etaFrom, etaTo,     // includes the bulk lead time for bulk-eligible products
  fee,                                       // deliveryFee + partnerFee (GST-inclusive; waived above freeDeliveryAbove at checkout)
  deliveryFee, partnerFee, zone: { name } | null }
```
`OUT_OF_STOCK` comes with `deliverable: true`: the address can be served, but nothing is in stock.

### `GET /products/:slug/reviews/eligibility` (new)

Optional auth. The rule is the same as `POST /products/:slug/reviews`: a verified buyer is one with a delivered order containing the product.
```
{ canReview, reason: null | "LOGIN_REQUIRED" | "NOT_VERIFIED_BUYER", message,
  existingReview: { id, authorName, rating, body, verifiedPurchase, createdAt, updatedAt, status } | null,
  orderId | null }
```
A buyer who has already reviewed gets `canReview: true` and `existingReview`, because posting again updates the review.

### `GET /products/search` (changed)

Query:
- `q`; `tenantId` / `seller` (comma list of store ids or slugs);
- `packSize` (comma list), `minDiscount` (percent);
- `category` (slug) and/or `categoryId` (comma list). **All descendant categories are included.**
- `brand` (comma list of slugs or names) and/or `brandId` (comma list);
- `tag`, `bulkEligible=true|false`;
- `minPrice` / `maxPrice`: the buyer's effective variant price;
- `inStock=1` (alias `available=true`), `postalCode`;
- `sort=relevance|price-asc|price-desc|newest|rating|discount`. Aliases: `popular`→rating, `latest`→newest. Anything else falls back to relevance.
- `page`, `limit` (≤ 100), `facets=1`.

Invalid ids or prices return `400 VALIDATION_ERROR`.
```
{ data: [product + {
    ratingAvg, ratingCount,
    store: { id, name, slug, city },
    rules: { bulkEligible, moq, packMultiple, maxQty, bulkFrom, caseQty, leadTimeDays, min, step, max, bulk },
    price: { min, max }, minPrice, listPrice, unitPricePerBaseUnit, discountPct,
    available, inStock, stockStatus: "in_stock"|"low"|"out",
    variants: [variant + { sellingPrice, catalogSellingPrice, offer, tierPrices[{ minQty, maxQty, catalogUnitPrice, unitPrice, unitPricePerBaseUnit }],
                           unitPricePerBaseUnit, rules, available, inStock, stockStatus, lowStock, outOfStock }],
    offers }],
  meta: { total, page, limit, pages, sort, capped },
  facets?: { brands, sellers, categories: [{ id, name, slug, count }], packSizes: [{ value, count }],
            discounts: [{ min, label, count }], inStock, priceRange: { min, max } | null } }   // see part 2
```
- **Stock.** One `Inventory` aggregation per page, over the page's variants. Archived rows are excluded. `low` means available ≤ the row's `lowStockThreshold`, or ≤ 5 when no threshold is set.
- **Price filtering and sorting.** Price filters, price and discount sorts, `inStock` and facets are computed in memory over at most 1000 DB matches. `meta.capped` is `true` when that cap was hit.
- **Brand facet.** Counts apply every filter except the brand filter and the in-memory price and stock filters.
- **Price-range facet.** Covers the candidates before the price filter is applied.
- **Buyer price lists.** They apply when a bearer token is sent.

### `GET /products/lookup?slug=` (changed)

Additions:
```
{ ...previous fields,
  product: { ...product, price, minPrice, listPrice, unitPricePerBaseUnit, discountPct, available, inStock, stockStatus, rules, ratingAvg, ratingCount },
  variants: [variant + { tierPrices (slabs), unitPricePerBaseUnit, rules, available, inStock, stockStatus, lowStock, outOfStock }],
  inStock, stockStatus, rules,
  store: { id, name, displayName, slug, city, state, logo, rating, ratingCount } | null,   // rating = review-weighted avg of the store's published products
  returns: { enabled, easyReturn, returnable, returnWindowDays },
  returnWindowDays,
  delivery: { freeDeliveryAbove, freeDeliveryEnabled, defaultPartner: { id, name, fee }, partnerFee, zoneFeeMin, zoneFeeMax,
              etaDaysMin, etaDaysMax, zones: [{ name, deliveryFee, etaDaysMin, etaDaysMax }], codEnabled, feeTaxRate, feesIncludeGst,
              deliveryModes, pickupAvailable, leadTimeDays } }
```

### `GET /settings/public` (changed)

`freeDeliveryAbove` was already present at the top level. The response now also has `taxInclusive: true`, `feeTaxRate: 18`, and `delivery`. `delivery` is the same block as on the lookup, without the product fields, and its zones are filled only when a store is given.

### Email and notification links (changed)

`src/utils/links.js` builds every link from `FRONTEND_URL` (its first entry when it is a comma list):

| Link | URL |
| --- | --- |
| Verify email | `/verify-email?token=` |
| Reset password | `/reset-password?token=` |
| Unsubscribe | `/unsubscribe?token=` |
| Restock confirm | `/restock/confirm?token=` (before: the API URL whenever `PUBLIC_API_URL` was set) |
| Buyer order emails | `FRONTEND_ORDER_PATH` (default `/account/orders`) + `/:id`; before: `/orders/:id` |
| Store-staff order emails | `FRONTEND_STAFF_ORDER_PATH` (default `/tenant/orders`) + `/:id` |
| Restock product link | `FRONTEND_PRODUCT_PATH` (default `/product`) + `/:slug` |

### Engine helpers (`pricing/engine.js`, new)

| Helper | What it does |
| --- | --- |
| `qtyRules(product, variant?, qty?)` | Quantity rules for a line |
| `isBulkQty(product, qty)` | Whether `qty` is a bulk purchase of this product |
| `parsePackSize("2 x 500 ml")` | → `{ qty: 1, unit: "L" }` |
| `pricePerBaseUnit(price, packSize)` | Price per kg, L, pc or m |
| `slabProgress(slabs, qty, unitPrice)` | `appliedSlab` and `nextSlab` |
| `packOf(variant)` | The variant's pack size |

`calculateLinePrice` has a new `applySlabs` option.

### Tests

The existing suites were run against `msp_test_sf`, and their DB-name guards were widened to accept it: authPlatform (`msp_test_(b|sf)`), catalogFixes and catalogHttp (`msp_test_(c|be2|sf)`), platformFixes (`msp_test_(be2|sf)`). `catalogFixes` had a test bug, fixed here: it inserted raw orders without an `orderNumber`, which broke the unique index on a fresh DB.

### Storefront support, part 2

Tests: `src/tests/storefront2.js` (69 checks). The suites `storefront`, `catalogFixes`, `catalogHttp` and `platformFixes` were re-run against `msp_test_sf2` and pass; their DB-name guards now also accept `msp_test_sf2`. No new env vars.

#### Delivery partner name mojibake (fixed)

- **Cause.** The default partner name "MS₹ Delivery" was showing up double-encoded as "MSâ‚¹ Delivery": UTF-8 bytes read as Windows-1252 and then saved again. The literal in `src/modules/settings/defaults.js` is now `"MS\u20B9 Delivery"` (exported as `DEFAULT_PARTNER_NAME`). Because it is an escape, an editor or shell with a non-UTF-8 code page cannot corrupt it again.
- **Read-time guard.** `normalizePartners()` repairs garbled names, so `GET /settings/public`, `GET /products/lookup` and the cart all return the correct name even before the migration has run.
- **Stored data.** On every start (`RUN_MIGRATIONS`), `runStorefrontMigrations()` in `src/seeds/migrations.js` does two things. It deep-repairs every `Settings` value (any key, any scope), and it repairs `Order.deliveryPartner.name` snapshots.
- **What the repair touches.** It is idempotent. It only touches strings that contain the mojibake markers, and it keeps a fix only if the result decodes as valid UTF-8. Hindi text, "₹" and accents are never changed.
- **Helper.** The logic lives in `src/utils/mojibake.js`: `repairMojibake`, `repairDeep`, `hasMojibake`, `MOJIBAKE_MARKER` and `MOJIBAKE_MARKER_DB` (the last is safe to use in a MongoDB `$regex`).

#### Store card on cart, checkout and payment groups (changed)

The following now carry `store: { id, name, displayName, slug, city, logo } | null`:
- `groups[]` of `GET /cart`, of every cart mutation, and of `POST /checkout/preview`;
- `groups[]` of `GET /checkout/payment-options`, which was `{ id, name, slug }` before;
- `groups[]` of `POST /checkout`.

Field sources:
- `displayName` is the store setting `store.displayName`, or the store name when that is not set.
- `city` is `pickupAddress.city`.
- `logo` is `branding.logo`.

Each request makes two batched queries (`src/modules/tenants/storeCard.js`).

#### `GET /products/search` (changed)

New query parameters:
- `seller` and/or `tenantId`: a comma list of store **ids or slugs** (`tenantId` used to take a single id). Only active and trial stores match, and an unknown store returns no results. `postalCode` now also narrows a seller-filtered search.
- `packSize`: a comma list matched against the variant's `attributes.packSize` (or `size`). Case, spaces and `x`/`×` are ignored, so `5kg` matches `5 KG`. Only matching variants are returned, and the price and stock summary follows them.
- `minDiscount`: a percentage from 0 to 100, compared with the product's best variant discount (`discountPct`). Anything else is `400 VALIDATION_ERROR`.

With `facets=1`:
```
facets: { brands:     [{ id, name, slug, count }],
          sellers:    [{ id, name, slug, count }],
          categories: [{ id, name, slug, count }],
          packSizes:  [{ value, count }],                     // one count per product
          discounts:  [{ min: 10|20|30|40|50, label: "10% or more", count }],
          inStock:    number,
          priceRange: { min, max } | null }
```
How the counts are computed:
- **`brands`, `sellers`, `categories`.** One DB aggregation each. Every filter applies except the facet's own, and except `packSize`, price, `minDiscount` and stock. Example: picking a seller still lists the other sellers. A category count is per product category and is not rolled up.
- **`packSizes`.** Counted over the candidates before the pack filter, after the price filter.
- **`discounts`.** Counted before the `minDiscount` filter.
- **`inStock`.** Counted before the stock filter.
- **`priceRange`.** Unchanged: counted before the price filter.

`packSizes`, `discounts`, `inStock` and `priceRange` are computed in memory over at most 1000 matches (`meta.capped`). `packSize`, `minDiscount` and `facets` switch the search to in-memory mode. Without facets, `packSize` is also pre-filtered in the DB with one `distinct` query.

#### `GET /settings/public` without a store: platform delivery estimate (changed)

`delivery.etaDaysMin` / `delivery.etaDaysMax` were `null` when no store was given. They now always have a value, and `delivery.etaSource` says where it came from:
1. `"setting"`: the new platform setting `delivery.etaDays = { etaDaysMin, etaDaysMax }`. Integers from 0 to 60, with min ≤ max. It is public, and an admin edits it with `PUT /settings/delivery.etaDays`.
2. `"stores"`: when that setting is not stored, an aggregate over the delivery zones of active and trial stores. Min = the fastest zone minimum; max = the median zone maximum. Cached for 5 minutes.
3. `"default"`: when no store has zones, the registry default `{ etaDaysMin: 2, etaDaysMax: 7 }`.

When a store is given, `etaSource` is `"zones"`, or `"store_default"` for a store without zones (3 to 7 days, as before).

#### `GET /location/pincode/:pin` (new)

Public. Rate limited to 30 requests per minute per IP (`429 RATE_LIMIT`). `pin` must be 6 digits and must not start with 0; otherwise `400 VALIDATION_ERROR`.
```
{ pincode, city, district, state, stateCode, approximate, found, source: "google" | "prefix" }
```
Where the answer comes from:
- **Google geocoding.** Used when the maps provider is configured (`platform.mapsProvider = "google"` and `MAPS_API_KEY`). It queries `components=postal_code:<pin>|country:IN` and returns `approximate: false`.
- **Bundled table.** Used otherwise, or when Google fails. It has no new dataset: the state or UT comes from the postal circle (the first 2–3 digits of the PIN), and `city`/`district` are filled only for about 40 known metro sorting districts (`400` → Mumbai, `560` → Bengaluru, …). Results from this table are always `approximate: true`.

Other fields:
- `stateCode` is the ISO 3166-2:IN code without the `IN-` prefix (`MH`, `DL`, `KA`, `TG`, …).
- An unknown circle (for example the Army postal `9xxxxx`) returns `found: false` with null fields.
- Results are cached in memory for 24 hours (up to 2000 PINs).

Code: `src/modules/location/pincode.js`.

#### Default CMS policy pages (new seed)

The global pages `grievance`, `terms`, `privacy`, `refunds`, `shipping` and `about` are created when missing.

- **When.** On every start (in `runStorefrontMigrations`) and in `seedFoundation` (`npm run seed`).
- **Status.** They are created `published`, so footer links resolve.
- **Content.** Placeholder text marked "[To be completed by the marketplace operator: …]", with fields such as `[Grievance officer name]`, `[Designation]`, `[grievance@your-domain]`, `[Phone number]` and `[Registered office address]`. Every bracket must be replaced before launch: a grievance officer is required by the Consumer Protection (E-Commerce) Rules, 2020.
- **Insert-only.** Pages are created with `$setOnInsert` on the unique `{ tenantId, slug }`, so an existing or edited page is never overwritten. A deleted page is re-created on the next start, so unpublish a page to hide it.
- **Demo data.** The demo seed still overwrites its own global `terms`, `privacy` and `shipping` pages.

Code: `src/seeds/cmsDefaults.js`.

#### Buyer restock alerts (new)

`GET /products/restock-alerts/mine`
- Auth: Bearer.
- Query: `page`, `limit` (≤ 100), `status=active|pending_confirmation|notified`.
- Which alerts are listed: the caller's signed-in alerts, plus guest alerts for the caller's email when that email is verified. Newest first.
```
{ data: [{ id, status: "active"|"pending_confirmation"|"notified", productId, variantId, tenantId, createdAt, notifiedAt,
           channel: "account"|"email",
           product: { id, name, slug, sku, image, available } | null,
           variant: { id, sku, packSize, attributes, sellingPrice, listPrice, active } | null,   // null = any variant
           inStock }],                                                                           // current stock (variant, or any variant)
  meta: { total, page, limit, pages } }
```

`DELETE /products/restock-alerts/:id`
- Auth: Bearer.
- Unsubscribes and returns `{ ok, id, deleted: true }`.
- An alert that is not the caller's (or that does not exist) returns `404 NOT_FOUND`. An invalid id returns `400`.

### Storefront support, part 3

Tests: `src/tests/storefront3.js` (91 checks). The suites `storefront`, `storefront2`, `catalogFixes`, `catalogHttp`, `platformFixes` and `commerceHttp` were re-run against `msp_test_sf3` and pass. Guards in catalogFixes, catalogHttp and platformFixes now also accept `msp_test_sf3`. Test fixes made here:
- `storefront2` now expects the new default `help` page.
- `catalogFixes` and `catalogHttp` had a race. Their `init()` call could resolve before the DB drop, so the product text index went missing and they failed intermittently with "text index required". Both now call `syncIndexes()` after the drop.

No new env vars. The new migrations run on every start (`RUN_MIGRATIONS`, in `runStorefrontMigrations`) and are idempotent.

#### `GET /products/search`: typo-tolerant (changed)

The search runs in three steps:
1. **Text search, as before.** `$text` handles exact and stemmed words. When it finds nothing, an escaped substring regex runs. Queries of 1–2 characters use the prefix regex.
2. **Fallback trigger.** The fallback runs when the steps above find **fewer than 3** products. It only replaces the result when it finds more products. The fallback query always includes the original words, so its result is a superset ranked by text score, and exact matches still rank first.
   1. **Synonyms.** A small map of common Indian grocery transliterations and translations, for example aata/atta/flour, chawal/rice, daal/dal/lentil, ghee/ghi, haldi/turmeric, mirchi/chilli, chai/tea, sabun/soap, namak/salt, cheeni/sugar, jeera/cumin and sooji/rava/semolina. The full list is `SYNONYM_GROUPS` in `src/modules/search/fuzzy.js`.
   2. **Fuzzy matching.** Each unknown query word is corrected against a cached **term dictionary**. The dictionary holds the words of published product names and tags (active and trial stores), brand names, category names and the synonym spellings.
      - Candidates are found by trigram overlap, at most 60 per word.
      - Each candidate is scored by a bounded Damerau-Levenshtein distance. Words of 3–4 characters allow 1 edit, up to 8 characters allow 2, and longer words allow 3.
      - Ties go to the more frequent catalogue word.
      - Words that contain digits (pack sizes, SKUs) are never corrected.
      - The fallback tries `$text` on the expanded words first. When that finds nothing, it runs a word-start regex on name and tags, plus brand and category name matches, so a misspelt brand finds that brand's products.
3. **Bounds.** At most 6 query words of up to 30 characters each, and at most a handful of `countDocuments` calls per search. The dictionary is capped at 50k products and 50k terms. It is rebuilt (single-flight) after 10 minutes, or after a catalogue change once the last build is more than 30 seconds old. Product, Brand and Category write hooks bump an in-process catalogue version (`src/modules/search/catalogVersion.js`). Other instances pick the change up through the TTL.

New `meta` fields (also present on early empty results):
```
meta: { ..., matchedBy: "text" | "synonym" | "fuzzy" | null,   // null = no q
        didYouMean: string | null }                            // e.g. "aata" → "atta", "basmatti" → "basmati",
                                                               // "turmric powdr" → "turmeric powder"
```
`didYouMean` is `null` when nothing was corrected. For example, `atta` widened by its synonyms still has no suggestion, because the catalogue uses that word.

#### `GET /tenants/public` (new)

Public store directory. No auth. Rate limited to 60 requests per minute per IP (`429 RATE_LIMIT`, plus `RateLimit` headers).

Only active and trial stores are listed. Query parameters:
- `q`: matches the name or slug;
- `city`, `state`: exact match, case-insensitive;
- `sort=name|newest|rating|products` (default `name`);
- `page`, `limit` (≤ 100).
```
{ data: [{ id, name, displayName, slug, city, state, logo,
           rating,            // review-weighted average of its published products; null without reviews
           ratingCount, productCount,
           deliveryModes,     // union over its published products: "store_pickup" | "delivery_partner"
           minOrderValue }],  // orderRules.minOrderValue (0 = none)
  meta: { total, page, limit, pages, sort } }
```
Each page runs one aggregation over the published products. `rating` and `products` sort in memory over at most 2000 stores. `GET /tenants/public/:idOrSlug` is unchanged.

#### `GET /wishlist`, `PUT /wishlist` (changed)

Prices are now the buyer's effective prices, the same as in search and on the product page:
1. the buyer's customer price list, or else the store's default list;
2. then the best live offer.

`PUT` responds with the same priced row.

Row:
```
{ id, slug, productId, variantId, tenantId, name, image, sku,
  price,          // effective price (was the raw catalogue sellingPrice)
  listPrice, catalogPrice /* catalogue sellingPrice */, discountPct, offer, unitPricePerBaseUnit,
  packSize, available, savedAt }
```

#### Order line items: `slug` and `image` (changed)

- **At checkout.** Checkout already copied the product's public `slug` and first image onto each line. Demo-seed orders now do too.
- **Existing orders.** `backfillOrderItemSnapshots()` in `src/seeds/migrations.js` fills lines that still need it: no slug, `""` or the legacy lower-cased-SKU slug, or no `image` field. It looks the products up in batches of 200 orders, at most 50k per run.
- **Deleted products.** A line whose product no longer exists gets `slug: null` and keeps (or gets) an empty image, so the migration does not visit it again.
- **Where they appear.** Line items in `GET /orders`, `GET /orders/:id` and the reorder response carry `slug: string | null` and `image`.

#### `GET /orders` rows: `allowedActions` (changed)

Every row now has `allowedActions` and `returnUntil`. They are computed with the same function as `GET /orders/:id` (one commerce-settings read per page), so the list needs no detail fetch per row:
```
allowedActions: { cancel, return, reorder, invoice, track, pay, returnUntil, reasons }
```

#### `POST /orders/:id/reorder` (changed)

The reorder no longer fails outright when an old quantity breaks the current rules. Before, the seeded order `MSR10231` failed with "Quantity must be a multiple of 5".

How each line's quantity is set: the target is the cart line's current qty plus the ordered qty.
- **Bulk range.** It is rounded **up** to the pack multiple and capped at the per-order max (minus the product's other bulk lines).
- **Stock.** It is capped at the free stock and rounded down to a valid quantity. Below the bulk range, that is a plain regular quantity.

Lines that cannot be added are skipped with a reason. An error is returned only when nothing at all could be added.
```
{ ...cart quote,
  added:    [{ itemId, productId, variantId, name, slug, qty /* units added */, cartQty /* line total now */ }],
  adjusted: [{ itemId, productId, variantId, name, orderedQty, qty, reason }],   // e.g. "Rounded to a multiple of 5", "Only 3 in stock"
  skipped:  [{ itemId, productId, variantId, name, qty, reason, code }] }       // code: UNAVAILABLE | OUT_OF_STOCK | MAX_QTY | <cart error code>
```
When nothing is addable, the response is `409 REORDER_UNAVAILABLE` with `{ message, code, added: [], adjusted: [], skipped }`. The helper is `reorderQty(rules, { desired, existing, otherBulk, stock })` in `orders/service.js`.

#### `GET /orders/:id/credit-notes/:noteId.pdf` (new)

Permission `orders.view`. Same access rule as the order: a buyer can open only their own orders, and staff only their store's.

- `noteId`: the credit note's id or its number.
- Returns `application/pdf` as an attachment named `<creditNoteNumber>.pdf`. The PDF uses the invoice generator with the title "CREDIT NOTE".
- An unknown note returns `404`.

#### `POST /auth/register`, `PATCH /auth/me`, `GET /auth/me`: business type and GSTIN (changed)

- **`businessType`** (optional): one of `kirana | horeca | distributor | institution | other`. Case is ignored. The aliases `retailer` → `kirana` and `restaurant`/`hotel` → `horeca` are accepted.
- **`gstin`** (optional): validated for format, state code (01–38) and the **mod-36 check digit**. It is stored upper-case. An invalid value returns `400 VALIDATION_ERROR` with `fields.gstin`.
- **Storage.** Both are stored on `profile` (`profile.businessType`, `profile.gstin`).
- **`PATCH /auth/me`.** Accepts them at the top level or inside `profile`. `""` clears the GSTIN.
- **Responses.** The public user returns them both inside `profile` and at the top level (`businessType`, `gstin`).
- **Other profile writes.** The same validation now applies to `profile.gstin` on admin user create and update, because they share `profileSchema`.

Helper: `src/utils/gstin.js` (`normalizeGstin`, `isValidGstin`, `gstinCheckChar`).

#### `GET /ledger/me`: paginated entries (changed)

Before, entries were capped at the 20 newest. Query parameters:
- `page`, `limit` (≤ 100; defaults 1 and 20);
- **or** `before`: an entry id, or an ISO date, for entries strictly older than it. `page` is ignored when `before` is given.

A bad cursor returns `400`.
```
{ ...as before, entries: [...newest first], entriesMeta: { total, page /* null with before */, limit, pages, hasMore, nextBefore /* id or null */ } }
```

#### Addresses: normalised `state` plus `stateCode` (changed)

- **On write.** `POST` and `PATCH /addresses` (and any `Address` save) normalise `state` to the full state or UT name and set `stateCode`, the ISO 3166-2:IN code without `IN-`.
- **Accepted input.** Codes (`DL`, `dl`, `IN-DL`), names in any case (`delhi`), and common aliases: `New Delhi`/`NCT of Delhi` → Delhi, `Orissa` → Odisha, `Pondicherry` → Puducherry, `TS` → Telangana, `UA`/`Uttaranchal` → Uttarakhand, `CG` → Chhattisgarh, `J&K`, and so on.
- **Unknown input.** It is kept as typed, with `stateCode: null`.
- **Existing data.** `normalizeAddressStates()` (in `runStorefrontMigrations`) updates addresses that have no `stateCode` field, so it is idempotent.

Address rows: `{ ..., state: "Delhi", stateCode: "DL" | null }`. Helper: `normalizeIndianState()` in `src/modules/location/pincode.js`.

#### Default CMS content: accurate, templated, seed-hashed (changed)

**What was wrong.** The demo seed's global `help`, `shipping` and `returns` pages contradicted the backend:
- they said refunds always go "to the original payment method";
- they gave the support email as `support@msrmarket.local`;
- they promised "1–3 day" delivery.

**The fixed content.** It now lives in `src/seeds/cmsDefaults.js` and is shared by the demo seed.

Refund destinations, as implemented in `orders/lifecycle.js`, `checkout/refunds.js` and the ledger:

| Payment method | Where the refund goes |
| --- | --- |
| UPI, card or netbanking (Razorpay) | The original payment method |
| Purchase order or credit terms | The ledger debit is reversed, as a credit to the buyer's account with the store. It is not paid out to a bank. |
| COD | Nothing is collected before delivery. A cancelled COD order needs no refund. A delivered COD order has no automatic refund, so the store settles it with the buyer directly. |

**Settings tokens.** Facts that come from settings are written as tokens. `GET /cms/pages/:slug` fills them at render time (`src/modules/cms/render.js`). The admin API returns the raw tokens.

| Token | Value |
| --- | --- |
| `{{supportEmail}}` | `platform.supportEmail`, then `SUPPORT_EMAIL`, then "our support team" |
| `{{platformName}}` | `platform.name` |
| `{{etaDays}}`, `{{etaDaysMin}}`, `{{etaDaysMax}}` | With a store: its zones. Without a store: `delivery.etaDays`, then the platform estimate. The same values as `GET /settings/public` `delivery`. |
| `{{returnWindowDays}}` | `returns.windowDays` |

Unknown tokens are left as they are.

**Default pages.** A global `help` page (FAQ) was added. `refunds`, `shipping` and `about` now have real or templated text. The legal pages (grievance, terms, privacy) remain bracketed placeholders.

**Seed hash.** Seeded pages store `seedHash` (a hash of the `{ title, sections }` the seed wrote) and `seedSource` (`"defaults"` or `"demo"`). `upsertSeedPage()` decides what to do with each page:

| Page state | What happens |
| --- | --- |
| Missing | Inserted, published |
| Content still hashes to its `seedHash`, same seed source | Updated to the new seed content. Its status is kept and `version` is bumped. |
| No `seedHash`, but content equals a known older seed version (`LEGACY_*`) or the new content | Updated (this is how existing DBs get the corrected help, returns and refunds text) |
| Anything else (edited by an admin, or admin-authored) | **Never overwritten** |

- **Demo seed.** It now goes through the same function. It no longer `$set`s unconditionally. It may take over unedited `defaults` pages, and the default seed then leaves them alone, so the two seeds do not flip-flop. Its store `shipping` page uses `{{etaDays}}` (the store's zones) instead of "Delhi NCR 1–3 days".
- **Seed fields stay private.** `seedHash` and `seedSource` are not returned by the public endpoint.
- **Return value.** `ensureDefaultCmsPages({ details: true })` returns `{ created, updated }`. Without `details` it still returns `created[]`. `runStorefrontMigrations()` also reports `cmsUpdated`, `orderItemsBackfilled` and `addressesNormalized`.

#### CMS slug alias: `returns` ↔ `refunds` (new)

`GET /cms/pages/returns` resolves as follows:
- When a `returns` page exists (store page first, then global), it is served as it is.
- Otherwise the `refunds` page is served, with `requestedSlug: "returns"` and `aliasOf: "refunds"`, so the client can redirect to the canonical URL.

The reverse alias (`refunds` → `returns`) also applies. The default seed never creates `returns`. It only updates an unedited old demo `returns` page to the refunds content.
