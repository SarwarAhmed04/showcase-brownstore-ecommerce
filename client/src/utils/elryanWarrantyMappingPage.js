export const ELRYAN_WARRANTY_MAPPING_TAB = "elryanWarrantyMapping";

function haystack(values) {
  return values
    .filter((value) => value != null && value !== "")
    .join(" ")
    .toLowerCase();
}

/** Brand list search covers the brand, its Elryan brand mapping, and its current warranty. */
export function filterWarrantyBrands(brands, { q = "", status = "all" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (Array.isArray(brands) ? brands : []).filter((row) => {
    const mapped = Boolean(row?.warranty?.code);
    if (status === "mapped" && !mapped) return false;
    if (status === "unmapped" && mapped) return false;
    if (!needle) return true;
    return haystack([
      row?.brownLabel,
      row?.brownKey,
      row?.brandMapping?.elryanLabel,
      row?.brandMapping?.elryanId,
      row?.warranty?.label,
      row?.warranty?.code,
      row?.warranty?.id,
    ]).includes(needle);
  });
}

export function filterOfficialWarranties(items, q = "") {
  const needle = String(q || "").trim().toLowerCase();
  const rows = Array.isArray(items) ? items : [];
  if (!needle) return rows;
  return rows.filter((item) =>
    haystack([
      item?.name,
      item?.code,
      item?.id,
      item?.duration,
      item?.terms,
      item?.returnPolicy,
      item?.provider,
      item?.status,
    ]).includes(needle)
  );
}

/**
 * A brand-name search should not hide the official list when no warranty text matches.
 * A warranty search narrows the list to the matching official rows.
 */
export function officialWarrantiesForSearch(items, q = "") {
  const rows = Array.isArray(items) ? items : [];
  if (!String(q || "").trim()) return rows;
  const matched = filterOfficialWarranties(rows, q);
  return matched.length ? matched : rows;
}

export function sharedWarrantyCounts(brands) {
  const counts = new Map();
  for (const brand of Array.isArray(brands) ? brands : []) {
    const code = String(brand?.warranty?.code || "").trim();
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return counts;
}

export function warrantyReview({ brand, warranty } = {}) {
  if (!brand?.brownKey || !warranty?.code) return null;
  const current = String(brand.warranty?.code || "").trim();
  return {
    brownKey: String(brand.brownKey),
    brownLabel: String(brand.brownLabel || brand.brownKey),
    code: String(warranty.code),
    name: String(warranty.name || ""),
    id: String(warranty.id || ""),
    duration: warranty.duration ?? null,
    terms: warranty.terms ?? null,
    returnPolicy: warranty.returnPolicy ?? null,
    provider: warranty.provider ?? null,
    status: warranty.status ?? null,
    replaces: current && current !== warranty.code ? current : "",
  };
}

export function warrantySaveReady({
  brandId,
  code,
  confirmCoverage,
  needsOverwrite,
  confirmOverwrite,
  catalogOk,
} = {}) {
  if (!catalogOk || !String(brandId || "").trim() || !String(code || "").trim()) return false;
  if (confirmCoverage !== true) return false;
  if (needsOverwrite && confirmOverwrite !== true) return false;
  return true;
}
