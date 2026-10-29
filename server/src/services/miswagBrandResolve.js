import { normalizeMiswagBrand, searchBrands } from "./miswag.js";
import {
  findMiswagBrandMapping,
  rememberAutoBrandMapping,
} from "./miswagValueMapping.js";

/**
 * Per-sync brand resolver with in-memory cache.
 * Priority: saved manual mapping → saved auto mapping → exact live search.
 * Never fuzzy-picks a random brand. Never overwrites manual mappings.
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

export function brandIdOf(product) {
  const brand = product?.brand;
  if (!brand) return "";
  return String(brand._id || brand.id || "").trim();
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

function fromSavedMapping(mapping) {
  if (!mapping?.miswagId) return null;
  const id = Number(mapping.miswagId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    ok: true,
    brand: {
      id,
      name: mapping.miswagLabel || mapping.brownLabel || String(id),
    },
    matchType: mapping.mode === "manual" ? "manual_mapping" : "auto_mapping",
    source: mapping.mode === "manual" ? "manual_mapping" : "auto_mapping",
  };
}

function lookupFromMap(product, mappingMap) {
  if (!mappingMap) return null;
  const id = brandIdOf(product);
  if (id && mappingMap.has(id)) return fromSavedMapping(mappingMap.get(id));
  const nameKey = normalizeBrandKey(brandLabelOf(product));
  if (nameKey && mappingMap.has(`name:${nameKey}`)) {
    return fromSavedMapping(mappingMap.get(`name:${nameKey}`));
  }
  if (nameKey && mappingMap.has(nameKey)) return fromSavedMapping(mappingMap.get(nameKey));
  return null;
}

async function lookupSavedBrand(product, mappingMap = null) {
  const fromMap = lookupFromMap(product, mappingMap);
  if (fromMap) return fromMap;

  const id = brandIdOf(product);
  if (id) {
    const byId = await findMiswagBrandMapping(id);
    const resolved = fromSavedMapping(byId);
    if (resolved) return resolved;
  }
  const label = brandLabelOf(product);
  const nameKey = normalizeBrandKey(label);
  if (nameKey) {
    const byNameKey = await findMiswagBrandMapping(nameKey);
    const resolvedKey = fromSavedMapping(byNameKey);
    if (resolvedKey) return resolvedKey;
  }
  return null;
}

export async function resolveMiswagBrandForProduct(
  product,
  cache = createBrandResolverCache(),
  mappingMap = null
) {
  const label = brandLabelOf(product);
  const key = normalizeBrandKey(label);
  const brownId = brandIdOf(product);

  // Accept cache hits by brand id or normalized name (tests + Sync All share both styles).
  if (brownId && cache.has(brownId)) return cache.get(brownId);
  if (key && cache.has(key)) return cache.get(key);

  function remember(result) {
    if (brownId) cache.set(brownId, result);
    if (key) cache.set(key, result);
    return result;
  }

  if (key.length < 2 && !brownId) {
    return remember({
      ok: false,
      reason: "Miswag brand could not be resolved safely",
      code: "brand_missing_name",
    });
  }

  try {
    const saved = await lookupSavedBrand(product, mappingMap);
    if (saved) return remember(saved);
  } catch {
    // Mapping DB failure should not abort sync; fall through to live search.
  }

  let result;
  try {
    const response = await searchBrands(label, undefined, { retries: 1 });
    const content = Array.isArray(response.data?.content)
      ? response.data.content
      : Array.isArray(response.data)
        ? response.data
        : [];
    const match = exactBrandMatch(content, key);
    if (match.ok) {
      result = {
        ok: true,
        brand: match.brand,
        matchType: "exact",
        source: "live_search",
      };
      // Remember exact auto match under brand id when available (never overwrites manual).
      if (brownId) {
        try {
          await rememberAutoBrandMapping({
            brownKey: brownId,
            brownLabel: label || brownId,
            miswagId: match.brand.id,
            miswagLabel: match.brand.name,
          });
        } catch {
          // Persistence failure is non-fatal.
        }
      }
    } else {
      result = {
        ok: false,
        reason: "Miswag brand could not be resolved safely",
        code: match.code,
      };
    }
  } catch (err) {
    result = {
      ok: false,
      reason: "Miswag brand could not be resolved safely",
      code: "brand_lookup_failed",
      error: err?.message || "",
    };
  }

  return remember(result);
}
