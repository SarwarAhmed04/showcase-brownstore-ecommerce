import { normalizeMiswagBrand, searchBrands } from "./miswag.js";

/**
 * Per-sync brand resolver with in-memory cache.
 * Exact normalized name/alias only — never fuzzy-picks a random brand.
 */

export function normalizeBrandKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’".,/\\|_+:;!?()[\]{}#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function brandLabelOf(product) {
  const brand = product?.brand;
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  if (typeof brand.name === "string") return brand.name;
  return brand.name?.en || brand.name?.ar || brand.name?.ku || "";
}

export function createBrandResolverCache() {
  return new Map();
}

function exactBrandMatch(candidates, key) {
  const matches = [];
  const seen = new Set();
  for (const raw of candidates || []) {
    const brand = normalizeMiswagBrand(raw);
    if (!brand || seen.has(brand.id)) continue;
    const name = normalizeBrandKey(brand.name);
    const alias = normalizeBrandKey(brand.alias);
    if (name !== key && alias !== key) continue;
    seen.add(brand.id);
    matches.push(brand);
  }
  if (matches.length === 1) return { ok: true, brand: matches[0] };
  if (matches.length > 1) return { ok: false, code: "brand_ambiguous" };
  return { ok: false, code: "brand_unresolved" };
}

export async function resolveMiswagBrandForProduct(product, cache = createBrandResolverCache()) {
  const label = brandLabelOf(product);
  const key = normalizeBrandKey(label);
  if (key.length < 2) {
    return {
      ok: false,
      reason: "Miswag brand could not be resolved safely",
      code: "brand_missing_name",
    };
  }
  if (cache.has(key)) return cache.get(key);

  let result;
  try {
    const response = await searchBrands(label, undefined, { retries: 1 });
    const content = Array.isArray(response.data?.content)
      ? response.data.content
      : Array.isArray(response.data)
        ? response.data
        : [];
    const match = exactBrandMatch(content, key);
    result = match.ok
      ? { ok: true, brand: match.brand, matchType: "exact" }
      : {
          ok: false,
          reason: "Miswag brand could not be resolved safely",
          code: match.code,
        };
  } catch (err) {
    result = {
      ok: false,
      reason: "Miswag brand could not be resolved safely",
      code: "brand_lookup_failed",
      error: err?.message || "",
    };
  }

  cache.set(key, result);
  return result;
}
