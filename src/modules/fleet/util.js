import { sendSms } from "../notifications/sms.js";

/** "+91XXXXXXXXXX" for an Indian mobile (10 digits starting 6-9, optional +91 / 91 / 0), else null. */
export function normalizeRiderPhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

export const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100 + 1e-7);

/** Google Maps link for a drop-off (coordinates when known, else the address text). */
export function mapUrl(dropoff = {}) {
  if (dropoff.lat != null && dropoff.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${dropoff.lat},${dropoff.lng}`;
  }
  // The address line usually ends with the PIN already; append it only when missing.
  const address = String(dropoff.address || "");
  const q = [address, dropoff.pincode && !address.includes(dropoff.pincode) ? dropoff.pincode : ""].filter(Boolean).join(" ");
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : "";
}

/* SMS sender (tests swap in a fake to read OTPs). */
let smsSender = sendSms;

export function setFleetSmsSender(fn) {
  smsSender = fn || sendSms;
}

export async function sendFleetSms(args) {
  return smsSender(args);
}
