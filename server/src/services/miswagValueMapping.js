import { MiswagValueMapping } from "../models/MiswagValueMapping.js";
import { Product } from "../models/Product.js";
import {
  MISWAG_VERIFIED_COLOR_MAP,
  isMiswagColorHex,
  normalizeMiswagColorKey,
  normalizeMiswagHex,
  readOriginalMiswagColorName,
  readStoredProductHex,
} from "./miswagColorMap.js";

/**
 * Miswag brand and color mapping helpers.
 * Color resolution never writes rows and never rewrites BrownStore product colors.
 * Historical kind="color" rows are read and updated only when an admin saves or resets one key.
 */

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function normalizeBrandNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’".,/\\|_+:;!?()[\]{}#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localizedBrandName(name) {
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  return String(name.en || name.ar || name.ku || "").trim();
}

export async function listMiswagValueMappings(kind) {
  const filter = kind ? { kind: String(kind) } : {};
  return MiswagValueMapping.find(filter).sort({ kind: 1, brownKey: 1 }).lean();
}

export async function findMiswagBrandMapping(brownKey) {
  const key = normalizeKey(brownKey);
  if (!key) return null;
  return MiswagValueMapping.findOne({ kind: "brand", brownKey: key }).lean();
}

export async function findMiswagColorMapping(colorKey) {
  const key = normalizeMiswagColorKey(colorKey);
  if (!key) return null;
  return MiswagValueMapping.findOne({ kind: "color", brownKey: key }).lean();
}

export async function loadMiswagBrandMappingMap() {
  const rows = await MiswagValueMapping.find({ kind: "brand" }).lean();
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(String(row.brownKey), row);
    const nameKey = normalizeBrandNameKey(row.brownLabel || "");
    if (nameKey) byKey.set(`name:${nameKey}`, row);
  }
  return byKey;
}

export async function loadMiswagColorMappingMap() {
  const rows = await MiswagValueMapping.find({ kind: "color" }).lean();
  const byKey = new Map();
  for (const row of rows) {
    const key = normalizeMiswagColorKey(row.brownKey);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (row.mode === "manual" && prev.mode !== "manual")) byKey.set(key, row);
  }
  return byKey;
}

/**
 * Save a manual brand or color mapping. Never deletes other rows.
 * Overwrites auto or prior manual for the same brownKey only.
 */
export async function upsertMiswagValueMapping(input = {}) {
  const kind = String(input.kind || "").trim();
  if (!["brand", "color"].includes(kind)) {
    const error = new Error("kind must be brand or color");
    error.status = 400;
    error.code = "invalid_kind";
    throw error;
  }

  let brownKey = normalizeKey(input.brownKey);
  if (kind === "color") brownKey = normalizeMiswagColorKey(brownKey);
  if (!brownKey) {
    const error = new Error("brownKey is required");
    error.status = 400;
    error.code = "brown_key_required";
    throw error;
  }

  const brownLabel = normalizeKey(input.brownLabel) || brownKey;
  const mode = String(input.mode || "manual").trim() === "auto" ? "auto" : "manual";

  if (kind === "brand") {
    const miswagId = normalizeKey(input.miswagId);
    const brandId = Number(miswagId);
    if (!Number.isInteger(brandId) || brandId <= 0) {
      const error = new Error("Valid Miswag brand id is required");
      error.status = 400;
      error.code = "invalid_brand_id";
      throw error;
    }
    return MiswagValueMapping.findOneAndUpdate(
      { kind, brownKey },
      {
        $set: {
          brownLabel,
          miswagId: String(brandId),
          miswagLabel: normalizeKey(input.miswagLabel),
          hex: "",
          mode,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }

  const hex = normalizeMiswagHex(input.hex);
  if (!isMiswagColorHex(hex)) {
    const error = new Error("Valid HEX color is required (#RRGGBB)");
    error.status = 400;
    error.code = "invalid_hex";
    throw error;
  }
  if (isMiswagColorHex(normalizeMiswagHex(brownLabel)) && String(brownLabel).trim().startsWith("#")) {
    const error = new Error("Color name cannot be a HEX code");
    error.status = 400;
    error.code = "color_name_is_hex";
    throw error;
  }

  return MiswagValueMapping.findOneAndUpdate(
    { kind, brownKey },
    {
      $set: {
        brownLabel,
        miswagId: "",
        miswagLabel: brownLabel,
        hex,
        mode,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

/**
 * Persist an automatic brand match only when no manual mapping exists for that key.
 */
export async function rememberAutoBrandMapping({ brownKey, brownLabel, miswagId, miswagLabel }) {
  const key = normalizeKey(brownKey);
  if (!key) return null;
  const existing = await MiswagValueMapping.findOne({ kind: "brand", brownKey: key }).lean();
  if (existing?.mode === "manual") return existing;
  return upsertMiswagValueMapping({
    kind: "brand",
    brownKey: key,
    brownLabel: brownLabel || key,
    miswagId,
    miswagLabel,
    mode: "auto",
  });
}

/**
 * Remove one brand or color mapping so automatic matching can apply again.
 * Does not touch BrownStore products or any other mapping row.
 */
export async function resetMiswagValueMapping(kind, brownKey) {
  const key = kind === "color" ? normalizeMiswagColorKey(brownKey) : normalizeKey(brownKey);
  await MiswagValueMapping.deleteOne({ kind, brownKey: key });
  return { ok: true };
}

function paginate(rows, page, limit) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.min(Math.max(1, page), pages);
  return {
    rows: rows.slice((safePage - 1) * limit, safePage * limit),
    pagination: { page: safePage, limit, total, pages },
  };
}

function statusOf(mapping) {
  if (!mapping) return "needs_review";
  if (mapping.mode === "manual") return "manual";
  return "auto";
}

export async function listMiswagBrandMappingRows({ q = "", status = "all", page = 1, limit = 20 } = {}) {
  const [brands, mappings] = await Promise.all([
    Product.aggregate([
      { $match: { "brand._id": { $exists: true, $nin: [null, ""] } } },
      {
        $group: {
          _id: { $toString: "$brand._id" },
          name: { $first: "$brand.name" },
          productCount: { $sum: 1 },
        },
      },
      { $sort: { "name.en": 1, "name.ku": 1, "name.ar": 1 } },
    ]),
    listMiswagValueMappings("brand"),
  ]);

  const byKey = new Map(mappings.map((row) => [String(row.brownKey), row]));
  const needle = String(q || "")
    .trim()
    .toLowerCase();

  let rows = brands
    .filter((row) => row._id)
    .map((row) => {
      const brownKey = String(row._id);
      const brownLabel = localizedBrandName(row.name) || brownKey;
      const mapping = byKey.get(brownKey) || null;
      const rowStatus = statusOf(mapping);
      return {
        id: brownKey,
        brownKey,
        brownLabel,
        productCount: Number(row.productCount) || 0,
        status: rowStatus,
        mode: mapping?.mode || "",
        miswag: mapping
          ? {
              id: mapping.miswagId,
              name: mapping.miswagLabel,
            }
          : null,
        mapped: Boolean(mapping?.miswagId),
        updatedAt: mapping?.updatedAt || null,
      };
    });

  for (const mapping of mappings) {
    if (rows.some((row) => row.brownKey === mapping.brownKey)) continue;
    rows.push({
      id: mapping.brownKey,
      brownKey: mapping.brownKey,
      brownLabel: mapping.brownLabel || mapping.brownKey,
      productCount: 0,
      status: statusOf(mapping),
      mode: mapping.mode,
      miswag: { id: mapping.miswagId, name: mapping.miswagLabel },
      mapped: Boolean(mapping.miswagId),
      updatedAt: mapping.updatedAt || null,
    });
  }

  if (needle) {
    rows = rows.filter(
      (row) =>
        row.brownLabel.toLowerCase().includes(needle) ||
        row.brownKey.toLowerCase().includes(needle) ||
        String(row.miswag?.name || "")
          .toLowerCase()
          .includes(needle) ||
        String(row.miswag?.id || "").includes(needle)
    );
  }
  if (status === "manual") rows = rows.filter((row) => row.status === "manual");
  else if (status === "auto") rows = rows.filter((row) => row.status === "auto");
  else if (status === "needs_review" || status === "missing") {
    rows = rows.filter((row) => row.status === "needs_review");
  }

  const counts = {
    total: brands.length,
    manual: 0,
    auto: 0,
    needs_review: 0,
    mapped: 0,
    missing: 0,
  };
  const allStatuses = brands.map((row) => statusOf(byKey.get(String(row._id))));
  counts.manual =
    allStatuses.filter((s) => s === "manual").length +
    mappings.filter((m) => m.mode === "manual" && !brands.some((b) => String(b._id) === m.brownKey))
      .length;
  counts.auto = allStatuses.filter((s) => s === "auto").length;
  counts.needs_review = allStatuses.filter((s) => s === "needs_review").length;
  counts.mapped = counts.manual + counts.auto;
  counts.missing = counts.needs_review;

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const paged = paginate(rows, Number(page) || 1, safeLimit);
  return { ...paged, counts, kind: "brand" };
}

function colorRowStatus(mapping, verified) {
  const hex = normalizeMiswagHex(mapping?.hex || "");
  if (mapping?.mode === "manual") return isMiswagColorHex(hex) ? "manual" : "needs_review";
  if (mapping && isMiswagColorHex(hex)) return "auto";
  if (verified) return "auto";
  return "needs_review";
}

function resolvedColorHex(mapping, verified) {
  const status = colorRowStatus(mapping, verified);
  const saved = normalizeMiswagHex(mapping?.hex || "");
  if ((status === "manual" || (mapping && status === "auto" && isMiswagColorHex(saved))) && isMiswagColorHex(saved)) {
    return saved;
  }
  if (status === "auto" && verified) return normalizeMiswagHex(verified[0]);
  return "";
}

function collectProductColors(products) {
  const discovered = new Map();
  for (const product of products) {
    const seen = new Set();
    for (const variant of product?.variants || []) {
      const label = readOriginalMiswagColorName(variant);
      const key = normalizeMiswagColorKey(label);
      if (!label || !key || seen.has(key)) continue;
      seen.add(key);
      const prev = discovered.get(key) || {
        brownKey: key,
        brownLabel: label,
        productHex: "",
        productCount: 0,
      };
      prev.productCount += 1;
      if (!prev.brownLabel) prev.brownLabel = label;
      const stored = readStoredProductHex(variant);
      if (stored) prev.productHex = stored;
      discovered.set(key, prev);
    }
  }
  return discovered;
}

export async function listMiswagColorMappingRows({ q = "", status = "all", page = 1, limit = 20 } = {}) {
  const [products, mappings] = await Promise.all([
    Product.find({ "variants.0": { $exists: true } })
      .select("variants")
      .lean(),
    listMiswagValueMappings("color"),
  ]);

  const byKey = new Map();
  for (const row of mappings) {
    const key = normalizeMiswagColorKey(row.brownKey);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (row.mode === "manual" && prev.mode !== "manual")) byKey.set(key, row);
  }

  const discovered = collectProductColors(products);
  const rows = [];

  for (const meta of discovered.values()) {
    const mapping = byKey.get(meta.brownKey) || null;
    const verified = MISWAG_VERIFIED_COLOR_MAP[meta.brownKey] || null;
    const rowStatus = colorRowStatus(mapping, verified);
    const hex = resolvedColorHex(mapping, verified);
    rows.push({
      id: meta.brownKey,
      brownKey: meta.brownKey,
      brownLabel: meta.brownLabel,
      productCount: meta.productCount,
      productHex: meta.productHex || "",
      verifiedHex: verified ? normalizeMiswagHex(verified[0]) : "",
      status: rowStatus,
      mode: mapping?.mode || (rowStatus === "auto" ? "auto" : ""),
      miswag: hex ? { name: meta.brownLabel, hex } : null,
      mapped: Boolean(hex),
      updatedAt: mapping?.updatedAt || null,
    });
  }

  for (const [key, mapping] of byKey) {
    if (discovered.has(key)) continue;
    const verified = MISWAG_VERIFIED_COLOR_MAP[key] || null;
    const rowStatus = colorRowStatus(mapping, verified);
    const hex = resolvedColorHex(mapping, verified);
    const brownLabel = mapping.brownLabel || mapping.miswagLabel || key;
    rows.push({
      id: key,
      brownKey: key,
      brownLabel,
      productCount: 0,
      productHex: "",
      verifiedHex: verified ? normalizeMiswagHex(verified[0]) : "",
      status: rowStatus,
      mode: mapping.mode || "",
      miswag: hex ? { name: brownLabel, hex } : null,
      mapped: Boolean(hex),
      updatedAt: mapping.updatedAt || null,
    });
  }

  rows.sort((a, b) => String(a.brownLabel).localeCompare(String(b.brownLabel)));

  const counts = {
    total: rows.length,
    manual: rows.filter((row) => row.status === "manual").length,
    auto: rows.filter((row) => row.status === "auto").length,
    needs_review: rows.filter((row) => row.status === "needs_review").length,
    mapped: rows.filter((row) => row.mapped).length,
    missing: rows.filter((row) => row.status === "needs_review").length,
  };

  const needle = String(q || "")
    .trim()
    .toLowerCase();
  let filtered = rows;
  if (needle) {
    filtered = filtered.filter(
      (row) =>
        row.brownLabel.toLowerCase().includes(needle) ||
        row.brownKey.includes(needle) ||
        String(row.miswag?.hex || "")
          .toLowerCase()
          .includes(needle)
    );
  }
  if (status === "manual") filtered = filtered.filter((row) => row.status === "manual");
  else if (status === "auto") filtered = filtered.filter((row) => row.status === "auto");
  else if (status === "needs_review" || status === "missing") {
    filtered = filtered.filter((row) => row.status === "needs_review");
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const paged = paginate(filtered, Number(page) || 1, safeLimit);
  return { ...paged, counts, kind: "color" };
}

/**
 * Resolve Miswag color.value without changing the original BrownStore name.
 * Manual mappings win. Saved HEX mappings are next. Exact verified names are last.
 * Product HEX is never used, so an unknown color cannot fall back to #000000.
 */
export function resolveColorFromMaps(variant, colorMap = null) {
  const name = readOriginalMiswagColorName(variant);
  if (!name) return null;
  const key = normalizeMiswagColorKey(name);
  if (!key) return null;

  const mapped = colorMap?.get?.(key) || null;
  if (mapped?.mode === "manual") {
    const hex = normalizeMiswagHex(mapped.hex);
    if (!isMiswagColorHex(hex)) return null;
    return { name, value: hex, source: "manual_mapping" };
  }

  const savedHex = normalizeMiswagHex(mapped?.hex || "");
  if (mapped && isMiswagColorHex(savedHex)) {
    return { name, value: savedHex, source: "auto_mapping" };
  }

  const verified = MISWAG_VERIFIED_COLOR_MAP[key];
  if (!verified) return null;
  const value = normalizeMiswagHex(verified[0]);
  if (!isMiswagColorHex(value)) return null;
  return { name, value, source: "verified_name" };
}

export { localizedBrandName };
