# MS₹ Market — General customer features & modules

This document describes **everything a general customer (shopper / buyer) can do** in the storefront (`mspReact` shop) and the **`mspNode` modules** that power it.

It does **not** cover the seller (`/tenant`) or company (`/super-admin`) panels.

---

## Who this is for

| Persona | How they use the shop |
| --- | --- |
| **Guest** | Browse, search, add to cart, save wishlist locally. Must sign in to check out. |
| **Buyer (registered customer)** | Full shopping account: profile, addresses, coupons, orders, support chat. |
| **Retail / bulk buyer** | Same shop, plus bulk page, GST invoices, quantity slabs, optional purchase order at checkout (business roles only). |

Customers shop on routes that are **not** `/tenant` or `/super-admin`. Checkout requires a signed-in buyer.

---

## Storefront at a glance

MS₹ Market is an FMCG marketplace for homes, kiranas, HORECA and offices. The shop promises:

- Genuine brand packs
- GST invoice on every order
- 1–3 day delivery in metro pincodes
- 7-day returns on unused, sealed packs
- UPI, cards, net banking, cash on delivery

**Payment methods (buyer):** UPI · Card · Net banking · Cash on delivery  
**Business checkout only:** Purchase order

---

## React shop modules (`mspReact`)

Shop UI lives under `mspReact/src/shop`. Shared customer state lives under `mspReact/src/shared`.

| Module | Files | What the customer gets |
| --- | --- | --- |
| **Shop shell** | `layouts/ShopLayout.jsx`, `components/Header.jsx`, `Footer.jsx`, `MobileNav.jsx` | Sticky header, category menu, search, location, cart/wishlist badges, footer help links, mobile bottom nav (Home / Shop / Cart / Account). |
| **Home** | `pages/Home.jsx`, `components/Hero.jsx` | Hero carousel, trust strip, shop-by-category, today's deals, bestsellers, shop-by-brand, bulk CTA. |
| **Catalog browse** | `pages/Category.jsx`, `components/ProductCard.jsx` | Category/search listing with filters, sort, infinite scroll, add-to-cart from the card. |
| **Product** | `pages/ProductDetails.jsx`, `components/SaleBadges.jsx` | Gallery, pack sizes, qty, price/MRP/offers, wishlist, add to cart / buy now, specs, reviews summary, related products. |
| **Collections** | `pages/Deals.jsx`, `NewLaunches.jsx`, `Brands.jsx`, `BulkBuy.jsx`, `components/TaggedProductGrid.jsx` | Deals, new launches, brand directory, wholesale / bulk landing. |
| **Cart** | `pages/Cart.jsx`, `shared/context/CartContext.jsx` | Line items, qty, coupons (best auto-applied), delivery address, order summary. Guest cart works; checkout needs sign-in. |
| **Checkout & confirmation** | `pages/Checkout.jsx`, `OrderConfirmation.jsx` | Address, payment, notes, GST invoice promise, order placed + ETA. |
| **Account drawer** | `components/AccountModal.jsx`, `shared/context/AccountDrawerContext.jsx` | Overlay account hub: profile, orders, addresses, coupons, wishlist, support, help. |
| **Auth** | `components/AuthModal.jsx`, `pages/Login.jsx`, `Register.jsx` | Modal sign-in / create account over the current shop page. |
| **Account pages** | `pages/Account.jsx`, `Orders.jsx`, `Addresses.jsx`, `Coupons.jsx`, `Wishlist.jsx` | Profile, password, order list, saved addresses, bag coupons, saved items. |
| **Help & legal** | `pages/Help.jsx`, `Legal.jsx`, `Support.jsx` | CMS-backed help (shipping, returns, FAQs), privacy/terms, live support inbox. |
| **Catalog state** | `shared/context/ShopCatalogContext.jsx` | Loads live categories, products, and public brands from the API. |
| **Auth / location** | `shared/context/AuthContext.jsx`, `LocationContext.jsx` | Session, guest→user cart merge, delivery city/PIN. |
| **API client** | `shared/api.js` | Talks to `/api/v1/*` with Bearer token or `X-Guest-Key`. |

---

## Node modules used by customers (`mspNode`)

Only the APIs the shop actually calls are listed. Staff-only routes in the same module are omitted.

| Node module | Customer job |
| --- | --- |
| **auth** | Register buyer, login, session (`/me`), update profile, change password. |
| **catalog** | Public categories, public brands, product search, product lookup by slug/pack. Live offers are attached to variants. |
| **pricing** | Selling vs MRP, customer price lists, quantity tiers, active offers, coupon eligibility and discount. |
| **cart** | Guest or user cart, add/update/remove items, quote (tax, delivery, coupon), list coupons, merge guest cart on login. |
| **checkout** | Preview totals for an address, place order (idempotent), split cart into one order per seller, reserve stock. |
| **orders** | List / get the buyer's own orders; status filter; optional reorder. |
| **location** | Save “deliver to” city/PIN on the user profile; pincode serviceability and ETA at checkout. |
| **addresses** | CRUD for home/shop delivery points; default address. |
| **inventory** | Used during quote and checkout (warehouse pick, stock check, reserve). Customer never calls inventory APIs directly. |
| **cms** | Published pages: `help`, `shipping`, `returns`, `privacy`, `terms`. |
| **chat** | Start a support thread, list conversations, send/read messages. |
| **notifications** | Order and chat events persisted for the buyer (API exists; shop UI does not yet show an inbox). |
| **sockets** | Real-time chat rooms and notification push for signed-in users. |

---

## Shop routes

| Path | Screen | Sign-in required |
| --- | --- | --- |
| `/` | Home | No |
| `/category/:slug` | Category / search (`?q=`, `?tag=`, `?brand=`) | No |
| `/product/:id` | Product details (id is product SKU slug) | No |
| `/deals` | Live deals (`tag=deal`) | No |
| `/new` | New launches (`tag=new`) | No |
| `/brands` | Brand directory + bestsellers | No |
| `/bulk` | Bulk / wholesale landing | No |
| `/cart` | Shopping cart | No (checkout CTA needs account) |
| `/checkout` | Checkout | **Yes** |
| `/order/:id` | Order confirmation / details | Yes to load from API |
| `/login` · `/register` | Auth modal over last shop page | — |
| `/account` | Profile | Yes (drawer still opens for guests) |
| `/account/orders` · `/orders` | Order history | Yes |
| `/account/addresses` | Saved addresses | Yes |
| `/account/coupons` | Coupons for current bag | Yes |
| `/account/wishlist` · `/wishlist` | Wishlist | No (stored in browser) |
| `/account/support` | Support inbox | Yes |
| `/account/help` · `/help` | Help centre | No |
| `/legal` | Privacy & terms | No |

---

## Features by journey

### 1. Discover & browse

**UI:** Header, home, category, deals, new, brands, bulk.

- **Search** — header search submits to `/category/all?q=…` (products and brands).
- **Categories** — live categories from `GET /api/v1/categories`. Fallback names include Staples, Beverages, Snacks, Personal Care, Home Care, Baby Care, Health & Wellness, Dairy & Bakery.
- **Shop by brand** — public brands from `GET /api/v1/brands/public`; tap filters the catalog (`?brand=`).
- **Deals / New / Bestsellers** — search with `tag=deal`, `tag=new`, `tag=bestseller`.
- **Bulk buying** — landing for kirana / HORECA / offices; case packs, MOQ slabs, GST billing, register CTA.
- **Hero** — rotating slides (everyday grocery + featured deal).
- **Trust** — GST invoice, 1–3 day metro delivery, original packs.

**APIs**

```
GET /api/v1/categories
GET /api/v1/brands/public
GET /api/v1/products/search?category=&q=&tag=&brand=&maxPrice=&sort=&postalCode=&page=&limit=
```

Search is location-aware: when a PIN is set, only products from **serviceable tenants** are returned.

---

### 2. Product details

**UI:** `/product/:id`

- Breadcrumb: Home → category → product
- Image gallery + sale / deal / new / bestseller badges
- Brand, name, star rating, review count, stock hint (In stock / Limited stock)
- Selling price, MRP, % off, GST-inclusive note
- **Pack size** selector (each pack is a variant)
- Quantity stepper and line total
- Add to cart, Buy now, Wishlist
- Available offers (percent or ₹ off), `WELCOME10`, free delivery above ₹999, extra bulk discount on 10+ units
- About, specifications, ingredients, nutrition (accordions)
- Review score bars
- Related products in the same category
- Sticky add-to-cart bar on mobile

**API:** `GET /api/v1/products/lookup?slug=&pack=`  
Lookup returns the published product, variants with offer-adjusted prices, and live offers.

---

### 3. Filters, sort, infinite scroll

On category/search:

| Control | Options |
| --- | --- |
| Category chips | All + live categories |
| Brand | Multi-select from public brands |
| Price | Under ₹200 / ₹400 / ₹800 |
| Sort | Popular · Price low→high · Price high→low |
| Load more | Intersection observer, 12 products per page |

Empty state lets the customer reset filters. PIN changes reload the feed.

---

### 4. Delivery location

**UI:** Header “Deliver to” (desktop) and mobile menu.

- Preset cities: Mumbai `400001`, Delhi `110001`, Bengaluru `560001`, Pune `411001`, Hyderabad `500001`
- Custom PIN (4+ digits)
- Saved in `localStorage`; signed-in users also persist via `PUT /api/v1/location/me`
- Used for catalog serviceability and checkout delivery fee / ETA

**Related APIs (available, used at checkout):**

```
GET  /api/v1/location/suggest
GET  /api/v1/location/serviceability?tenantId=&postalCode=
PUT  /api/v1/location/me
```

If an address is not in a seller’s delivery zone, checkout fails with **delivery not available**.

---

### 5. Cart (guest + signed-in)

**UI:** `/cart`, header/mobile cart badge.

Guests get a stable `X-Guest-Key` in local storage. After login, `POST /api/v1/cart/merge` folds the guest bag into the buyer cart.

| Capability | Guest | Signed in |
| --- | --- | --- |
| Add / change qty / remove | Yes | Yes |
| Live quote (tax, coupon, delivery) | Yes | Yes |
| Apply coupon / see all coupons | No (prompted to sign in) | Yes |
| Choose / add delivery address | No | Yes |
| Checkout | Sign-in first | Yes |
| Offline fallback | Local cart if API is down | Same |

Cart quote includes:

- Per-line list price, selling price, tax
- **Best coupon auto-applied** unless the customer picks another
- Delivery fee (₹0 above ₹999 in the local fallback; live fee comes from the seller zone)
- GST / tax and grand total
- Multi-seller groups (one order per tenant at checkout)

**APIs**

```
GET    /api/v1/cart
POST   /api/v1/cart/items          { variantId, qty }
PATCH  /api/v1/cart/items/:id      { qty }
DELETE /api/v1/cart/items/:id
POST   /api/v1/cart/coupon         { code }
GET    /api/v1/cart/coupons
POST   /api/v1/cart/merge          (after login)
```

Pricing behind the quote: customer-specific **price list**, **tier / wholesale qty** prices, **offers**, then **coupon**. Insufficient stock or unpublished SKUs are rejected.

---

### 6. Coupons & offers

**UI:** Cart coupon field + “See all”, `/account/coupons`, product “Available offers”.

Each coupon row shows code, name, min cart value, savings, **Eligible** vs **Locked** (with reason). The best eligible code is highlighted.

Offer types shown on products: percent off, flat ₹ off, flash / price-drop badges.

**APIs:** cart coupon endpoints above. Offers are embedded in search/lookup responses from **pricing**.

---

### 7. Checkout & payment

**UI:** `/checkout` (protected). Empty cart redirects to browse.

1. Select or add a delivery address  
2. Preview totals for that address (`POST /api/v1/checkout/preview`)  
3. Choose payment: UPI, Card, Net banking, COD (plus Purchase order for tenant/super-admin shopping as a customer)  
4. Optional delivery notes / PO number  
5. Place order with an **Idempotency-Key** so double-submit does not create duplicates  

Checkout:

- Validates serviceability and stock
- **Reserves inventory**
- Creates **one order per seller** in the bag
- Snapshots the address
- Records coupon, tax, delivery, ETA window
- Clears the cart after success
- Navigates to `/order/:id`

**APIs**

```
POST /api/v1/checkout/preview   { addressId }
POST /api/v1/checkout           { addressId, paymentMethod, poNumber, buyerNotes }
     Header: Idempotency-Key
```

Requires permission `orders.create` (buyer role).

---

### 8. Orders

**UI:** `/account/orders`, `/orders`, `/order/:id`

- List with thumbnails, item count, date, total, status badge
- Filter: pending, confirmed, processing, shipped, delivered, cancelled
- Confirmation page: items, payment method, ETA, delivery address, GST note
- Empty state → start shopping

**Statuses the platform tracks** (shop filter shows a subset):  
pending → confirmed → processing → ready_to_ship → shipped → out_for_delivery → delivered  
also cancelled, return_requested, refunded

**APIs**

```
GET /api/v1/orders?limit=&status=
GET /api/v1/orders/:id
POST /api/v1/orders/:id/reorder    (API available; shop UI does not expose a reorder button yet)
```

Buyers only see **their own** orders.

---

### 9. Account, profile, addresses

**Account drawer tabs:** Profile · Orders · Addresses · Coupons · Wishlist · Support · Help

**Profile (`/account`)**

- Name, email (read-only), phone
- Change password (current + new, min 8 characters)
- Sign out
- Role label (`buyer`)

**Addresses (`/account/addresses`)** — also addable from cart/checkout

- Label, contact name, phone, street, city, state, PIN
- Default flag on first address
- Edit / remove

**APIs**

```
GET   /api/v1/auth/me
PATCH /api/v1/auth/me                 { name, phone }
POST  /api/v1/auth/change-password    { currentPassword, newPassword }

GET    /api/v1/addresses
POST   /api/v1/addresses
PATCH  /api/v1/addresses/:id
DELETE /api/v1/addresses/:id
```

---

### 10. Register & sign in

**UI:** `/login` and `/register` as a modal over the last shop page (Escape / backdrop closes).

| Action | Fields | Backend |
| --- | --- | --- |
| Create account | Full name, email, password (min 8) | `POST /api/v1/auth/register` as **buyer** |
| Sign in | Email, password | `POST /api/v1/auth/login` (rate limited, lockout after failed attempts) |
| After login | Merge guest cart, return to previous page or checkout | `POST /api/v1/cart/merge` |

Auth also supports refresh, logout, forgot/reset password on the API; the shop UI currently uses login, register, me, update me, and change password.

---

### 11. Wishlist

**UI:** `/wishlist`, heart on product cards and PDP, header badge.

- Toggle save / unsave (no account required)
- Stored in browser (`localStorage`)
- Missing items loaded via product lookup
- Clear all
- Add to cart from the card as usual

Not synced to the server.

---

### 12. Help, legal, support chat

**Help centre (`/help`)** — CMS with fallbacks

| Section | Content |
| --- | --- |
| FAQs | From CMS page `help` (`kind: faq`) |
| Shipping | Metro 1–3 days; bulk may ship from nearest warehouse |
| Returns | Unused sealed packs, 7 days, refund to original method |
| Contact | `support@msrmarket.local` · Mon–Sat 9am–7pm · start a chat if signed in |

**Legal (`/legal`)** — privacy, terms (CMS `privacy` / `terms`), seller rules note.

**Support inbox (`/account/support`)**

- New conversation (subject + message)
- Thread list with status: Open / In progress / Waiting on you / Closed
- Reply in an open thread
- Mark as read

**APIs**

```
GET  /api/v1/cms/pages/:slug          help | shipping | returns | privacy | terms
POST /api/v1/chat                     { subject, message }
GET  /api/v1/chat
GET  /api/v1/chat/:id/messages
POST /api/v1/chat/:id/messages        { body }
POST /api/v1/chat/:id/read
```

Chat is rate-limited. Real-time updates use Socket.IO rooms `user:{id}` and `conversation:{id}`.

---

### 13. Pricing the customer actually sees

The shop never edits price lists; it only displays the engine result.

| Step | Effect |
| --- | --- |
| List price (MRP) | Struck-through when higher than selling |
| Selling / price list | Default or **customer-specific** price list |
| Quantity tiers | Lower unit price at higher qty (bulk) |
| Offers | Best matching percent / flat / flash offer |
| Coupon | Applied on cart subtotal (min value, eligibility) |
| Tax | GST from product tax class |
| Delivery | Zone fee; free-delivery messaging above ₹999 |

Wholesale products enforce **minimum order quantity** on the cart quote.

---

### 14. Trust, GST, and wholesale (customer-facing)

Shown across home, PDP, checkout, footer:

- GST invoice after confirmation / on every order
- Original brand packs
- Easy returns (7 days, unused packs)
- Case packs from 6+ units, billed for business books
- Footer payment line: UPI · Cards · Net banking · Cash on delivery

---

## Guest vs signed-in cheat sheet

| Feature | Guest | Buyer |
| --- | --- | --- |
| Browse, search, filter | ✓ | ✓ |
| Product details & offers | ✓ | ✓ |
| Add to cart | ✓ (guest key) | ✓ |
| Wishlist | ✓ (local) | ✓ (local) |
| Set PIN / city | ✓ (local) | ✓ (saved to profile) |
| Apply coupons | — | ✓ |
| Saved addresses | — | ✓ |
| Checkout | redirected to login | ✓ |
| Orders & tracking | — | ✓ |
| Profile & password | — | ✓ |
| Support chat | — | ✓ |
| Help / legal | ✓ | ✓ |

---

## Customer API map

Base: `/api/v1`. Unauthenticated catalog/cart calls send `X-Guest-Key`. Authenticated calls send `Authorization: Bearer <token>`.

| Area | Method & path |
| --- | --- |
| Auth | `POST /auth/register` · `POST /auth/login` · `GET /auth/me` · `PATCH /auth/me` · `POST /auth/change-password` |
| Catalog | `GET /categories` · `GET /brands/public` · `GET /products/search` · `GET /products/lookup` |
| Cart | `GET /cart` · `POST /cart/items` · `PATCH /cart/items/:id` · `DELETE /cart/items/:id` · `POST /cart/coupon` · `GET /cart/coupons` · `POST /cart/merge` |
| Checkout | `POST /checkout/preview` · `POST /checkout` |
| Orders | `GET /orders` · `GET /orders/:id` |
| Addresses | `GET/POST /addresses` · `PATCH/DELETE /addresses/:id` |
| Location | `PUT /location/me` |
| CMS | `GET /cms/pages/:slug` |
| Chat | `GET/POST /chat` · `GET /chat/:id/messages` · `POST /chat/:id/messages` · `POST /chat/:id/read` |
| Health | `GET /api/health` |

---

## Out of scope (not general customers)

These exist in `mspReact` / `mspNode` but are **not** shopper features:

- Seller panel: dashboard, products, inventory, customers, reports, offers admin, team, settings
- Super-admin: tenants, users, roles, CMS editor, analytics, audit
- Staff chat macros, assign, escalate, close
- Creating/editing products, coupons, warehouses
- Reports export, RBAC, audit logs

Sellers are invited from the shop footer (“Start selling” → `/tenant/login`) but that is a different product.

---

## File index (shop only)

```
mspReact/src/shop/
  layouts/ShopLayout.jsx
  components/Header.jsx, Footer.jsx, MobileNav.jsx
  components/Hero.jsx, ProductCard.jsx, TaggedProductGrid.jsx, SaleBadges.jsx
  components/AuthModal.jsx, AccountModal.jsx, ShopUi.jsx
  pages/Home, Category, ProductDetails, Cart, Checkout, OrderConfirmation
  pages/Deals, NewLaunches, Brands, BulkBuy
  pages/Account, Orders, Addresses, Coupons, Wishlist
  pages/Login, Register, Support, Help, Legal

mspReact/src/shared/
  api.js, auth.js
  context/AuthContext, CartContext, LocationContext, ShopCatalogContext, AccountDrawerContext
  components/RequireAuth.jsx, SupportInbox.jsx (mode=buyer)
```

```
mspNode/src/modules/
  auth, catalog, pricing, cart, checkout, orders
  location (+ address), cms, chat, notifications, inventory (via checkout)
```
