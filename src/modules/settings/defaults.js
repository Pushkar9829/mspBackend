/**
 * Default delivery partners (kept dependency-free so registry.js and commerce.js can share it).
 * The rupee sign is written as a unicode escape so editors / shells with a non-UTF-8 code page
 * cannot double-encode it into "â‚¹" (see src/utils/mojibake.js and runStorefrontMigrations).
 */
export const DEFAULT_PARTNER_NAME = "MS\u20B9 Delivery";

export const DEFAULT_DELIVERY_PARTNERS = [
  { id: "msp", name: DEFAULT_PARTNER_NAME, fee: 0, isDefault: true },
  { id: "delhivery", name: "Delhivery", fee: 40, isDefault: false },
  { id: "bluedart", name: "Blue Dart", fee: 55, isDefault: false },
];

/** Platform-wide delivery estimate shown when no store is selected (setting `delivery.etaDays`). */
export const DEFAULT_ETA_DAYS = { etaDaysMin: 2, etaDaysMax: 7 };
