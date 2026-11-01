import { ELRYAN_READINESS } from "./elryanConstants.js";

/** First live Staging create is limited to this SKU until that send is reviewed. */
export const ELRYAN_FIRST_STAGING_CREATE_SKU = "OWCH180002";

export function normalizeElryanStagingAttributes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "attributes_required", attributes: {} };
  }
  const attributes = {};
  for (const [key, value] of Object.entries(raw)) {
    const code = String(key || "").trim();
    const id = Number(value);
    if (!/^[a-z][a-z0-9_]*$/.test(code) || !Number.isInteger(id) || id <= 0) {
      return { ok: false, code: "invalid_attribute", attributes: {} };
    }
    attributes[code] = id;
  }
  if (!Object.keys(attributes).length) {
    return { ok: false, code: "attributes_required", attributes: {} };
  }
  return { ok: true, code: "", attributes };
}

/**
 * Staging product overrides apply only to that product in Staging.
 * A Production preview never receives them.
 */
export function mergeElryanStagingAttributes(environment, mappingAttributes, override) {
  const base =
    mappingAttributes && typeof mappingAttributes === "object" && !Array.isArray(mappingAttributes)
      ? { ...mappingAttributes }
      : {};
  if (String(environment || "") !== "staging") return base;
  if (!override || override.environment !== "staging") return base;
  const normalized = normalizeElryanStagingAttributes(override.attributes);
  if (!normalized.ok) return base;
  return { ...base, ...normalized.attributes };
}

export function assessElryanDimensionConfirmation(row) {
  if (!row || row.environment !== "staging") {
    return { confirmed: false, reason: "missing", unit: "", width: null, height: null, depth: null };
  }
  const unit = String(row.unit || "").trim();
  const width = Number(row.width);
  const height = Number(row.height);
  const depth = Number(row.depth);
  const numbersOk = [width, height, depth].every((value) => Number.isFinite(value) && value > 0);
  if (!unit || row.axesConfirmed !== true || !numbersOk) {
    return {
      confirmed: false,
      reason: !unit ? "unit" : "axes",
      unit: "",
      width: null,
      height: null,
      depth: null,
    };
  }
  return { confirmed: true, reason: "confirmed", unit, width, height, depth };
}

export function elryanDimensionBlockers(confirmation) {
  if (confirmation?.confirmed === true) return [];
  return [
    {
      code: "dimensions_unverified",
      status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
      message:
        "Packed width, height, and depth stay blocked until an operator explicitly confirms the measurement unit and which side is width, height, and depth. No unit or axis was assumed.",
    },
  ];
}

export function matchElryanStagingPriceApproval(approval, context = {}) {
  const sku = String(context.sku || "");
  const payload = context.payload || {};
  if (!approval) return { valid: false, reason: "missing" };
  if (context.environment !== "staging" || approval.environment !== "staging") {
    return { valid: false, reason: "environment" };
  }
  if (String(approval.productId || "") !== String(context.productId || "")) {
    return { valid: false, reason: "product" };
  }
  if (sku !== ELRYAN_FIRST_STAGING_CREATE_SKU || approval.sku !== ELRYAN_FIRST_STAGING_CREATE_SKU) {
    return { valid: false, reason: "sku" };
  }
  if (!context.payloadHash || approval.payloadHash !== context.payloadHash) {
    return { valid: false, reason: "payload_mismatch" };
  }
  const price = Number(payload.price);
  if (!(price > 0) || Number(approval.price) !== price) {
    return { valid: false, reason: "price" };
  }
  if (payload.cost != null || approval.costOmitted !== true || approval.sendPriceOnly !== true) {
    return { valid: false, reason: "cost" };
  }
  if (approval.currency !== "IQD") {
    return { valid: false, reason: "currency" };
  }
  return { valid: true, reason: "matched" };
}

export function elryanPublicationFromCreate(json) {
  const data = json?.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : {};
  const reviewStatus = String(data.status || data.reviewStatus || data.publishStatus || "")
    .trim()
    .toLowerCase();
  const published = data.published === true || reviewStatus === "published" || reviewStatus === "live";
  return {
    elryanProductId: String(data.id || data._id || data.productId || "").trim(),
    published,
    reviewStatus,
  };
}
