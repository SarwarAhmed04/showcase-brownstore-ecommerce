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

const DEFAULT_MAPPING_HINT =
  "Map each BrownStore brand to one official Elryan {environment} warranty. Several brands may share one warranty. Nothing is saved until you review and confirm.";
const DEFAULT_EMPTY_WARRANTY =
  "The {environment} API returned an empty warranty list. No warranty code was invented.";

export function warrantyEnvironmentLabel(environment) {
  return environment === "production" ? "Production" : environment === "staging" ? "Staging" : "";
}

/** Fill {environment}, or the older Staging wording, with the active account. */
export function withWarrantyEnvironment(template, environment) {
  const label = warrantyEnvironmentLabel(environment);
  const source = String(template || "");
  if (!label) return source;
  if (source.includes("{environment}")) return source.replaceAll("{environment}", label);
  return label === "Production" ? source.replaceAll("Staging", "Production") : source;
}

export function warrantyMappingDescription(environment, template = DEFAULT_MAPPING_HINT) {
  return withWarrantyEnvironment(template, environment);
}

export function warrantyEmptyDescription(environment, template = DEFAULT_EMPTY_WARRANTY) {
  return withWarrantyEnvironment(template, environment);
}

export function warrantyBrandSnapshot(brand) {
  if (!brand?.brownKey) return null;
  const code = String(brand.warranty?.code || "").trim();
  return {
    brownKey: String(brand.brownKey),
    brownLabel: String(brand.brownLabel || brand.brownKey),
    warranty: code
      ? {
          code,
          label: String(brand.warranty?.label || ""),
        }
      : null,
  };
}

export function toggleWarrantyBrand(selected, brand) {
  const snapshot = warrantyBrandSnapshot(brand);
  const next = new Map(selected instanceof Map ? selected : []);
  if (!snapshot) return next;
  if (next.has(snapshot.brownKey)) next.delete(snapshot.brownKey);
  else next.set(snapshot.brownKey, snapshot);
  return next;
}

/** Drop a brand from the current selection. Saved mappings are not part of this result. */
export function removeWarrantyBrand(selected, brownKey) {
  const next = new Map(selected instanceof Map ? selected : []);
  next.delete(String(brownKey || ""));
  return next;
}

/** Refresh brands that are on the current page without dropping selections from other searches or pages. */
export function mergeVisibleBrandSnapshots(selected, visibleBrands) {
  const next = new Map(selected instanceof Map ? selected : []);
  const visible = new Map(
    (Array.isArray(visibleBrands) ? visibleBrands : [])
      .map((brand) => warrantyBrandSnapshot(brand))
      .filter(Boolean)
      .map((brand) => [brand.brownKey, brand])
  );
  for (const [id, snapshot] of next) {
    if (visible.has(id)) next.set(id, visible.get(id) || snapshot);
  }
  return next;
}

export function warrantyBatchReview({ brands, warranty } = {}) {
  const code = String(warranty?.code || "").trim();
  const rows = (Array.isArray(brands) ? brands : []).map((brand) => warrantyBrandSnapshot(brand)).filter(Boolean);
  if (!code || !rows.length) return null;
  return {
    code,
    name: String(warranty.name || ""),
    id: String(warranty.id || ""),
    duration: warranty.duration ?? null,
    terms: warranty.terms ?? null,
    returnPolicy: warranty.returnPolicy ?? null,
    provider: warranty.provider ?? null,
    status: warranty.status ?? null,
    brands: rows.map((brand) => {
      const current = String(brand.warranty?.code || "").trim();
      return {
        brownKey: brand.brownKey,
        brownLabel: brand.brownLabel,
        replaces: current && current !== code ? current : "",
      };
    }),
  };
}

export function warrantySaveReady({
  brandIds,
  code,
  confirmCoverage,
  replacements,
  confirmOverwrite,
  catalogOk,
} = {}) {
  const ids = (Array.isArray(brandIds) ? brandIds : []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!catalogOk || !ids.length || !String(code || "").trim()) return false;
  if (confirmCoverage !== true) return false;
  const needsOverwrite = (Array.isArray(replacements) ? replacements : []).some((codeToReplace) =>
    String(codeToReplace || "").trim()
  );
  if (needsOverwrite && confirmOverwrite !== true) return false;
  return true;
}

export function warrantyReadBackVerified(readBack, { brownKey, code, environment } = {}) {
  if (readBack?.ok !== true) return false;
  if (String(readBack.elryanCode || "") !== String(code || "")) return false;
  if (readBack.warrantyScope && readBack.warrantyScope !== "brand") return false;
  if (environment && readBack.environment && String(readBack.environment) !== String(environment)) return false;
  const subject = String(brownKey || "").trim().toLowerCase();
  const stored = String(readBack.brownKey || "").trim().toLowerCase();
  if (!subject) return false;
  return stored === subject || stored.endsWith(`:brand:${subject}`);
}

const READ_BACK_FAILED = "The database read-back did not match the warranty you confirmed.";

/**
 * Save one official warranty onto each selected brand through the existing
 * single-brand save. A failure is recorded for that brand and the rest continue.
 */
export async function saveSelectedWarrantyBrands({
  brands,
  warrantyCode,
  environment,
  confirmOverwrite,
  save,
} = {}) {
  const code = String(warrantyCode || "").trim();
  const confirmed = [];
  const failed = [];
  for (const brand of Array.isArray(brands) ? brands : []) {
    const snapshot = warrantyBrandSnapshot(brand);
    if (!snapshot) continue;
    const current = String(snapshot.warranty?.code || "");
    const replaces = Boolean(current && current !== code);
    try {
      const result = await save({
        brownKey: snapshot.brownKey,
        elryanCode: code,
        environment,
        confirmCoverage: true,
        confirmOverwrite: replaces && confirmOverwrite === true,
      });
      if (warrantyReadBackVerified(result?.readBack, { brownKey: snapshot.brownKey, code, environment })) {
        confirmed.push({
          brownKey: snapshot.brownKey,
          brownLabel: snapshot.brownLabel,
          readBack: result.readBack,
        });
      } else {
        failed.push({
          brownKey: snapshot.brownKey,
          brownLabel: snapshot.brownLabel,
          message: READ_BACK_FAILED,
          code: "warranty_read_back_failed",
        });
      }
    } catch (err) {
      failed.push({
        brownKey: snapshot.brownKey,
        brownLabel: snapshot.brownLabel,
        message: err?.message || "Save failed",
        code: err?.code || "",
      });
    }
  }
  return {
    confirmed,
    failed,
    retryBrandIds: failed.map((row) => row.brownKey),
  };
}

export function mergeWarrantySaveOutcomes(previous, next) {
  const retried = new Set([
    ...(next?.confirmed || []).map((row) => row.brownKey),
    ...(next?.failed || []).map((row) => row.brownKey),
  ]);
  return {
    confirmed: [
      ...(previous?.confirmed || []).filter((row) => !retried.has(row.brownKey)),
      ...(next?.confirmed || []),
    ],
    failed: next?.failed || [],
    retryBrandIds: (next?.failed || []).map((row) => row.brownKey),
  };
}
