import { User } from "../users/user.model.js";
import { sendMail } from "./mailer.js";
import { sendSms } from "./sms.js";
import { renderEmail } from "./templates.js";
import { allowed, unsubscribeUrl } from "./preferences.js";

/**
 * Deliver an out-of-band message (email and/or SMS) to a user, honouring their channel
 * preferences for `category`. Never throws: provider failures are logged.
 *
 * email: { subject, heading?, lines[], cta? }   sms: { kind, vars }
 */
export async function deliverToUser(userId, { category, email = null, sms = null }) {
  const result = { email: false, sms: false };
  const user = await User.findById(userId).select("name email phone status");
  if (!user || user.status === "deleted") return result;

  if (email && user.email && (await allowed(user._id, category, "email"))) {
    try {
      const rendered = renderEmail({
        greeting: user.name ? `Hi ${user.name},` : "",
        unsubscribeUrl: category === "account" ? "" : unsubscribeUrl(user._id, category, "email"),
        ...email,
      });
      const r = await sendMail({ to: user.email, ...rendered });
      result.email = r.sent;
    } catch (err) {
      console.error(`[notify] email to user ${user._id} failed:`, err.message);
    }
  }

  if (sms && user.phone && (await allowed(user._id, category, "sms"))) {
    try {
      const r = await sendSms({ phone: user.phone, kind: sms.kind, vars: { name: user.name, ...sms.vars } });
      result.sms = r.sent;
    } catch (err) {
      console.error(`[notify] sms to user ${user._id} failed:`, err.message);
    }
  }
  return result;
}

/** Backwards-compatible helper (plain title/body email, no SMS). */
export async function deliverBuyerMessage(userId, title, body, category = "order") {
  return deliverToUser(userId, { category, email: { subject: title, lines: [body] } });
}
