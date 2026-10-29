export const FILTER_FIELDS = [
  "vendorId",
  "brandId",
  "categoryId",
  "subCategoryId",
  "collectionId",
];

const CHILDREN = {
  vendorId: ["brandId", "categoryId", "subCategoryId", "collectionId"],
  brandId: ["categoryId", "subCategoryId", "collectionId"],
  categoryId: ["subCategoryId", "collectionId"],
  subCategoryId: ["collectionId"],
  collectionId: [],
};

const CHILD_LEVELS = {
  vendorId: ["brands", "categories", "subcategories", "collections"],
  brandId: ["categories", "subcategories", "collections"],
  categoryId: ["subcategories", "collections"],
  subCategoryId: ["collections"],
  collectionId: [],
};

export function emptyFilterSelection() {
  return {
    vendorId: "",
    brandId: "",
    categoryId: "",
    subCategoryId: "",
    collectionId: "",
  };
}

export function emptyFilterOptions() {
  return {
    brands: [],
    categories: [],
    subcategories: [],
    collections: [],
  };
}

export function applyFilterChange(selection, field, value) {
  const current = String(selection?.[field] || "");
  const nextValue = String(value || "");
  if (current === nextValue) return selection;
  const next = { ...emptyFilterSelection(), ...selection, [field]: nextValue };
  for (const child of CHILDREN[field] || []) next[child] = "";
  return next;
}

export function clearChildOptions(options, field) {
  const next = { ...emptyFilterOptions(), ...(options || {}) };
  for (const level of CHILD_LEVELS[field] || []) next[level] = [];
  return next;
}

export function staleOptionLevels(field, fetchLevel) {
  const keep = new Set(
    Array.isArray(fetchLevel) ? fetchLevel.filter(Boolean) : fetchLevel ? [fetchLevel] : []
  );
  return (CHILD_LEVELS[field] || []).filter((level) => !keep.has(level));
}

export function filterSelectionIssue(selection) {
  const vendorId = String(selection?.vendorId || "").trim();
  const categoryId = String(selection?.categoryId || "").trim();
  const subCategoryId = String(selection?.subCategoryId || "").trim();
  const collectionId = String(selection?.collectionId || "").trim();
  if (!vendorId) return "required";
  if (subCategoryId && !categoryId) return "category";
  if (collectionId && !subCategoryId) return "collection";
  return "";
}

export function filterSelectionComplete(selection) {
  return filterSelectionIssue(selection) === "";
}

export function filterFieldsEnabled(selection) {
  const vendorId = String(selection?.vendorId || "");
  const categoryId = String(selection?.categoryId || "");
  const subCategoryId = String(selection?.subCategoryId || "");
  return {
    vendor: true,
    brand: Boolean(vendorId),
    category: Boolean(vendorId),
    subCategory: Boolean(vendorId && categoryId),
    collection: Boolean(vendorId && categoryId && subCategoryId),
  };
}

export function filterPreviewParams(selection) {
  const params = {};
  if (selection?.vendorId) params.vendor = selection.vendorId;
  if (selection?.brandId) params.brand = selection.brandId;
  if (selection?.categoryId) params.category = selection.categoryId;
  if (selection?.subCategoryId) params.subCategory = selection.subCategoryId;
  if (selection?.collectionId) params.collection = selection.collectionId;
  return params;
}

export function filterOptionsLevel(query) {
  if (
    query?.level === "categories" &&
    query?.vendorId &&
    !query?.categoryId &&
    !query?.subCategoryId
  ) {
    return "categories";
  }
  if (query?.subCategoryId) return "collections";
  if (query?.categoryId) return "subcategories";
  if (query?.brandId) return "categories";
  if (query?.vendorId) return "brands";
  return "vendors";
}

export function filterOptionsQueryForChange(selection, field) {
  const vendorId = String(selection?.vendorId || "");
  const brandId = String(selection?.brandId || "");
  const categoryId = String(selection?.categoryId || "");
  const subCategoryId = String(selection?.subCategoryId || "");
  if (field === "vendorId") return vendorId ? { vendorId } : null;
  if (field === "brandId") {
    if (!vendorId) return null;
    return brandId ? { vendorId, brandId } : { vendorId, level: "categories" };
  }
  if (field === "categoryId") {
    if (!vendorId || !categoryId) return null;
    return brandId ? { vendorId, brandId, categoryId } : { vendorId, categoryId };
  }
  if (field === "subCategoryId") {
    if (!vendorId || !categoryId || !subCategoryId) return null;
    return brandId
      ? { vendorId, brandId, categoryId, subCategoryId }
      : { vendorId, categoryId, subCategoryId };
  }
  return null;
}

export function filterOptionQueriesForChange(selection, field) {
  const query = filterOptionsQueryForChange(selection, field);
  const queries = query ? [query] : [];
  if (field === "vendorId" && String(selection?.vendorId || "")) {
    queries.push({ vendorId: String(selection.vendorId), level: "categories" });
  }
  return queries;
}

export function selectionFromCommission(rule) {
  if (!rule || rule.scope !== "filter") return null;
  const subCategoryId = String(rule.subCategoryId || "").trim();
  return {
    vendorId: String(rule.vendorId || "").trim(),
    brandId: String(rule.brandId || "").trim(),
    categoryId: String(rule.categoryId || "").trim(),
    subCategoryId,
    collectionId: subCategoryId ? String(rule.collectionId || "").trim() : "",
  };
}

export function filterPathParts(rule) {
  const path = rule?.filterPath || {};
  return [
    { key: "vendor", name: path.vendor, id: rule?.vendorId || "" },
    { key: "brand", name: path.brand, id: rule?.brandId || "" },
    { key: "category", name: path.category, id: rule?.categoryId || "" },
    { key: "subCategory", name: path.subCategory, id: rule?.subCategoryId || "" },
    { key: "collection", name: path.collection, id: rule?.collectionId || "" },
  ];
}

export function ensureOption(list, id, name) {
  const items = Array.isArray(list) ? [...list] : [];
  const value = String(id || "").trim();
  if (!value) return items;
  if (items.some((item) => String(item?.id) === value)) return items;
  return [
    {
      id: value,
      name: name || { en: value, ku: value, ar: value },
      products: 0,
    },
    ...items,
  ];
}
