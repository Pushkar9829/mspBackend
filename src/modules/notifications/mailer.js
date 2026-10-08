import { env } from "../../config/env.js";

export function mailConfigured() {
  return Boolean(env.smtpHost);
}

let transportPromise = null;
async function transport() {
  if (!transportPromise) {
    transportPromise = import("nodemailer").then((nodemailer) =>
      nodemailer.default.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpPort === 465,
        auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
      })
    );
    transportPromise.catch(() => {
      transportPromise = null;
    });
  }
  return transportPromise;
}

/**
 * Send an email. `html` is optional (text is always sent as the plain-text alternative).
 * Returns { sent, logged?, skipped? }. Throws on SMTP errors so callers can decide.
 */
async function platformSupportEmail() {
  try {
    const { supportEmail } = await import("../settings/service.js");
    return await supportEmail();
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Add the platform support address (setting `platform.supportEmail`) to an outgoing email:
 * a "Need help?" footer line (text + html) and the Reply-To header. Exported for tests.
 */
export function withSupportFooter({ text, html, replyTo }, support) {
  if (!support) return { text, html, replyTo };
  const line = `Need help? Contact us at ${support}`;
  const nextText = text && text.includes(support) ? text : [text || "", "", line].join("\n").replace(/^\n+/, "");
  let nextHtml = html;
  if (html && !html.includes(support)) {
    const footer = `<p style="font-size:12px;color:#777;margin:16px 0 0">Need help? Contact us at <a href="mailto:${escapeHtml(support)}" style="color:#777">${escapeHtml(support)}</a></p>`;
    nextHtml = html.includes("</body>") ? html.replace("</body>", `${footer}</body>`) : `${html}${footer}`;
  }
  return { text: nextText, html: nextHtml, replyTo: replyTo || support };
}

export async function sendMail({ to, subject, text, html, headers, replyTo }) {
  if (!to) return { sent: false, skipped: "no-recipient" };
  ({ text, html, replyTo } = withSupportFooter({ text, html, replyTo }, await platformSupportEmail()));
  if (!mailConfigured()) {
    if (!env.isProd) console.log(`Email to ${to}: ${subject}\n${text || ""}`);
    return { sent: false, logged: !env.isProd, skipped: "not-configured" };
  }
  const t = await transport();
  await t.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text: text || "",
    ...(html ? { html } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(headers ? { headers } : {}),
  });
  return { sent: true };
}
