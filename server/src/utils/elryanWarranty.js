import { ELRYAN_READINESS } from "./elryanConstants.js";

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
