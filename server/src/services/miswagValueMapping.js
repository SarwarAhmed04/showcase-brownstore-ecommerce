import { MiswagValueMapping } from "../models/MiswagValueMapping.js";
import { Product } from "../models/Product.js";

/**
 * Miswag brand mapping helpers.
 * Color mapping UI/API/resolve paths were removed — products send original BrownStore
 * color names only. Historical MiswagValueMapping kind="color" rows are left untouched.
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

/**
 * Save a manual brand mapping. Never deletes other rows. Overwrites auto or prior manual
 * for the same brownKey only. Color kind is rejected (color mapping removed).
 */
export async function upsertMiswagValueMapping(input = {}) {
  const kind = String(input.kind || "").trim();
  if (kind === "color") {
    const error = new Error("Miswag color mapping has been removed; use original BrownStore color names.");
    error.status = 400;
    error.code = "color_mapping_removed";
    throw error;
  }
  if (kind !== "brand") {
    const error = new Error("kind must be brand");
    error.status = 400;
    error.code = "invalid_kind";
    throw error;
  }

  const brownKey = normalizeKey(input.brownKey);
  if (!brownKey) {
    const error = new Error("brownKey is required");
    error.status = 400;
    error.code = "brown_key_required";
    throw error;
  }

  const brownLabel = normalizeKey(input.brownLabel) || brownKey;
  const mode = String(input.mode || "manual").trim() === "auto" ? "auto" : "manual";
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
 * Reset a brand mapping row. Does not touch BrownStore product data or color history rows
 * unless kind/brownKey explicitly target them via legacy callers.
 */
export async function resetMiswagValueMapping(kind, brownKey) {
  const key = normalizeKey(brownKey);
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

export { localizedBrandName };
