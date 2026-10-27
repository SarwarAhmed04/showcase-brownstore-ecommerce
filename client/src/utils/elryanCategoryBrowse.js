/**
 * Pure helpers for Elryan category hierarchy browsing.
 * Uses documented category fields: id, isParent, name, hierarchy, level, parentId.
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

export function elryanCategoryDisplayName(row) {
  if (!row || typeof row !== "object") return "";
  return String(row.name || row.Name || row.title || "").trim();
}

export function formatElryanChildrenLoadError({
  kind,
  categoryId,
  status,
  code,
  message,
} = {}) {
  const idLabel = categoryId != null && categoryId !== "" ? String(categoryId) : "unknown";
  const errCode = String(code || "").trim() || "NOT_FOUND";
  if (kind === "parent" && Number(status) === 404) {
    return (
      `Category children returned ${errCode} for parent category ${idLabel}. ` +
      "This may be an API or data inconsistency."
    );
  }
  return String(message || "").trim() || `Failed to load category children (${status || "error"})`;
}
