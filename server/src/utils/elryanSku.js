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

/**
 * Official sku-exists contract:
 * 200 + data.available true means the SKU is free.
 * 409 CONFLICT means another product in the merchant catalog already uses it.
 * A legacy `exists` field is ignored so an available SKU is not treated as taken.
 */
export function interpretElryanSkuAvailability({ httpStatus = 0, json = null } = {}) {
  const body = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null;
  const available = data?.available === true ? true : data?.available === false ? false : null;
  const errorCode = String(body.error?.code || "").trim().toUpperCase();
  const conflict = Number(httpStatus) === 409 || errorCode === "CONFLICT";
  if (conflict || available === false) {
    return { available: false, exists: true, conflict };
  }
  if (available === true) {
    return { available: true, exists: false, conflict: false };
  }
  return { available: null, exists: false, conflict: false };
}

/** Listing fields present on a sku-exists conflict. Missing fields stay blank; none are invented. */
export function elryanListingFromSkuConflict(json) {
  const body = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
  const product = data.product && typeof data.product === "object" && !Array.isArray(data.product) ? data.product : data;
  return {
    id: String(product.id || product._id || product.productId || "").trim(),
    sku: String(product.sku || "").trim(),
    status: String(product.status || product.reviewStatus || product.publishStatus || "").trim(),
    name: String(product.name || product.title || "").trim(),
  };
}
