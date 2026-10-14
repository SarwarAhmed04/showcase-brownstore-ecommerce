import { PlatformBrandMapping } from "../models/PlatformBrandMapping.js";
import { MISWAG_PARTNER, isAllowedMiswagUrl, searchBrands } from "./miswag.js";

const UNMAPPED_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SEARCH_PAGES = 5;
const inflight = new Map();

export function normalizeBrandName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’".,/\\|_+:;!?()[\]{}#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function brandLabel(brand) {
  if (!brand) return "";
  if (typeof brand === "string") return brand;
  if (typeof brand.name === "string") return brand.name;
  return brand.name?.en || brand.name?.ar || brand.name?.ku || "";
}

function brandBrownId(brand) {
  if (!brand || typeof brand !== "object") return "";
  return String(brand._id || brand.id || "").trim();
}

function exactBrand(candidates, normalized) {
  const matches = [];
  const seen = new Set();
  for (const brand of candidates) {
    const id = Number(brand?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    const name = normalizeBrandName(brand.name);
    const alias = normalizeBrandName(brand.alias);
    if (name !== normalized && alias !== normalized) continue;
    seen.add(id);
    matches.push(brand);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function searchExactBrand(query, normalized) {
  let url = "";
  const candidates = [];
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const response = await searchBrands(query, url || undefined);
    const content = Array.isArray(response.data?.content) ? response.data.content : [];
    candidates.push(...content);
    const match = exactBrand(candidates, normalized);
    if (match) return match;
    const next = response.data?.paging?.next_url || "";
    if (!next || !isAllowedMiswagUrl(next)) break;
    url = String(next);
  }
  return exactBrand(candidates, normalized);
}

async function remember(normalized, brownBrandId, match) {
  const fields = match
    ? {
        brownBrandId,
        externalBrandId: Number(match.id),
        externalName: String(match.name || ""),
        externalAlias: String(match.alias || ""),
        status: "mapped",
        lastCheckedAt: new Date(),
      }
    : {
        brownBrandId,
        externalBrandId: null,
        externalName: "",
        externalAlias: "",
        status: "unmapped",
        lastCheckedAt: new Date(),
      };
  await PlatformBrandMapping.findOneAndUpdate(
    { partner: MISWAG_PARTNER, normalizedName: normalized },
    { $set: fields, $setOnInsert: { partner: MISWAG_PARTNER, normalizedName: normalized } },
    { upsert: true }
  );
  return match
    ? { id: Number(match.id), name: String(match.name || "") }
    : null;
}

async function resolveOne(brand) {
  const label = brandLabel(brand);
  const normalized = normalizeBrandName(label);
  if (normalized.length < 2) return null;
  const brownBrandId = brandBrownId(brand);
  const cached = await PlatformBrandMapping.findOne({ partner: MISWAG_PARTNER, normalizedName: normalized }).lean();
  if (cached?.status === "mapped" && Number.isInteger(cached.externalBrandId)) {
    return { id: cached.externalBrandId, name: cached.externalName || label };
  }
  if (cached?.status === "unmapped" && cached.lastCheckedAt) {
    const age = Date.now() - new Date(cached.lastCheckedAt).getTime();
    if (age >= 0 && age < UNMAPPED_TTL_MS) return null;
  }
  if (inflight.has(normalized)) return inflight.get(normalized);
  const pending = searchExactBrand(label, normalized)
    .then((match) => remember(normalized, brownBrandId, match))
    .catch((err) => {
      console.warn("Miswag brand lookup skipped:", err.message);
      return null;
    })
    .finally(() => {
      inflight.delete(normalized);
    });
  inflight.set(normalized, pending);
  return pending;
}

export async function resolveMiswagBrands(brands) {
  const unique = new Map();
  for (const brand of brands || []) {
    const normalized = normalizeBrandName(brandLabel(brand));
    if (normalized.length < 2 || unique.has(normalized)) continue;
    unique.set(normalized, brand);
  }
  const resolved = new Map();
  await Promise.all([...unique.entries()].map(async ([normalized, brand]) => {
    resolved.set(normalized, await resolveOne(brand));
  }));
  return resolved;
}
