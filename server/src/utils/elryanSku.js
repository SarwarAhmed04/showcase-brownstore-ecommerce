import { ELRYAN_SKU_MAX, ELRYAN_SKU_PATTERN } from "./elryanConstants.js";

export function normalizeElryanSkuCandidate(raw) {
  return String(raw || "").trim();
}

export function validateElryanSku(raw) {
  const sku = normalizeElryanSkuCandidate(raw);
  if (!sku) return { ok: false, code: "missing_sku", message: "SKU is required." };
  if (sku.length > ELRYAN_SKU_MAX) {
    return {
      ok: false,
      code: "sku_too_long",
      message: `SKU must be at most ${ELRYAN_SKU_MAX} characters.`,
    };
  }
  if (/\s/.test(sku)) {
    return { ok: false, code: "sku_invalid_chars", message: "SKU must not contain spaces." };
  }
  if (!ELRYAN_SKU_PATTERN.test(sku)) {
    return {
      ok: false,
      code: "sku_invalid_chars",
      message: "SKU may only contain letters, digits, and - / _.",
    };
  }
  return { ok: true, sku };
}
