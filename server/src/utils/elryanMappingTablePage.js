/** Page size for the Elryan admin mapping tables. Omitted paging returns every row. */

export function normalizeElryanMappingLimit(limit) {
  return Number(limit) === 50 ? 50 : 25;
}

export function paginateElryanMappingRows(rows, { page, limit } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const requested = page != null || limit != null;
  const size = requested ? normalizeElryanMappingLimit(limit) : Math.max(total, 1);
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const requestedPage = Math.max(1, Number(page) || 1);
  const current = Math.min(requestedPage, pages);
  const start = requested ? (current - 1) * size : 0;
  const slice = requested ? list.slice(start, start + size) : list.slice();
  return {
    rows: slice,
    page: current,
    limit: requested ? size : total,
    total,
    pages,
    hasMore: start + slice.length < total,
  };
}

function text(value) {
  return String(value || "");
}

/** Label order, then id, so equal labels cannot trade places between pages. */
export function compareMappingLabel(leftLabel, leftId, rightLabel, rightId) {
  const label = text(leftLabel).localeCompare(text(rightLabel), undefined, { sensitivity: "base" });
  if (label) return label;
  return text(leftId).localeCompare(text(rightId));
}

function namePart(name, key) {
  if (!name || typeof name === "string") return key === "en" ? text(name) : "";
  return text(name[key]);
}

/** Same name order as collection discovery, with the collection id as the tie-break. */
export function compareBrownCollection(left, right) {
  const en = namePart(left?.brownCollectionName, "en").localeCompare(namePart(right?.brownCollectionName, "en"));
  if (en) return en;
  const ku = namePart(left?.brownCollectionName, "ku").localeCompare(namePart(right?.brownCollectionName, "ku"));
  if (ku) return ku;
  const ar = namePart(left?.brownCollectionName, "ar").localeCompare(namePart(right?.brownCollectionName, "ar"));
  if (ar) return ar;
  return text(left?.brownCollectionId).localeCompare(text(right?.brownCollectionId));
}
