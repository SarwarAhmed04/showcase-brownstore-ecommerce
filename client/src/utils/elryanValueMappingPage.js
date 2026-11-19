/** Brand and colour mapping pages. Picking a value does not save it. */

export const ELRYAN_BRAND_MAPPING_TAB = "elryanBrandMapping";
export const ELRYAN_COLOUR_MAPPING_TAB = "elryanColourMapping";

/** The retired combined brand/colour/warranty screen opens Brand Mapping. */
export const ELRYAN_LEGACY_VALUE_MAPPING_TAB = "elryanAttributes";

export function elryanValueAttribute(kind) {
  return kind === "color" ? "Color" : "Brand";
}

/**
 * Status for one Brown Store row.
 * A failed save stays on that row until the admin changes the selection.
 * A saved id that still matches the selection is Confirmed, including after reload.
 */
export function elryanValueRowStatus({ savedId = "", draftId = "", saveError = "" } = {}) {
  const saved = String(savedId || "").trim();
  const draft = String(draftId || "").trim();
  const error = String(saveError || "").trim();
  if (error) return { kind: "error", message: error };
  if (draft !== saved) return { kind: "unsaved" };
  if (saved) return { kind: "confirmed" };
  return { kind: "empty" };
}

/** Search results come from the verified catalog, so later pages stay reachable. */
export function elryanCatalogPageWindow({ page = 1, limit = 30, total = 0 } = {}) {
  const current = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(limit) || 30);
  const count = Math.max(0, Number(total) || 0);
  return {
    page: current,
    limit: size,
    total: count,
    hasPrevious: current > 1,
    hasNext: current * size < count,
  };
}

export function filterElryanValueRows(rows, query = "") {
  const needle = String(query || "").trim().toLowerCase();
  const list = Array.isArray(rows) ? rows : [];
  if (!needle) return list;
  return list.filter((row) =>
    `${row?.brownLabel || ""} ${row?.brownKey || ""} ${row?.mapping?.elryanLabel || ""} ${row?.mapping?.elryanId || ""}`
      .toLowerCase()
      .includes(needle)
  );
}

/**
 * Keep an in-progress selection when another row is saved.
 * A row whose selection matches the server copy is replaced by that copy.
 */
export function mergeElryanValueDrafts(current, rows) {
  const next = { ...(current || {}) };
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.brownKey || "");
    if (!key) continue;
    const savedId = String(row?.mapping?.elryanId || "");
    const savedLabel = String(row?.mapping?.elryanLabel || "");
    const previous = current?.[key];
    const edited = previous && String(previous.elryanId || "") !== String(previous.baseId || "");
    if (edited && String(previous.elryanId || "") !== savedId) {
      next[key] = { ...previous, baseId: savedId, baseLabel: savedLabel };
    } else {
      next[key] = {
        elryanId: savedId,
        elryanLabel: savedLabel,
        baseId: savedId,
        baseLabel: savedLabel,
        saveError: "",
      };
    }
  }
  return next;
}
