export const OWNERSHIP_IMAGE_FALLBACK = "/logo.png";

export function ownershipImageSrc(url, { failed = false } = {}) {
  const value = String(url || "").trim();
  if (!value || failed) return OWNERSHIP_IMAGE_FALLBACK;
  return value;
}
