import { env } from "../../config/env.js";
import { links } from "../../utils/links.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function brandName() {
  return String(env.smtpFrom || "MSP").replace(/\s*<.*>\s*$/, "").trim() || "MSP";
}

export function formatInr(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render a transactional email as { subject, text, html }.
 * `lines` are plain-text paragraphs (escaped for HTML). `cta` = { label, url }.
 */
export function renderEmail({ subject, heading, greeting, lines = [], cta = null, unsubscribeUrl = "" }) {
  const brand = brandName();
  const textParts = [greeting, heading && heading !== subject ? heading : "", ...lines].filter(Boolean);
  if (cta?.url) textParts.push(`${cta.label || "Open"}: ${cta.url}`);
  textParts.push("", `— ${brand}`);
  if (unsubscribeUrl) textParts.push(`Manage email preferences: ${unsubscribeUrl}`);

  const paragraphs = lines
    .filter(Boolean)
    .map((l) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(l)}</p>`)
    .join("");
  const button = cta?.url
    ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="background:#322FBC;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label || "Open")}</a></p>`
    : "";
  const footer = unsubscribeUrl
    ? `<p style="font-size:12px;color:#777;margin-top:24px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#777">Unsubscribe or manage email preferences</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;color:#222">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:8px" cellspacing="0" cellpadding="0"><tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading || subject)}</h1>
${greeting ? `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>` : ""}
${paragraphs}${button}
<p style="margin:24px 0 0;color:#555">— ${escapeHtml(brand)}</p>${footer}
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text: textParts.join("\n"), html };
}

/** Buyer order page (FRONTEND_URL + FRONTEND_ORDER_PATH, default /account/orders/:id). */
export function orderUrl(orderId) {
  return links.order(orderId);
}

/** Store order page in the seller panel (default /tenant/orders/:id). */
export function staffOrderUrl(orderId) {
  return links.staffOrder(orderId);
}
