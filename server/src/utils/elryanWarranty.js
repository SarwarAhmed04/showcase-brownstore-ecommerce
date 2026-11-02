import { ELRYAN_READINESS } from "./elryanConstants.js";
import { extractElryanListMeta } from "./elryanPagination.js";

const WARRANTY_MAX_PAGES = 20;

function suppliedScalar(row, keys) {
  if (!row || typeof row !== "object") return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (value == null || value === "") continue;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return text;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

/** Duration text only when the warranty payload itself includes it. */
export function suppliedWarrantyDuration(row) {
  const direct = suppliedScalar(row, [
    "duration",
    "warranty_duration",
    "warrantyDuration",
    "period",
    "warranty_period",
  ]);
  if (direct) {
    const unit = suppliedScalar(row, [
      "duration_unit",
      "durationUnit",
      "warranty_period_unit",
      "warranty_period_type",
      "period_type",
    ]);
    if (unit && !direct.toLowerCase().includes(unit.toLowerCase())) return `${direct} ${unit}`;
    return direct;
  }
  const nested = row?.duration;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const value = suppliedScalar(nested, ["value", "duration", "amount"]);
  const unit = suppliedScalar(nested, ["unit", "duration_unit"]);
  if (!value) return null;
  return unit ? `${value} ${unit}` : value;
}

export function suppliedWarrantyTerms(row) {
  return suppliedScalar(row, [
    "terms",
    "warranty_terms",
    "warrantyTerms",
    "description",
    "terms_and_conditions",
    "termsAndConditions",
  ]);
}

export function suppliedWarrantyStatus(row) {
  const text = suppliedScalar(row, ["status", "warranty_status", "warrantyStatus"]);
  if (text) return text;
  if (typeof row?.warranty_provided === "boolean") return row.warranty_provided ? "provided" : "not provided";
  if (typeof row?.is_active === "boolean") return row.is_active ? "active" : "inactive";
  if (typeof row?.isActive === "boolean") return row.isActive ? "active" : "inactive";
  if (typeof row?.active === "boolean") return row.active ? "active" : "inactive";
  return null;
}

export function warrantyRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.warranties)) return payload.data.warranties;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.warranties)) return payload.warranties;
  return [];
}

function warrantyFingerprint(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.warranty_code || row?.warrantyCode || row?.code || row?.id || "").trim())
    .join("\n");
}

function pushWarrantyRows(target, seenCodes, batch) {
  let added = 0;
  for (const row of Array.isArray(batch) ? batch : []) {
    const code = String(row?.warranty_code || row?.warrantyCode || row?.code || "").trim();
    if (code && seenCodes.has(code)) continue;
    if (code) seenCodes.add(code);
    target.push(row);
    added += 1;
  }
  return added;
}

/**
 * Walk GET /v1/warranty.
 * A response with no pagination meta is the complete accessible list.
 * Reliable meta.total is followed page by page. A later page that repeats the
 * previous page means the endpoint is not advancing, so the rows already
 * collected are the accessible list. An empty later page, a failed page, or a
 * page cap before meta.total is a failed fetch — not an empty catalog.
 */
export async function collectElryanWarrantyRows(requestPage) {
  const first = await requestPage(undefined);
  if (!first?.ok) {
    const error = new Error(first?.message || "GET /v1/warranty failed.");
    error.status = Number(first?.httpStatus) >= 400 && Number(first?.httpStatus) < 600 ? Number(first.httpStatus) : 502;
    error.httpStatus = Number(first?.httpStatus) || 0;
    error.code = "warranty_list_failed";
    throw error;
  }

  const rows = [];
  const seenCodes = new Set();
  const firstBatch = warrantyRowsFromPayload(first.json);
  pushWarrantyRows(rows, seenCodes, firstBatch);
  const fingerprints = [warrantyFingerprint(firstBatch)];
  let meta = extractElryanListMeta(first.json);
  let pagesFetched = 1;
  let mode = meta.reliable ? "paged" : "single_response";
  let reason = meta.reliable ? "total_reached" : meta.reason || "meta_absent";
  let complete = !meta.reliable || rows.length >= meta.total;

  if (meta.reliable && rows.length < meta.total) {
    let page = Number.isFinite(meta.page) ? meta.page : 1;
    const limit = meta.limit;
    while (pagesFetched < WARRANTY_MAX_PAGES && rows.length < meta.total) {
      page += 1;
      const next = await requestPage({ page, limit });
      pagesFetched += 1;
      if (!next?.ok) {
        const error = new Error(next?.message || `GET /v1/warranty page ${page} failed.`);
        error.status = 502;
        error.httpStatus = Number(next?.httpStatus) || 0;
        error.code = "warranty_list_failed";
        throw error;
      }
      const nextBatch = warrantyRowsFromPayload(next.json);
      const fingerprint = warrantyFingerprint(nextBatch);
      if (!nextBatch.length) {
        complete = false;
        reason = "empty_page";
        mode = "paged";
        break;
      }
      if (fingerprints.includes(fingerprint)) {
        complete = true;
        reason = "repeated_page";
        mode = pagesFetched > 1 ? "paged" : "single_response";
        break;
      }
      fingerprints.push(fingerprint);
      const added = pushWarrantyRows(rows, seenCodes, nextBatch);
      const nextMeta = extractElryanListMeta(next.json);
      if (nextMeta.reliable) meta = nextMeta;
      if (added === 0) {
        complete = true;
        reason = "repeated_page";
        mode = "paged";
        break;
      }
      if (rows.length >= meta.total) {
        complete = true;
        reason = "total_reached";
        mode = "paged";
        break;
      }
    }
    if (rows.length < meta.total && reason !== "repeated_page" && reason !== "empty_page") {
      complete = false;
      reason = pagesFetched >= WARRANTY_MAX_PAGES ? "max_pages" : "incomplete";
      mode = "paged";
    }
  }

  if (!complete) {
    const error = new Error(
      "GET /v1/warranty did not return the full warranty list. No partial list was accepted and no warranty code was invented."
    );
    error.status = 502;
    error.httpStatus = Number(first.httpStatus) || 0;
    error.code = "warranty_list_incomplete";
    throw error;
  }

  return {
    rows,
    httpStatus: Number(first.httpStatus) || 200,
    raw: first.json,
    pagination: {
      mode,
      reason,
      pagesFetched,
      complete: true,
      total: meta.reliable ? meta.total : rows.length,
      limit: meta.reliable ? meta.limit : null,
      reportedTotal: meta.reliable ? meta.total : null,
      metaReliable: meta.reliable === true,
    },
  };
}

/**
 * Live GET /v1/warranty rows. Codes are taken only from the response.
 * An empty list is the documented state for a vendor that has not created warranties.
 */
export function normalizeElryanWarrantyCatalog(rows, httpStatus = 0) {
  const items = [];
  const codes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.warranty_code || row?.warrantyCode || row?.code || "").trim();
    if (!code || codes.includes(code)) continue;
    codes.push(code);
    items.push({
      id: row?.id != null ? String(row.id) : "",
      code,
      name: String(row?.warranty_name || row?.warrantyName || row?.name || "").trim(),
      duration: suppliedWarrantyDuration(row),
      terms: suppliedWarrantyTerms(row),
      returnPolicy: suppliedScalar(row, ["return_policy", "returnPolicy"]),
      provider: suppliedScalar(row, ["warranted_provider", "warrantedProvider", "provider"]),
      detailsUrl: suppliedScalar(row, ["warranty_details_url", "warrantyDetailsUrl"]),
      status: suppliedWarrantyStatus(row),
    });
  }
  const empty = codes.length === 0;
  return {
    checked: true,
    httpStatus: Number(httpStatus) || 0,
    codes,
    items,
    empty,
    message: empty
      ? "WARRANTY_UNVERIFIED. GET /v1/warranty returned no warranty codes. The contract says a vendor with no warranties gets an empty list and vendors create their own. Product create describes warrantyCode as required, but the OpenAPI required array does not declare it. No warranty code was invented."
      : "",
  };
}

export function uncheckedWarrantyCatalog(message) {
  return {
    checked: false,
    httpStatus: 0,
    codes: [],
    items: [],
    empty: true,
    message:
      message ||
      "WARRANTY_UNVERIFIED. The warranty list was not confirmed against GET /v1/warranty. No warranty code was invented.",
  };
}

/** Keep missing_warranty_mapping when no code exists. Confirm a code only against the live list. */
export function warrantyBlockersFor({ code, catalog } = {}) {
  const normalized = String(code || "").trim();
  const blockers = [];
  if (!normalized) {
    blockers.push({
      code: "missing_warranty_mapping",
      status: ELRYAN_READINESS.MISSING_MAPPING,
      message: "No Elryan warranty code is mapped. No code was invented.",
    });
  }
  const codes = Array.isArray(catalog?.codes) ? catalog.codes.map((item) => String(item)) : [];
  const confirmed = catalog?.checked === true && Boolean(normalized) && codes.includes(normalized);
  if (!confirmed) {
    blockers.push({
      code: "warranty_unverified",
      status: ELRYAN_READINESS.WARRANTY_UNVERIFIED,
      message:
        catalog?.message ||
        "WARRANTY_UNVERIFIED. warrantyCode is described as required on create, but this code was not confirmed by GET /v1/warranty.",
    });
  }
  return blockers;
}
