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

export { formatElryanChildrenLoadError } from "./elryanErrorMessage.js";
