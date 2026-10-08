/**
 * Small allowlist HTML sanitizer for CMS content (no dependencies).
 *
 * - Only ALLOWED_TAGS survive; other tags are removed (their text content is kept).
 * - DROP_WITH_CONTENT tags (script, style, iframe, svg, …) are removed together with their content.
 * - Only allowlisted attributes survive; every `on*` handler and `style` is removed.
 * - href/src must be http(s), mailto/tel (href only), relative, or a data:image (img src only);
 *   entity-encoded / whitespace-obfuscated `javascript:` URLs are rejected.
 * - Comments, doctype and processing instructions are removed; stray `<`/`>` are escaped.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sup", "sub", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre",
  "ul", "ol", "li", "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript",
  "template", "svg", "math", "textarea", "select", "xmp", "plaintext", "noembed", "noframes", "title", "head",
]);
const GLOBAL_ATTRS = new Set(["class", "title", "id", "dir", "lang"]);
const TAG_ATTRS = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align", "scope"]),
  ol: new Set(["start", "type"]),
};

const TOKEN_RX = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?\s*>/g;
const ATTR_RX = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function escapeText(text) {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value).replace(/&(?![a-zA-Z]+;|#\d+;|#x[\da-fA-F]+;)/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const NAMED = { colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([\da-fA-F]+);?/g, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 0))
    .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/** Returns the URL if safe, otherwise null. */
export function safeUrl(value, { allowDataImage = false, allowMailTel = true } = {}) {
  if (value == null) return null;
  // eslint-disable-next-line no-control-regex
  const decoded = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]/g, "").trim();
  if (!decoded) return null;
  const lower = decoded.toLowerCase();
  if (/^https?:\/\//.test(lower)) return value.trim();
  if (allowMailTel && /^(mailto|tel):/.test(lower)) return value.trim();
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(decoded)) return decoded;
  // Relative URLs / anchors: must not contain a scheme before the first / ? #
  if (/^[/#?.]/.test(decoded) && !/^\/\//.test(decoded)) return value.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return value.trim();
  return null;
}

/**
 * Media/attachment URLs stored by the API (product images, brand logos, chat attachments): only
 * absolute http(s) URLs or our own relative upload paths (/uploads/...). Never javascript:, data:,
 * protocol-relative or other schemes.
 */
export function isSafeMediaUrl(value) {
  if (typeof value !== "string") return false;
  const url = safeUrl(value, { allowMailTel: false });
  if (!url) return false;
  // eslint-disable-next-line no-control-regex
  const lower = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
  if (/^https?:\/\/[^/]/.test(lower)) return true;
  return lower.startsWith("/uploads/") && !lower.includes("..");
}

function cleanAttrs(tag, raw) {
  const allowed = TAG_ATTRS[tag];
  const out = [];
  let target = null;
  ATTR_RX.lastIndex = 0;
  let m;
  while ((m = ATTR_RX.exec(raw || ""))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (name.startsWith("on") || name === "style" || name.startsWith("xmlns") || name.includes(":")) continue;
    if (!GLOBAL_ATTRS.has(name) && !(allowed && allowed.has(name))) continue;
    if (name === "href") {
      const url = safeUrl(value);
      if (!url) continue;
      out.push(`href="${escapeAttr(url)}"`);
      continue;
    }
    if (name === "src") {
      const url = safeUrl(value, { allowDataImage: true, allowMailTel: false });
      if (!url) continue;
      out.push(`src="${escapeAttr(url)}"`);
      continue;
    }
    if (name === "target") {
      target = value === "_blank" ? "_blank" : null;
      continue;
    }
    if (name === "rel") continue; // set below
    if (["width", "height", "colspan", "rowspan", "start"].includes(name) && !/^\d{1,5}%?$/.test(value)) continue;
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  if (tag === "a" && target) out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  return out.length ? ` ${out.join(" ")}` : "";
}

export function sanitizeHtml(input) {
  if (typeof input !== "string" || !input) return input ?? "";
  if (!/[<>]/.test(input)) return input;
  let out = "";
  let last = 0;
  TOKEN_RX.lastIndex = 0;
  let m;
  while ((m = TOKEN_RX.exec(input))) {
    out += escapeText(input.slice(last, m.index));
    last = TOKEN_RX.lastIndex;
    const tagName = m[1]?.toLowerCase();
    if (!tagName) continue; // comment / doctype / PI
    const closing = m[0].startsWith("</");
    if (DROP_WITH_CONTENT.has(tagName)) {
      if (!closing) {
        const closeRx = new RegExp(`</${tagName}\\s*>`, "ig");
        closeRx.lastIndex = last;
        const close = closeRx.exec(input);
        last = close ? closeRx.lastIndex : input.length;
        TOKEN_RX.lastIndex = last;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tagName)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tagName)) out += `</${tagName}>`;
      continue;
    }
    out += `<${tagName}${cleanAttrs(tagName, m[2])}>`;
  }
  out += escapeText(input.slice(last));
  return out;
}

const URL_KEYS = new Set(["href", "url", "link", "src", "image", "imageUrl", "image_url", "ctaUrl", "ctaLink", "video", "videoUrl", "canonical"]);

/** Recursively sanitize CMS section data: HTML in every string, URL-ish keys must be safe URLs. */
export function sanitizeValue(value, key = "", depth = 0) {
  if (depth > 12) return null;
  if (typeof value === "string") {
    if (URL_KEYS.has(key)) {
      if (!value) return "";
      return safeUrl(value, { allowDataImage: /image|src/i.test(key) }) ?? "";
    }
    return sanitizeHtml(value);
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, key, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("$") || k.includes(".") || k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = sanitizeValue(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.map((s) => sanitizeValue(s));
}
