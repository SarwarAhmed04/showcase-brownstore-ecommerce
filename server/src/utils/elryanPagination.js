/**
 * Extract OpenAPI list pagination meta from Elryan responses.
 * Documented fields: meta.page, meta.limit, meta.total, meta.timestamp.
 * OpenAPI notes page index may start at 0; query default remains 1 — callers must
 * use the same page value they requested and trust meta.total when present.
 */

export function extractElryanListMeta(payload) {
  const meta = payload && typeof payload === "object" ? payload.meta : null;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {
      present: false,
      page: null,
      limit: null,
      total: null,
      timestamp: null,
      reliable: false,
      reason: "meta_absent",
    };
  }
  const page = meta.page != null && meta.page !== "" ? Number(meta.page) : null;
  const limit = meta.limit != null && meta.limit !== "" ? Number(meta.limit) : null;
  const total = meta.total != null && meta.total !== "" ? Number(meta.total) : null;
  const timestamp = meta.timestamp != null ? String(meta.timestamp) : null;
  const pageOk = Number.isFinite(page);
  const limitOk = Number.isFinite(limit) && limit > 0;
  const totalOk = Number.isFinite(total) && total >= 0;
  const reliable = pageOk && limitOk && totalOk;
  return {
    present: true,
    page: pageOk ? page : null,
    limit: limitOk ? limit : null,
    total: totalOk ? total : null,
    timestamp,
    reliable,
    reason: reliable ? "ok" : "meta_incomplete",
  };
}

export function elryanTotalPages(meta) {
  if (!meta?.reliable || !meta.limit) return null;
  return Math.max(1, Math.ceil(meta.total / meta.limit));
}

export function categoryFingerprint(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.id ?? row?._id ?? ""))
    .filter(Boolean)
    .join(",");
}

export function normalizeCategoryRecord(row) {
  if (!row || typeof row !== "object") return null;
  const id = row.id ?? row._id ?? row.categoryId;
  if (id == null || id === "") return null;
  return {
    id: typeof id === "number" ? id : Number(id) || id,
    name: String(row.name || row.Name || "").trim(),
    parentId: row.parentId != null ? row.parentId : null,
    isParent: row.isParent === true ? true : row.isParent === false ? false : null,
    level: row.level != null && row.level !== "" ? Number(row.level) : null,
    attributeSet: row.attributeSet != null ? String(row.attributeSet) : "",
    attributeSetId: row.attributeSetId != null ? row.attributeSetId : null,
    hierarchy: row.hierarchy != null ? String(row.hierarchy) : "",
  };
}
