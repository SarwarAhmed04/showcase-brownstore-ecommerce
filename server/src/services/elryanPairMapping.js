import { Product } from "../models/Product.js";
import { ElryanValueMapping } from "../models/ElryanValueMapping.js";
import { brownColourKey, brownColourLabel } from "../utils/elryanColour.js";
import { resolveElryanScopedValue } from "../utils/elryanValueResolve.js";
import { toResolvedProduct } from "../utils/productView.js";
import { getElryanConnectionPublic } from "./elryanConnection.js";
import { compareMappingLabel, paginateElryanMappingRows } from "../utils/elryanMappingTablePage.js";

function textName(name) {
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  return String(name.en || name.ku || name.ar || "").trim();
}

async function activeEnvironment() {
  const connection = await getElryanConnectionPublic();
  return connection.environment === "production" ? "production" : "staging";
}

async function loadBrownBrands() {
  const products = await Product.find({}).select("brand").lean();
  const byId = new Map();
  for (const product of products) {
    const brownKey = String(product.brand?._id || product.brand?.id || "").trim().toLowerCase();
    if (!brownKey || brownKey === "null" || brownKey === "undefined") continue;
    const current = byId.get(brownKey) || {
      brownKey,
      brownLabel: textName(product.brand?.name) || brownKey,
      productCount: 0,
    };
    current.productCount += 1;
    if (!current.brownLabel || current.brownLabel === brownKey) {
      current.brownLabel = textName(product.brand?.name) || current.brownLabel;
    }
    byId.set(brownKey, current);
  }
  return [...byId.values()];
}

async function loadBrownColours() {
  const products = await Product.find({}).select("ibsherId variants overrides").lean();
  const byKey = new Map();
  for (const product of products) {
    const resolved = toResolvedProduct(product);
    const seen = new Set();
    for (const variant of resolved?.variants || []) {
      const label = brownColourLabel(variant?.color);
      const brownKey = brownColourKey(variant?.color);
      if (!brownKey || seen.has(brownKey)) continue;
      seen.add(brownKey);
      const current = byKey.get(brownKey) || { brownKey, brownLabel: label, productCount: 0 };
      current.productCount += 1;
      if (!current.brownLabel) current.brownLabel = label;
      byKey.set(brownKey, current);
    }
  }
  return [...byKey.values()];
}

function present(rows, environment, subject) {
  const resolved = resolveElryanScopedValue(rows, { environment, subject });
  if (!resolved?.row?.elryanId) return null;
  return {
    elryanId: String(resolved.row.elryanId),
    elryanLabel: String(resolved.row.elryanLabel || ""),
    brownLabel: String(resolved.row.brownLabel || ""),
    environment,
  };
}

/**
 * BrownStore brands or colours for the active Elryan environment, with the saved pair.
 * Does not call Elryan and does not write a mapping.
 */
function pairSearchText(row) {
  return `${row.brownLabel || ""} ${row.brownKey || ""} ${row.mapping?.elryanLabel || ""} ${row.mapping?.elryanId || ""}`.toLowerCase();
}

export async function listElryanPairMapping(kind, query = {}) {
  const normalized = kind === "color" ? "color" : kind === "brand" ? "brand" : "";
  if (!normalized) {
    const error = new Error("kind must be brand or color");
    error.status = 400;
    error.code = "invalid_kind";
    throw error;
  }
  const environment = await activeEnvironment();
  const [subjects, rows] = await Promise.all([
    normalized === "brand" ? loadBrownBrands() : loadBrownColours(),
    ElryanValueMapping.find({ kind: normalized }).lean(),
  ]);
  const sorted = subjects
    .map((subject) => ({
      ...subject,
      mapping: present(rows, environment, subject.brownKey),
    }))
    .sort((left, right) => compareMappingLabel(left.brownLabel, left.brownKey, right.brownLabel, right.brownKey));
  const needle = String(query?.q || "").trim().toLowerCase();
  const matched = needle ? sorted.filter((row) => pairSearchText(row).includes(needle)) : sorted;
  const page = paginateElryanMappingRows(matched, query);
  return {
    environment,
    kind: normalized,
    options: page.rows,
    mapped: sorted.filter((row) => row.mapping).length,
    page: page.page,
    limit: page.limit,
    total: page.total,
    pages: page.pages,
    hasMore: page.hasMore,
  };
}
