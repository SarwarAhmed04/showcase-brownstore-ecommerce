import { ELRYAN_BATCH_MAX } from "./elryanConstants.js";
import { ELRYAN_FIRST_STAGING_CREATE_SKU as STAGING_PILOT_SKU } from "./elryanStagingGate.js";

function integerAttributeIds(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return out;
  for (const [key, value] of Object.entries(attributes)) {
    const code = String(key || "").trim();
    const id = Number(value);
    if (!code || !Number.isInteger(id) || id <= 0) continue;
    out[code] = id;
  }
  return out;
}

function imageLinks(images) {
  return (Array.isArray(images) ? images : [])
    .map((image) => {
      if (typeof image === "string") return image.trim();
      return String(image?.fileUrl || image?.url || "").trim();
    })
    .filter(Boolean);
}

/**
 * POST /v1/batch/product/create body.
 * Brand and colour are marketplace names. Cost is omitted; sellingPrice is the BrownStore amount.
 */
export function buildElryanBatchCreateBody(items) {
  const data = (Array.isArray(items) ? items : []).slice(0, ELRYAN_BATCH_MAX).map((item) => {
    const row = {
      sku: String(item?.sku || "").trim(),
      brand: String(item?.brand || "").trim(),
      categoryId: String(item?.categoryId || "").trim(),
      quantity: Math.max(0, Math.floor(Number(item?.quantity) || 0)),
      images: imageLinks(item?.images),
    };
    const color = String(item?.color || "").trim();
    if (color) row.color = color;
    if (Number(item?.sellingPrice) > 0) row.sellingPrice = Number(item.sellingPrice);
    for (const key of [
      "vendorTitle",
      "vendorTitleAr",
      "vendorDescription",
      "vendorDescriptionAr",
      "warrantyCode",
    ]) {
      const value = String(item?.[key] || "").trim();
      if (value) row[key] = value;
    }
    for (const key of ["width", "height", "depth"]) {
      const value = Number(item?.[key]);
      if (value > 0) row[key] = value;
    }
    const attributes = integerAttributeIds(item?.attributes);
    if (Object.keys(attributes).length) row.attributes = attributes;
    return row;
  });
  return { data };
}

/** POST /v1/batch/product/update body. SKU plus only the stock and selling price that changed. */
export function buildElryanBatchUpdateBody(items) {
  const data = (Array.isArray(items) ? items : []).slice(0, ELRYAN_BATCH_MAX).map((item) => {
    const row = { sku: String(item?.sku || "").trim() };
    if (item?.qty != null || item?.quantity != null) {
      row.qty = Math.max(0, Math.floor(Number(item.qty ?? item.quantity) || 0));
    }
    if (Number(item?.sellingPrice) > 0) row.sellingPrice = Number(item.sellingPrice);
    return row;
  });
  return { data };
}

function failedMap(data) {
  const rows = Array.isArray(data?.failedProducts) ? data.failedProducts : null;
  const map = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku || "").trim();
    if (!sku) continue;
    map.set(sku, Array.isArray(row.errors) ? row.errors : []);
  }
  return { listed: rows != null, map };
}

/**
 * One outcome per submitted SKU.
 * status null, a transport failure, or a failed-item count that does not match the SKU list is ambiguous.
 * Ambiguous rows must be reconciled before another send.
 */
export function classifyElryanBatchResult({ requestedSkus = [], httpStatus = 0, json = null, transportError = "" } = {}) {
  const skus = requestedSkus.map((sku) => String(sku || "").trim()).filter(Boolean);
  const ambiguousRow = (sku) => ({ sku, outcome: "ambiguous", errors: [] });
  if (transportError || json == null || !httpStatus) {
    return {
      ambiguous: true,
      partial: false,
      retryAllowed: false,
      batchId: "",
      results: skus.map(ambiguousRow),
    };
  }
  const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
  const batchId = String(data?._id || "").trim();
  if (data?.status == null) {
    return {
      ambiguous: true,
      partial: false,
      retryAllowed: false,
      batchId,
      results: skus.map(ambiguousRow),
    };
  }
  const failed = failedMap(data);
  if (data.status === false) {
    return {
      ambiguous: false,
      partial: false,
      retryAllowed: false,
      batchId,
      results: skus.map((sku) => ({
        sku,
        outcome: "failed",
        errors: failed.map.get(sku) || [{ message: String(data.errorMessage || "Elryan did not save this product.") }],
      })),
    };
  }
  const failedItems = Number(data.failedItems);
  const listedCount = failed.map.size;
  const results = skus.map((sku) => {
    if (failed.map.has(sku)) return { sku, outcome: "failed", errors: failed.map.get(sku) };
    if (failedItems === 0) return { sku, outcome: "saved", errors: [] };
    if (failed.listed && listedCount === failedItems) return { sku, outcome: "saved", errors: [] };
    return ambiguousRow(sku);
  });
  const saved = results.some((row) => row.outcome === "saved");
  const anyFailed = results.some((row) => row.outcome === "failed");
  return {
    ambiguous: results.some((row) => row.outcome === "ambiguous"),
    partial: saved && anyFailed,
    retryAllowed: false,
    batchId,
    results,
  };
}

export function reconcileElryanBatchResult(previous, followUp) {
  if (!previous?.ambiguous) return previous;
  return classifyElryanBatchResult(followUp);
}

/**
 * OWCH180002 is the existing Staging pilot. A second create is not added to the batch.
 * An unanswered SKU check stays ambiguous until a later read settles it.
 */
export function partitionElryanBatchCreates({ items = [], confirmedSkus = [], skuAvailability = {} } = {}) {
  const confirmed = new Set((confirmedSkus || []).map((sku) => String(sku || "").trim()));
  const send = [];
  const results = [];
  for (const item of items) {
    const sku = String(item?.sku || "").trim();
    if (sku !== STAGING_PILOT_SKU) {
      send.push(item);
      continue;
    }
    if (confirmed.has(sku) || skuAvailability[sku] === false) {
      results.push({ sku, outcome: "duplicate_blocked", errors: [] });
      continue;
    }
    if (skuAvailability[sku] !== true) {
      results.push({ sku, outcome: "sku_unverified", errors: [] });
      continue;
    }
    send.push(item);
  }
  return { send, results };
}
