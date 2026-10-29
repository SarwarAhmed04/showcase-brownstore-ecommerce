export const FILTER_ID_FIELDS = [
  "vendorId",
  "brandId",
  "categoryId",
  "subCategoryId",
  "collectionId",
];

export const FILTER_REQUIRED_FIELDS = ["vendorId"];

// Only the target key uses this token. Optional ids are stored as null.
export const FILTER_WILDCARD = "_ALL_";

export const FILTER_REQUIRED_MESSAGE = "Select a vendor.";

export const FILTER_BRAND_BEFORE_CATEGORY_MESSAGE = "Select a brand before a category.";

export const FILTER_CATEGORY_BEFORE_SUB_MESSAGE = "Select a category before a sub-category.";

export const FILTER_COLLECTION_MESSAGE = "Select a sub-category before a collection.";

export function filterNoMatchMessage(ids) {
  if (ids?.collectionId) {
    return "No product matches this vendor, brand, category, sub-category, and collection.";
  }
  if (ids?.subCategoryId) {
    return "No product matches this vendor, brand, category, and sub-category.";
  }
  if (ids?.categoryId) {
    return "No product matches this vendor, brand, and category.";
  }
  if (ids?.brandId) {
    return "No product matches this vendor and brand.";
  }
  return "No product matches this vendor.";
}

export const FILTER_NO_MATCH_MESSAGE = filterNoMatchMessage({});

function cleanId(value) {
  if (value == null) return "";
  return String(value).trim();
}

export function readFilterIds(input) {
  return {
    vendorId: cleanId(input?.vendorId),
    brandId: cleanId(input?.brandId),
    categoryId: cleanId(input?.categoryId),
    subCategoryId: cleanId(input?.subCategoryId),
    collectionId: cleanId(input?.collectionId),
  };
}

export function filterIdsError(input) {
  const ids = readFilterIds(input);
  if (!ids.vendorId) return FILTER_REQUIRED_MESSAGE;
  if (ids.subCategoryId && !ids.categoryId) return FILTER_CATEGORY_BEFORE_SUB_MESSAGE;
  if (ids.collectionId && !ids.subCategoryId) return FILTER_COLLECTION_MESSAGE;
  return "";
}

export function normalizeFilterIds(input) {
  const ids = readFilterIds(input);
  if (filterIdsError(ids)) return null;
  return ids;
}

function filterKeyPart(value) {
  const text = cleanId(value);
  return encodeURIComponent(text || FILTER_WILDCARD);
}

// A full five-id path keeps the original encoded key. Empty optional levels use
// FILTER_WILDCARD so the three depths stay unique on partner + scope + targetId.
export function filterCommissionTargetId(ids) {
  const normalized = readFilterIds(ids);
  return [
    normalized.vendorId,
    normalized.brandId,
    normalized.categoryId,
    normalized.subCategoryId,
    normalized.collectionId,
  ]
    .map(filterKeyPart)
    .join("|");
}

export function filterSpecificity(input) {
  const ids = normalizeFilterIds(input);
  if (!ids) return 0;
  if (ids.collectionId) return 5;
  if (ids.subCategoryId) return 4;
  if (ids.categoryId) return 3;
  if (ids.brandId) return 2;
  return 1;
}
