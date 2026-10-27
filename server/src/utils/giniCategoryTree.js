/** Live GINI category tree helpers. IDs are authoritative. Nothing here matches by name. */

function mappingError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function isGiniActive(value) {
  return value === 1 || value === true || value === "1";
}

export function normalizeGiniCategories(json) {
  const rows = Array.isArray(json?.data) ? json.data : null;
  if (!rows) {
    return {
      ok: false,
      categories: [],
      topLevelCount: 0,
      message: "Category response was not a category tree.",
    };
  }
  const nested = rows.every(
    (row) => row == null || Array.isArray(row.subcategories) || row.subcategories == null
  );
  if (!nested) {
    return {
      ok: false,
      categories: [],
      topLevelCount: rows.length,
      message: "Category response was not a category tree.",
    };
  }
  const categories = [];
  for (const row of rows) {
    if (row == null || row.id == null || String(row.id).trim() === "") continue;
    const subs = Array.isArray(row.subcategories) ? row.subcategories : [];
    categories.push({
      id: row.id,
      name: String(row.name || ""),
      slug: String(row.slug || ""),
      isActive: isGiniActive(row.is_active),
      subcategories: subs
        .filter((sub) => sub != null && sub.id != null && String(sub.id).trim() !== "")
        .map((sub) => ({
          id: sub.id,
          name: String(sub.name || ""),
          slug: String(sub.slug || ""),
          isActive: isGiniActive(sub.is_active),
        })),
    });
  }
  return { ok: true, categories, topLevelCount: rows.length, message: "" };
}

export function giniMappingStatus(values, categories) {
  const categoryId = String(values?.categoryId || "").trim();
  const subcategoryId = String(values?.subcategoryId || "").trim();
  if (!categoryId && !subcategoryId) return "missing";
  const category = (categories || []).find((item) => String(item.id) === categoryId);
  if (!category) return "invalid";
  const subcategory = (category.subcategories || []).find((item) => String(item.id) === subcategoryId);
  if (!subcategory) return "invalid";
  if (!category.isActive || !subcategory.isActive) return "inactive";
  return "configured";
}

export function summarizeGiniStatuses(statuses, total = statuses.length) {
  const counts = { total, configured: 0, missing: 0, invalid: 0, inactive: 0 };
  for (const status of statuses) {
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  return counts;
}

export function categoryOptions(categories, selectedId) {
  const active = (categories || []).filter((category) => category.isActive);
  const id = String(selectedId || "").trim();
  if (!id || active.some((category) => String(category.id) === id)) return active;
  const saved = (categories || []).find((category) => String(category.id) === id);
  if (saved) return [...active, { ...saved, legacy: true }];
  return [...active, { id, name: id, slug: "", isActive: false, legacy: true, subcategories: [] }];
}

export function subcategoryOptions(categories, categoryId, selectedSubId) {
  const category = (categories || []).find((item) => String(item.id) === String(categoryId || "").trim());
  const subs = category?.subcategories || [];
  const active = subs.filter((sub) => sub.isActive);
  const id = String(selectedSubId || "").trim();
  if (!category || !id || active.some((sub) => String(sub.id) === id)) return active;
  const saved = subs.find((sub) => String(sub.id) === id);
  if (saved) return [...active, { ...saved, legacy: true }];
  return [...active, { id, name: id, slug: "", isActive: false, legacy: true }];
}

export function applyCategoryChange(categories, categoryId) {
  const id = String(categoryId || "").trim();
  const category = (categories || []).find((item) => String(item.id) === id);
  return {
    categoryId: id,
    categoryName: category?.name || "",
    subcategoryId: "",
    subcategoryName: "",
  };
}

export function applySubcategoryChange(categories, draft, subcategoryId) {
  const categoryId = String(draft?.categoryId || "").trim();
  const category = (categories || []).find((item) => String(item.id) === categoryId);
  const id = String(subcategoryId || "").trim();
  const subcategory = (category?.subcategories || []).find((item) => String(item.id) === id);
  return {
    categoryId,
    categoryName: category?.name || String(draft?.categoryName || ""),
    subcategoryId: id,
    subcategoryName: subcategory?.name || "",
  };
}

export function giniMappingValues(categories, input) {
  const source = input && typeof input === "object" ? input : {};
  const categoryId = String(source.categoryId || "").trim();
  const subcategoryId = String(source.subcategoryId || "").trim();
  if (!categoryId || !subcategoryId) {
    throw mappingError("GINI category and subcategory are required.");
  }
  const category = (categories || []).find((item) => String(item.id) === categoryId);
  const subcategory = category?.subcategories?.find((item) => String(item.id) === subcategoryId);
  if (!category || !subcategory) {
    throw mappingError("That GINI category or subcategory is not in the current category tree.");
  }
  if (!category.isActive || !subcategory.isActive) {
    throw mappingError("Inactive GINI categories cannot be saved.");
  }
  return {
    categoryId: String(category.id),
    categoryName: String(category.name || ""),
    subcategoryId: String(subcategory.id),
    subcategoryName: String(subcategory.name || ""),
  };
}
