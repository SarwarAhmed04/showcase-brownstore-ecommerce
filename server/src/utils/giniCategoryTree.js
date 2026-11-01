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

/** Stop following category pages after this many responses. */
export const GINI_CATEGORY_PAGE_LIMIT = 50;

function legacyChoice(id) {
  return { id, name: id, slug: "", isActive: false, legacy: true };
}

function withSavedChoice(items, selectedId, extra = {}) {
  const listed = (items || []).map((item) => ({ ...item }));
  const id = String(selectedId || "").trim();
  if (!id || listed.some((item) => String(item.id) === id)) return listed;
  return [...listed, { ...legacyChoice(id), ...extra }];
}

/**
 * Every category returned by the mapping API, in API order.
 * A saved id that is no longer in the tree stays visible as a legacy choice.
 */
export function categoryOptions(categories, selectedId) {
  return withSavedChoice(categories, selectedId, { subcategories: [] });
}

/**
 * Subcategories of one parent only, in API order, including inactive rows.
 * An unknown saved id is kept as a legacy choice and is not taken from another parent.
 */
export function subcategoryOptions(categories, categoryId, selectedSubId) {
  const category = (categories || []).find((item) => String(item.id) === String(categoryId || "").trim());
  if (!category) return withSavedChoice([], selectedSubId);
  return withSavedChoice(category.subcategories, selectedSubId);
}

/**
 * Legacy choices stay visible and cannot be newly selected.
 * Pass `locked` for a row that must not become a new mapping, such as an inactive subcategory.
 * The current value stays enabled so a previously saved mapping remains displayed.
 */
export function giniChoiceDisabled(option, selectedId, locked = false) {
  const current = String(selectedId || "").trim();
  if (current && String(option?.id ?? "") === current) return false;
  return Boolean(option?.legacy || locked);
}

/** Next relative query when a category payload says another page exists. */
export function giniCategoryNextQuery(json, page) {
  const current = Number(page) || 1;
  const last = Number(json?.meta?.last_page);
  if (Number.isInteger(last) && last > current) return `?page=${current + 1}`;
  if (typeof json?.links?.next === "string" && json.links.next.trim()) return `?page=${current + 1}`;
  return "";
}

/** Combine category pages. The first copy of an id wins. A single payload is unchanged. */
export function mergeGiniCategoryPayloads(payloads) {
  const list = Array.isArray(payloads) ? payloads : [];
  if (list.length <= 1) return list[0] ?? { data: [] };
  const seen = new Set();
  const data = [];
  for (const json of list) {
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const id = row?.id == null ? "" : String(row.id).trim();
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      data.push(row);
    }
  }
  return { data };
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
