import crypto from "node:crypto";
import { CmsPage } from "../modules/cms/cmsPage.model.js";
import { logger } from "../utils/logger.js";

/**
 * Global (tenantId null) pages the storefront footer / trust bar / help links point to.
 *
 * - Missing pages are inserted (published).
 * - Seeded pages carry `seedHash` (hash of the { title, sections } the seed wrote) and
 *   `seedSource`. When the seed content changes, a page whose current content still hashes to
 *   its seedHash (nobody edited it) is updated; an edited page is never overwritten.
 * - Pages seeded before hashes existed are recognised by the hash of the old seed content
 *   (LEGACY_*); anything else without a seedHash is treated as admin-authored and left alone.
 * - A page an admin deletes is re-created on the next start; unpublish it instead to hide it.
 *
 * Facts that depend on configuration are not hard-coded: content uses {{tokens}} that the public
 * CMS endpoint fills from settings at render time (see cms/render.js): {{supportEmail}},
 * {{platformName}}, {{etaDays}}, {{etaDaysMin}}, {{etaDaysMax}}, {{returnWindowDays}}.
 *
 * Legal pages stay placeholder text in [square brackets] that the operator must replace before
 * launch (the grievance officer is a legal requirement under the Consumer Protection
 * (E-Commerce) Rules, 2020).
 */
const TODO = (text) => `<p><strong>[To be completed by the marketplace operator: ${text}]</strong></p>`;

/* ------------------------------------------------------------------ shared content */

/**
 * Refund destinations as implemented (orders/lifecycle.js, checkout/refunds.js, ledger):
 * - online (UPI / card / netbanking via Razorpay), paid: a Razorpay refund to the original method;
 * - purchase order / credit terms: the ledger debit is reversed (credit to the store account);
 * - COD: nothing is collected before delivery, so a cancellation needs no refund; for a delivered
 *   COD order no automatic refund exists, so the store settles it with the buyer directly.
 */
export const REFUND_METHODS_HTML =
  "<h2>How refunds are paid</h2>" +
  "<ul>" +
  "<li><strong>UPI, card or netbanking</strong> (paid online through Razorpay): refunded to the original payment method. " +
  "How soon it shows up depends on your bank.</li>" +
  "<li><strong>Purchase order or credit terms</strong>: the amount is credited back to your account with the store. " +
  "It reduces what you owe or adds to your available credit; it is not paid out to a bank account.</li>" +
  "<li><strong>Cash on delivery</strong>: nothing is charged if a COD order is cancelled before delivery. " +
  "For a delivered COD order, the store arranges the refund with you directly. If you have not heard from them, email {{supportEmail}}.</li>" +
  "</ul>";

export const REFUNDS_HTML =
  "<h2>Returns</h2>" +
  "<p>Items marked <strong>Easy return</strong> can be returned within {{returnWindowDays}} days of delivery. " +
  "Request the return from the order page in your account; the store reviews it and arranges the pickup or drop-off.</p>" +
  REFUND_METHODS_HTML +
  "<p>Questions about a return or refund: {{supportEmail}}.</p>";

export const SHIPPING_HTML =
  "<p>Most orders arrive in {{etaDays}} days. The estimate depends on your PIN code and on the store's delivery zones; " +
  "the product page and checkout show the estimate and delivery charges for your address.</p>" +
  "<p>Bulk orders can take longer when the product has a lead time. Some stores also offer store pickup.</p>" +
  "<p>Delivery questions: {{supportEmail}}.</p>";

export const HELP_SECTIONS = [
  {
    kind: "faq",
    q: "How long does delivery take?",
    a: "Most orders arrive in {{etaDays}} days, depending on your PIN code and the store's delivery zones. The product page and checkout show the estimate for your address. Bulk orders can take longer when the product has a lead time.",
  },
  {
    kind: "faq",
    q: "How do returns work?",
    a: "Items marked “Easy return” can be returned within {{returnWindowDays}} days of delivery. Request the return from the order page in your account.",
  },
  {
    kind: "faq",
    q: "How will I get my refund?",
    a: "UPI, card and netbanking payments are refunded to the original payment method. Purchase-order and credit-terms orders are credited back to your account with the store. Cash on delivery: nothing is charged if the order is cancelled before delivery; for a delivered COD order the store arranges the refund with you directly.",
  },
  { kind: "faq", q: "How do I contact support?", a: "Email {{supportEmail}}." },
];

/* ------------------------------------------------------------------ default pages */

export const DEFAULT_CMS_PAGES = [
  {
    slug: "grievance",
    title: "Grievance redressal",
    type: "policy",
    html:
      TODO("replace every bracketed field on this page before launch") +
      "<h2>Grievance officer</h2>" +
      "<p>Name: [Grievance officer name]<br>Designation: [Designation]<br>" +
      "Email: [grievance@your-domain]<br>Phone: [Phone number]<br>" +
      "Address: [Registered office address]<br>Working hours: [Mon–Fri, 10:00–18:00 IST]</p>" +
      "<h2>How to raise a complaint</h2>" +
      "<p>Write to the grievance officer with your order number and a short description of the issue. " +
      "We acknowledge complaints within [48 hours] and aim to resolve them within [one month] of receipt.</p>",
  },
  {
    slug: "terms",
    title: "Terms & conditions",
    type: "terms",
    html: TODO("terms of use and sale") + "<p>[Legal entity name], [registered address], operates this marketplace. [Terms of use].</p>",
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    type: "privacy",
    html: TODO("privacy policy") + "<p>[What personal data is collected, why, how long it is kept, and how to contact us about it].</p>",
  },
  { slug: "refunds", title: "Returns & refunds", type: "policy", html: REFUNDS_HTML },
  { slug: "shipping", title: "Shipping policy", type: "shipping", html: SHIPPING_HTML },
  {
    slug: "about",
    title: "About us",
    type: "custom",
    html: TODO("about the marketplace") + "<p>[Company name] — [who we are and what we offer]. Contact: {{supportEmail}}.</p>",
  },
  { slug: "help", title: "Help Centre", type: "faq", sections: HELP_SECTIONS },
];

/**
 * Earlier seed content (before seed hashes). A page without a seedHash whose content still equals
 * one of these was never edited, so it is updated. Includes the demo seed's old global pages,
 * which claimed refunds always go "to the original payment method", "1–3 day" delivery and a
 * hard-coded support address.
 */
export const LEGACY_DEMO_GLOBAL = {
  help: [
    {
      title: "Help Centre",
      sections: [
        { kind: "faq", q: "How long does shipping take?", a: "Metro pincodes typically arrive in 1–3 days. Bulk orders may ship from the nearest warehouse." },
        { kind: "faq", q: "How do returns work?", a: "Unused, sealed packs can be returned within 7 days. Refunds go to the original payment method." },
        { kind: "faq", q: "How do I contact support?", a: "Email support@msrmarket.local · Mon–Sat, 9am–7pm." },
      ],
    },
  ],
  shipping: [
    {
      title: "Shipping policy",
      sections: [{ kind: "html", html: "<p>Orders in metro pincodes typically arrive in 1–3 days. Bulk orders may ship from the nearest warehouse.</p>" }],
    },
  ],
  returns: [
    {
      title: "Returns & refunds",
      sections: [{ kind: "html", html: "<p>Unused, sealed packs can be returned within 7 days. Refunds are processed to the original payment method.</p>" }],
    },
  ],
};

const LEGACY_DEFAULTS = {
  refunds: [{ title: "Returns & refunds", sections: [{ kind: "html", html: TODO("returns and refunds policy") + "<p>[Return window], [eligible items], [refund method and timelines].</p>" }] }],
  shipping: [
    { title: "Shipping policy", sections: [{ kind: "html", html: TODO("shipping policy") + "<p>[Delivery areas], [typical delivery times], [delivery charges].</p>" }] },
    ...LEGACY_DEMO_GLOBAL.shipping,
  ],
  about: [{ title: "About us", sections: [{ kind: "html", html: TODO("about the marketplace") + "<p>[Company name] — [who we are and what we offer]. Contact: [support email].</p>" }] }],
  help: LEGACY_DEMO_GLOBAL.help,
  returns: LEGACY_DEMO_GLOBAL.returns,
};

/**
 * `returns` is not created (the public endpoint resolves it as an alias of `refunds`), but an
 * unedited old demo `returns` page is brought in line with the refunds page.
 */
const UPDATE_ONLY_PAGES = [{ slug: "returns", title: "Returns & refunds", type: "policy", html: REFUNDS_HTML }];

/* ------------------------------------------------------------------ seed hash */

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_id" || value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/** Hash of a page's seedable content: { title, sections } (key order and section _ids ignored). */
export function cmsContentHash(page) {
  const body = JSON.stringify(canonical({ title: page.title || "", sections: page.sections || [] }));
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 32);
}

function sectionsOf(page) {
  return page.sections || [{ kind: "html", html: page.html }];
}

/**
 * Insert (unless `updateOnly`) or update one seeded page. `filter` = { tenantId, slug }. `page` = { title, type,
 * sections | html, status? }. An existing page is updated only when it is unedited seed content:
 * - its content hashes to its seedHash and it was seeded by `source` (or a source in `takeOver`); or
 * - it has no seedHash and its content equals one of `legacy` (old seed versions) or the new content.
 * Updates keep the page's status and bump `version`. Returns "created" | "updated" | "unchanged" | "kept".
 */
export async function upsertSeedPage(filter, page, { source, legacy = [], takeOver = [], updateOnly = false } = {}) {
  const content = { title: page.title, sections: sectionsOf(page) };
  const hash = cmsContentHash(content);
  const existing = await CmsPage.findOne(filter).lean();
  const now = new Date();
  if (!existing && updateOnly) return "kept";
  if (!existing) {
    try {
      const res = await CmsPage.updateOne(
        filter,
        {
          $setOnInsert: {
            ...filter,
            title: content.title,
            type: page.type,
            status: page.status || "published",
            sections: content.sections,
            seo: { title: content.title, description: content.title, canonical: `/${filter.slug}` },
            scheduledAt: null,
            publishedAt: now,
            version: 0,
            seedHash: hash,
            seedSource: source,
          },
        },
        { upsert: true }
      );
      return res.upsertedCount ? "created" : "kept";
    } catch (err) {
      if (err?.code !== 11000) throw err; // inserted concurrently
      return "kept";
    }
  }
  const current = cmsContentHash(existing);
  const unedited = existing.seedHash
    ? current === existing.seedHash && (existing.seedSource === source || takeOver.includes(existing.seedSource))
    : current === hash || legacy.some((old) => cmsContentHash(old) === current);
  if (!unedited) return "kept";
  if (current === hash && existing.seedHash === hash && existing.seedSource === source) return "unchanged";
  const contentChanged = current !== hash;
  const res = await CmsPage.updateOne(
    { _id: existing._id, updatedAt: existing.updatedAt }, // lost race with an editor → leave it
    {
      $set: {
        ...(contentChanged
          ? { title: content.title, type: page.type, sections: content.sections, seo: { ...(existing.seo || {}), title: content.title, description: content.title } }
          : {}),
        seedHash: hash,
        seedSource: source,
      },
      ...(contentChanged ? { $inc: { version: 1 } } : {}),
    }
  );
  return res.modifiedCount ? (contentChanged ? "updated" : "unchanged") : "kept";
}

/**
 * Idempotent: inserts missing global pages and refreshes unedited seeded ones. Returns the slugs
 * it created (or { created, updated } with `details: true`).
 */
export async function ensureDefaultCmsPages({ details = false } = {}) {
  const created = [];
  const updated = [];
  for (const [page, updateOnly] of [...DEFAULT_CMS_PAGES.map((p) => [p, false]), ...UPDATE_ONLY_PAGES.map((p) => [p, true])]) {
    const result = await upsertSeedPage({ tenantId: null, slug: page.slug }, page, {
      source: "defaults",
      legacy: LEGACY_DEFAULTS[page.slug] || [],
      updateOnly,
    });
    if (result === "created") created.push(page.slug);
    if (result === "updated") updated.push(page.slug);
  }
  if (created.length || updated.length) logger.info("seeded default CMS pages", { created, updated });
  return details ? { created, updated } : created;
}
