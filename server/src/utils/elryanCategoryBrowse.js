/**
 * Pure helpers for Elryan category hierarchy browsing (server-side / tests).
 * Mirrors client/src/utils/elryanCategoryBrowse.js selection rules.
 */

export function resolveElryanCategoryId(row) {
  if (!row || typeof row !== "object") return null;
  const id = row.id ?? row._id ?? row.categoryId;
  if (id == null || id === "") return null;
  return id;
}

/** @returns {"leaf"|"parent"|"unknown"} */
export function elryanCategoryParentKind(row) {
  if (!row || typeof row !== "object") return "unknown";
  if (row.isParent === true) return "parent";
  if (row.isParent === false) return "leaf";
  return "unknown";
}

/** Confirmed leaves skip the children request; missing isParent stays fetchable. */
export function shouldFetchElryanCategoryChildren(row) {
  return elryanCategoryParentKind(row) !== "leaf";
}

/** Empty, null, and 0 are not a real parent link. */
export function elryanCategoryParentKey(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text || text === "0") return "";
  return text;
}

export function elryanCatalogIdSet(categories) {
  const ids = new Set();
  for (const row of categories || []) {
    const id = row?.categoryId ?? row?.id ?? row?._id;
    if (id == null || id === "") continue;
    ids.add(String(id));
  }
  return ids;
}

/** A row is a browse root when its parent is missing from this catalog. */
export function isElryanCatalogRoot(row, ids) {
  const parent = elryanCategoryParentKey(row?.parentId);
  if (!parent) return true;
  return !(ids instanceof Set ? ids : elryanCatalogIdSet(ids)).has(parent);
}

/**
 * Page source for the category selector.
 * A search covers name, full path, and category ID across the whole list.
 * An empty query browses roots, or the children of parentId.
 */
export function filterElryanCatalogRows(rows, { q = "", leafOnly = false, parentId = "", roots = false } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const ids = elryanCatalogIdSet(all);
  let list = leafOnly ? all.filter((row) => row?.isParent === false) : all;
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    return list.filter((row) => {
      const id = row?.categoryId ?? row?.id ?? "";
      const name = row?.categoryName || row?.name || "";
      const path = row?.hierarchy || "";
      return `${id} ${name} ${path}`.toLowerCase().includes(needle);
    });
  }
  const parent = elryanCategoryParentKey(parentId);
  if (parent) {
    return list.filter((row) => elryanCategoryParentKey(row?.parentId) === parent);
  }
  if (roots) return list.filter((row) => isElryanCatalogRoot(row, ids));
  return list;
}

export function elryanCatalogBrowseScope({ q = "", parentId = "", roots = false } = {}) {
  if (String(q || "").trim()) return "search";
  if (elryanCategoryParentKey(parentId)) return "children";
  if (roots) return "roots";
  return "catalog";
}

export { formatElryanChildrenLoadError } from "./elryanErrorMessage.js";
