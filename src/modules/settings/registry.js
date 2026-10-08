import { z } from "zod";
import { DEFAULT_DELIVERY_PARTNERS, DEFAULT_ETA_DAYS } from "./defaults.js";

const money = z.number().finite().min(0).max(10_000_000);

const partner = z
  .object({
    id: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(80),
    fee: z.number().finite().min(0).max(10_000),
    isDefault: z.boolean().optional().default(false),
  })
  .strict();

const festival = z
  .object({
    enabled: z.boolean(),
    title: z.string().max(100).optional().default(""),
    message: z.string().max(500).optional().default(""),
    startsAt: z.string().datetime({ offset: true }).or(z.literal("")).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).or(z.literal("")).nullable().optional(),
  })
  .strict();

/**
 * Every setting the API accepts.
 * - `scopes`: where it may be written ("platform" = platform admin without tenant context,
 *   "tenant" = a store). Keys with both scopes are platform defaults a store may override
 *   (DELETE /settings/:key?scope=tenant removes the override).
 * - `type` / `label` / `description` / `group` / `min` / `max` / `enum` / `default` / `secret`
 *   / `public` are metadata for admin UIs (GET /settings/keys). `public` = exposed by
 *   GET /settings/public. No key is secret today; secrets (API keys) live in env only.
 * Unknown keys (or a key written in the wrong scope) are rejected with 404.
 */
export const SETTINGS_REGISTRY = {
  "platform.name": {
    scopes: ["platform"],
    schema: z.string().trim().min(1).max(100),
    type: "string",
    label: "Marketplace name",
    description: "Shown in the storefront header, emails and the browser title.",
    group: "General",
    max: 100,
    default: "MSP Wholesale Marketplace",
    public: true,
  },
  "platform.slogan": {
    scopes: ["platform"],
    schema: z.string().trim().max(200),
    type: "string",
    label: "Slogan",
    description: "Tagline shown under the marketplace name.",
    group: "General",
    max: 200,
    default: "भाव भी भरोसा भी",
    public: true,
  },
  "platform.festival": {
    scopes: ["platform"],
    schema: festival.nullable(),
    type: "object",
    label: "Festival banner",
    description: "Optional greeting banner { enabled, title, message, startsAt, endsAt } shown on the storefront while live.",
    group: "General",
    default: null,
    public: true,
  },
  "platform.currency": {
    scopes: ["platform"],
    schema: z.enum(["INR"]),
    type: "enum",
    label: "Currency",
    description: "Currency of every price on the marketplace (only INR is supported).",
    group: "General",
    enum: ["INR"],
    default: "INR",
    public: true,
  },
  "platform.supportEmail": {
    scopes: ["platform"],
    schema: z.string().trim().email().max(200),
    type: "email",
    label: "Support email",
    description: "Customer support address: shown on the storefront footer, in every email footer and used as Reply-To.",
    group: "General",
    max: 200,
    default: "",
    public: true,
  },
  "platform.defaultTaxRate": {
    scopes: ["platform"],
    schema: z.number().min(0).max(28),
    type: "number",
    label: "Default GST rate (%)",
    description: "GST rate given to new products without a tax class when the store has no default rate of its own.",
    group: "Tax",
    min: 0,
    max: 28,
    default: 18,
    public: false,
  },
  "platform.mapsProvider": {
    scopes: ["platform"],
    schema: z.enum(["stub", "google"]),
    type: "enum",
    label: "Maps provider",
    description: "Geocoding provider. \"google\" needs MAPS_API_KEY on the server; \"stub\" uses approximate PIN-code locations.",
    group: "Location",
    enum: ["stub", "google"],
    default: "stub",
    public: true,
  },
  "returns.enabled": {
    scopes: ["platform"],
    schema: z.boolean(),
    type: "boolean",
    label: "Returns enabled",
    description: "Allow buyers to request returns for items marked \"Easy return\".",
    group: "Returns",
    default: true,
    public: true,
  },
  "returns.windowDays": {
    scopes: ["platform"],
    schema: z.number().int().min(1).max(90),
    type: "integer",
    label: "Return window (days)",
    description: "Days after delivery during which a return can be requested.",
    group: "Returns",
    min: 1,
    max: 90,
    default: 7,
    public: true,
  },

  // Platform default, overridable per store (see settings/commerce.js readCommerceValue).
  "platform.feeEnabled": {
    scopes: ["platform", "tenant"],
    schema: z.boolean(),
    type: "boolean",
    label: "Platform fee enabled",
    description: "Charge buyers a platform fee at checkout.",
    group: "Fees & delivery",
    default: false,
    public: true,
  },
  "platform.feeAmount": {
    scopes: ["platform", "tenant"],
    schema: z.number().finite().min(0).max(10_000),
    type: "number",
    label: "Platform fee (flat ₹)",
    description: "Flat fee charged once per checkout when the platform fee is enabled.",
    group: "Fees & delivery",
    min: 0,
    max: 10_000,
    default: 10,
    public: true,
  },
  "platform.feePercent": {
    scopes: ["platform", "tenant"],
    schema: z.number().finite().min(0).max(50),
    type: "number",
    label: "Platform fee (% of subtotal)",
    description: "Percentage of each store's subtotal added to the platform fee.",
    group: "Fees & delivery",
    min: 0,
    max: 50,
    default: 0,
    public: true,
  },
  "platform.deliveryPartnerChoiceEnabled": {
    scopes: ["platform", "tenant"],
    schema: z.boolean(),
    type: "boolean",
    label: "Buyers choose delivery partner",
    description: "Let buyers pick a delivery partner at checkout; otherwise the default partner is used.",
    group: "Fees & delivery",
    default: true,
    public: true,
  },
  "platform.deliveryPartners": {
    scopes: ["platform", "tenant"],
    schema: z
      .array(partner)
      .min(1)
      .max(20)
      .refine((list) => new Set(list.map((p) => p.id)).size === list.length, { message: "partner ids must be unique" }),
    type: "array",
    label: "Delivery partners",
    description: "List of { id, name, fee, isDefault } delivery partners offered at checkout.",
    group: "Fees & delivery",
    min: 1,
    max: 20,
    default: DEFAULT_DELIVERY_PARTNERS,
    public: true,
  },
  "payments.codEnabled": {
    scopes: ["platform", "tenant"],
    schema: z.boolean(),
    type: "boolean",
    label: "Cash on delivery",
    description: "Allow cash on delivery. COD is offered only when both the platform and the store allow it.",
    group: "Payments",
    default: true,
    public: true,
  },

  "delivery.freeAbove": {
    scopes: ["tenant"],
    schema: money,
    type: "number",
    label: "Free delivery above (₹)",
    description: "No delivery or partner fee once the store order (after coupons) reaches this amount. 0 = off.",
    group: "Fees & delivery",
    min: 0,
    max: 10_000_000,
    default: 0,
    public: true,
  },
  "delivery.etaDays": {
    scopes: ["platform"],
    schema: z
      .object({
        etaDaysMin: z.number().int().min(0).max(60),
        etaDaysMax: z.number().int().min(0).max(60),
      })
      .strict()
      .refine((v) => v.etaDaysMin <= v.etaDaysMax, { message: "etaDaysMin must not exceed etaDaysMax", path: ["etaDaysMin"] }),
    type: "object",
    label: "Platform delivery estimate (days)",
    description:
      "{ etaDaysMin, etaDaysMax } shown in the storefront trust bar when no store is selected. When not set, it is derived from the active stores' delivery zones, else this default.",
    group: "Fees & delivery",
    default: DEFAULT_ETA_DAYS,
    public: true,
  },
  "store.displayName": {
    scopes: ["tenant"],
    schema: z.string().trim().max(100),
    type: "string",
    label: "Store display name",
    description: "Name shown to buyers on the storefront instead of the registered store name (empty = use the store name).",
    group: "Store",
    max: 100,
    default: "",
    public: true,
  },
};

export function settingDefinition(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key) ? SETTINGS_REGISTRY[key] : null;
}

export function knownKeys(scope) {
  return Object.entries(SETTINGS_REGISTRY)
    .filter(([, def]) => def.scopes.includes(scope))
    .map(([key]) => key);
}

/** Admin-UI metadata for one key (no zod schema). */
export function describeSetting(key) {
  const def = settingDefinition(key);
  if (!def) return null;
  const out = {
    key,
    type: def.type,
    label: def.label,
    description: def.description,
    group: def.group,
    scopes: def.scopes,
    overridable: def.scopes.includes("platform") && def.scopes.includes("tenant"),
    default: def.default ?? null,
    secret: Boolean(def.secret),
    public: Boolean(def.public),
  };
  for (const k of ["min", "max", "enum"]) if (def[k] !== undefined) out[k] = def[k];
  return out;
}
