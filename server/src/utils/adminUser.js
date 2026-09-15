import crypto from "crypto";

export function primaryAdminEmail() {
  return (process.env.ADMIN_EMAIL || "karim@brown.com").toLowerCase().trim();
}

export function isPrimaryAdmin(user) {
  return String(user?.email || "").toLowerCase() === primaryAdminEmail();
}

export function isSixDigitPin(value) {
  return /^\d{6}$/.test(String(value || "").trim());
}

export function apiKeyPin() {
  return String(process.env.API_KEY_PIN || "246810").trim();
}

export function verifyApiKeyPin(value) {
  const expected = apiKeyPin();
  const given = String(value || "").trim();
  if (!isSixDigitPin(expected) || !isSixDigitPin(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function toAdminAccount(user) {
  const email = String(user.email || "").toLowerCase();
  return {
    id: user._id.toString(),
    email,
    role: user.role,
    isPrimary: email === primaryAdminEmail(),
    createdAt: user.createdAt,
  };
}
