import crypto from "node:crypto";

/**
 * Marketplace v1 PATCH /v1/products/{id} packed size fields.
 * The contract types them as numbers with exclusiveMinimum 0 and describes them as
 * packed width, height, and depth. It has no unit property and no millimetre alias.
 * Confirmed BrownStore values are centimetres and are sent as those numbers.
 */
export const ELRYAN_PACKAGE_DIMENSION_FIELDS = Object.freeze(["width", "height", "depth"]);
export const ELRYAN_PACKAGE_DIMENSION_UNIT = "cm";
export const ELRYAN_PRODUCT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
export const ELRYAN_DIMENSION_UPDATE_ACTION = "production_dimension_update";

export function elryanProductIdValid(id) {
  return ELRYAN_PRODUCT_ID_PATTERN.test(String(id || "").trim());
}

export function reviewedElryanDimensions(product) {
  const source = product && typeof product === "object" ? product : {};
  const current = {};
  for (const field of ELRYAN_PACKAGE_DIMENSION_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(source, field);
    const value = present ? Number(source[field]) : NaN;
    current[field] = Number.isFinite(value) ? value : null;
  }
  return current;
}

/** Stable binding for one dimension-update preview. Key order is part of the token. */
export function elryanDimensionUpdateBinding({ listingId, current, patch } = {}) {
  const proposedPatch = {};
  for (const field of ELRYAN_PACKAGE_DIMENSION_FIELDS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
      proposedPatch[field] = Number(patch[field]);
    }
  }
  return {
    action: ELRYAN_DIMENSION_UPDATE_ACTION,
    listingId: String(listingId || "").trim(),
    current: reviewedElryanDimensions(current),
    patch: proposedPatch,
    unit: ELRYAN_PACKAGE_DIMENSION_UNIT,
  };
}

export function hashElryanDimensionUpdateBinding(binding) {
  return crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

function productRecord(json) {
  const body = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
  const product = data.product && typeof data.product === "object" && !Array.isArray(data.product) ? data.product : data;
  return product;
}

export function elryanListingIdentity(json) {
  const product = productRecord(json);
  return {
    id: String(product.id || product._id || product.productId || "").trim(),
    sku: String(product.sku || "").trim(),
    product,
  };
}

function numericSame(current, proposed) {
  const left = Number(current);
  const right = Number(proposed);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

function sameValue(field, current, proposed) {
  if (ELRYAN_PACKAGE_DIMENSION_FIELDS.includes(field) || field === "price" || field === "quantity") {
    if (proposed == null || proposed === "") return current == null || current === "";
    return numericSame(current, proposed);
  }
  return String(current ?? "") === String(proposed ?? "");
}

/**
 * Side-by-side values using the listing's own field names.
 * A dimension can be updated only when that API field is present and the confirmed value differs.
 */
export function compareElryanListing({ listing, proposed, dimensionsConfirmed = false } = {}) {
  const product = listing && typeof listing === "object" ? listing : {};
  const next = proposed && typeof proposed === "object" ? proposed : {};
  const displayFields = [
    "sku",
    "price",
    "quantity",
    "categoryId",
    "brandId",
    "colorId",
    "warrantyCode",
    ...ELRYAN_PACKAGE_DIMENSION_FIELDS,
  ];
  const rows = displayFields.map((field) => {
    const presentOnListing = Object.prototype.hasOwnProperty.call(product, field);
    const current = presentOnListing ? product[field] : null;
    const proposedValue = next[field] == null || next[field] === "" ? null : next[field];
    return {
      field,
      apiField: field,
      current,
      proposed: proposedValue,
      presentOnListing,
      differs: presentOnListing && !sameValue(field, current, proposedValue),
      writable: false,
    };
  });
  const missingApiFields = ELRYAN_PACKAGE_DIMENSION_FIELDS.filter(
    (field) => !Object.prototype.hasOwnProperty.call(product, field)
  );
  const dimensionPatch = {};
  if (dimensionsConfirmed && missingApiFields.length === 0) {
    for (const field of ELRYAN_PACKAGE_DIMENSION_FIELDS) {
      const row = rows.find((item) => item.field === field);
      if (!row?.differs) continue;
      dimensionPatch[field] = Number(row.proposed);
      row.writable = true;
    }
  }
  return {
    rows,
    dimensionApiFields: [...ELRYAN_PACKAGE_DIMENSION_FIELDS],
    missingApiFields,
    dimensionPatch,
    updateAllowed: Object.keys(dimensionPatch).length > 0,
  };
}
