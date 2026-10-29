import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { ALL_TARGET_ID, COMMISSION_SCOPES, Commission } from "../models/Commission.js";
import { fetchIbsherVendors } from "../services/ibsher.js";
import {
  FILTER_BRAND_BEFORE_CATEGORY_MESSAGE,
  FILTER_COLLECTION_MESSAGE,
  FILTER_NO_MATCH_MESSAGE,
  FILTER_REQUIRED_MESSAGE,
  filterCommissionTargetId,
  filterIdsError,
  filterNoMatchMessage,
  filterSpecificity,
  normalizeFilterIds,
} from "./commissionIds.js";

export { ALL_TARGET_ID, COMMISSION_SCOPES };
export {
  FILTER_BRAND_BEFORE_CATEGORY_MESSAGE,
  FILTER_COLLECTION_MESSAGE,
  FILTER_NO_MATCH_MESSAGE,
  FILTER_REQUIRED_MESSAGE,
  filterCommissionTargetId,
  filterIdsError,
  filterNoMatchMessage,
  filterSpecificity,
  normalizeFilterIds,
};

export const ALL_TARGET_NAME = {
  ku: "هەموو بەرهەمەکان",
  en: "All products",
  ar: "كل المنتجات",
};

const ALL_BRANDS_NAME = {
  ku: "هەموو براندەکان",
  en: "All brands",
  ar: "كل العلامات",
};

const ALL_CATEGORIES_NAME = {
  ku: "هەموو پۆلەکان",
  en: "All Categories",
  ar: "كل الأقسام",
};

const ALL_SUBCATEGORIES_NAME = {
  ku: "هەموو ژێرپۆلەکان",
  en: "All Sub-categories",
  ar: "كل الأقسام الفرعية",
};

const ALL_COLLECTIONS_NAME = {
  ku: "هەموو کۆلێکشنەکان",
  en: "All Collections",
  ar: "كل المجموعات",
};

// The most specific matching filter wins, then these existing scopes in order.
const SCOPE_RANK = {
  filter: 6,
  vendor: 5,
  collection: 4,
  subcategory: 3,
  brand: 2,
  category: 1,
  all: 0,
};

const FILTER_OPTION_FIELDS = {
  brands: { id: "$brand._id", name: "$brand.name", match: "brand._id" },
  categories: { id: "$category._id", name: "$category.name", match: "category._id" },
  subcategories: { id: "$subCategory._id", name: "$subCategory.name", match: "subCategory._id" },
  collections: {
    id: "$collectionName._id",
    name: "$collectionName.name",
    match: "collectionName._id",
  },
};

export class CommissionInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CommissionInputError";
    this.status = status;
  }
}

function localizedName(name) {
  if (typeof name === "string") {
    const value = name.trim();
    return { ku: value, en: value, ar: value };
  }
  const fallback = String(name?.en || name?.ku || name?.ar || "").trim();
  return {
    ku: String(name?.ku || fallback),
    en: String(name?.en || fallback),
    ar: String(name?.ar || fallback),
  };
}

function storedFilterPath(path) {
  if (!path || typeof path !== "object") return null;
  return {
    vendor: localizedName(path.vendor),
    brand: localizedName(path.brand),
    category: localizedName(path.category),
    subCategory: localizedName(path.subCategory),
    collection: localizedName(path.collection),
  };
}

export function toAdminCommission(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  const percentage = Number(raw.percentage);
  return {
    id: raw._id.toString(),
    partner: raw.partner || "",
    scope: raw.scope,
    targetId: raw.targetId,
    targetName:
      raw.scope === "all" ? { ...ALL_TARGET_NAME } : localizedName(raw.targetName),
    categoryId: raw.categoryId || "",
    subCategoryId: raw.subCategoryId || "",
    vendorId: raw.vendorId || "",
    brandId: raw.brandId || "",
    collectionId: raw.collectionId || "",
    filterPath: raw.scope === "filter" ? storedFilterPath(raw.filterPath) : null,
    percentage: Number.isFinite(percentage) ? percentage : 0,
    isActive: raw.isActive !== false,
    updatedAt: raw.updatedAt,
  };
}

function mapRows(rows) {
  return rows
    .filter((row) => row._id)
    .map((row) => ({
      id: String(row._id),
      name: localizedName(row.name),
      categoryId: row.categoryId ? String(row.categoryId) : "",
      subCategoryId: row.subCategoryId ? String(row.subCategoryId) : "",
      products: Number(row.products) || 0,
    }));
}

function optionSort(a, b) {
  const left = a.name?.en || a.name?.ku || a.name?.ar || a.id;
  const right = b.name?.en || b.name?.ku || b.name?.ar || b.id;
  return String(left).localeCompare(String(right), "en", { sensitivity: "base" });
}

function vendorLabel(row, directory) {
  const id = String(row._id || "");
  const fromDirectory = directory.get(id);
  if (fromDirectory) return fromDirectory;
  if (typeof row.name === "string" && row.name.trim()) return row.name.trim();
  const email = typeof row.email === "string" ? row.email.trim() : "";
  return email;
}

const CATALOG_PIPELINES = {
  category: [
    { $match: { "category._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$category._id" },
        name: { $first: "$category.name" },
        products: { $sum: 1 },
      },
    },
    { $sort: { "name.en": 1, "name.ku": 1 } },
  ],
  subcategory: [
    { $match: { "subCategory._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$subCategory._id" },
        name: { $first: "$subCategory.name" },
        categoryId: {
          $first: {
            $toString: { $ifNull: ["$subCategory.category", "$category._id"] },
          },
        },
        products: { $sum: 1 },
      },
    },
    { $sort: { "name.en": 1, "name.ku": 1 } },
  ],
  collection: [
    { $match: { "collectionName._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$collectionName._id" },
        name: { $first: "$collectionName.name" },
        subCategoryId: {
          $first: {
            $toString: {
              $ifNull: ["$collectionName.subCategory", "$subCategory._id"],
            },
          },
        },
        categoryId: { $first: { $toString: { $ifNull: ["$category._id", ""] } } },
        products: { $sum: 1 },
      },
    },
    { $sort: { "name.en": 1, "name.ku": 1 } },
  ],
  brand: [
    { $match: { "brand._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$brand._id" },
        name: { $first: "$brand.name" },
        products: { $sum: 1 },
      },
    },
    { $sort: { "name.en": 1, "name.ku": 1 } },
  ],
  vendor: [
    { $match: { "createdBy._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$createdBy._id" },
        name: { $first: "$createdBy.name" },
        email: { $first: "$createdBy.email" },
        products: { $sum: 1 },
      },
    },
  ],
};

export async function catalogGroups(scope) {
  if (scope === "vendor") {
    const [vendors, directory] = await Promise.all([
      Product.aggregate(CATALOG_PIPELINES.vendor),
      fetchIbsherVendors().catch((err) => {
        console.warn("Vendor names unavailable:", err.message);
        return [];
      }),
    ]);
    const names = new Map(directory.map((vendor) => [vendor.id, vendor.name]));
    const namedVendors = vendors
      .map((row) => ({ ...row, name: vendorLabel(row, names) }))
      .sort((a, b) => String(a.name || a._id).localeCompare(String(b.name || b._id), "en"));
    return mapRows(namedVendors);
  }
  const pipeline = CATALOG_PIPELINES[scope];
  if (!pipeline) return [];
  return mapRows(await Product.aggregate(pipeline));
}

export async function commissionTargets() {
  const [categories, subcategories, collections, brands, vendors] = await Promise.all([
    catalogGroups("category"),
    catalogGroups("subcategory"),
    catalogGroups("collection"),
    catalogGroups("brand"),
    catalogGroups("vendor"),
  ]);
  return { categories, subcategories, collections, brands, vendors };
}

export function findTarget(targets, scope, targetId) {
  if (scope === "all") {
    return { id: ALL_TARGET_ID, name: { ...ALL_TARGET_NAME } };
  }
  if (scope === "filter") return null;
  const list =
    scope === "category"
      ? targets.categories
      : scope === "subcategory"
        ? targets.subcategories
        : scope === "vendor"
          ? targets.vendors
          : scope === "brand"
            ? targets.brands
            : targets.collections;
  return list.find((item) => item.id === String(targetId)) || null;
}

function productIdMatch(path, id) {
  const value = String(id || "").trim();
  const choices = [{ [path]: value }];
  if (
    mongoose.Types.ObjectId.isValid(value) &&
    String(new mongoose.Types.ObjectId(value)) === value
  ) {
    choices.push({ [path]: new mongoose.Types.ObjectId(value) });
  }
  return choices.length === 1 ? choices[0] : { $or: choices };
}

function filterOptionLevel(ids) {
  if (ids.subCategoryId) return "collections";
  if (ids.categoryId) return "subcategories";
  if (ids.brandId) return "categories";
  if (ids.vendorId) return "brands";
  return "vendors";
}

export async function filterCommissionOptions(query = {}) {
  const vendorId = String(query.vendorId || "").trim();
  const brandId = String(query.brandId || "").trim();
  const categoryId = String(query.categoryId || "").trim();
  const subCategoryId = String(query.subCategoryId || "").trim();

  if (brandId && !vendorId) {
    throw new CommissionInputError("Select a vendor before a brand.");
  }
  if (categoryId && (!vendorId || !brandId)) {
    throw new CommissionInputError("Select a vendor and brand before a category.");
  }
  if (subCategoryId && (!vendorId || !brandId || !categoryId)) {
    throw new CommissionInputError("Select a vendor, brand, and category before a sub-category.");
  }

  const level = filterOptionLevel({ vendorId, brandId, categoryId, subCategoryId });
  if (level === "vendors") {
    return { level, vendors: await catalogGroups("vendor") };
  }

  const parents = [productIdMatch("createdBy._id", vendorId)];
  if (brandId) parents.push(productIdMatch("brand._id", brandId));
  if (categoryId) parents.push(productIdMatch("category._id", categoryId));
  if (subCategoryId) parents.push(productIdMatch("subCategory._id", subCategoryId));

  const field = FILTER_OPTION_FIELDS[level];
  const rows = await Product.aggregate([
    {
      $match: {
        $and: [{ [field.match]: { $exists: true, $nin: [null, ""] } }, ...parents],
      },
    },
    {
      $group: {
        _id: { $toString: field.id },
        name: { $first: field.name },
        products: { $sum: 1 },
      },
    },
  ]);
  return { level, [level]: mapRows(rows).sort(optionSort) };
}

async function vendorDirectory() {
  try {
    const directory = await fetchIbsherVendors();
    return new Map((directory || []).map((vendor) => [String(vendor.id), vendor.name]));
  } catch (err) {
    console.warn("Vendor names unavailable:", err.message);
    return new Map();
  }
}

function filterTargetName(path) {
  const build = (lang) =>
    ["vendor", "brand", "category", "subCategory", "collection"]
      .map((key) => {
        const name = path[key] || {};
        return String(name[lang] || name.en || name.ku || name.ar || "").trim();
      })
      .filter(Boolean)
      .join(" → ");
  return { ku: build("ku"), en: build("en"), ar: build("ar") };
}

function filterProductClauses(ids) {
  const clauses = [productIdMatch("createdBy._id", ids.vendorId)];
  if (ids.brandId) clauses.push(productIdMatch("brand._id", ids.brandId));
  if (ids.categoryId) clauses.push(productIdMatch("category._id", ids.categoryId));
  if (ids.subCategoryId) clauses.push(productIdMatch("subCategory._id", ids.subCategoryId));
  if (ids.collectionId) clauses.push(productIdMatch("collectionName._id", ids.collectionId));
  return clauses;
}

async function matchedFilterPath(ids) {
  const [row] = await Product.aggregate([
    {
      $match: { $and: filterProductClauses(ids) },
    },
    {
      $group: {
        _id: null,
        products: { $sum: 1 },
        vendorName: { $first: "$createdBy.name" },
        vendorEmail: { $first: "$createdBy.email" },
        brandName: { $first: "$brand.name" },
        categoryName: { $first: "$category.name" },
        subCategoryName: { $first: "$subCategory.name" },
        collectionName: { $first: "$collectionName.name" },
      },
    },
  ]);
  if (!row?.products) return null;
  const directory = await vendorDirectory();
  const vendorName =
    directory.get(ids.vendorId) ||
    row.vendorName ||
    (typeof row.vendorEmail === "string" ? row.vendorEmail.trim() : "") ||
    ids.vendorId;
  return {
    vendor: localizedName(vendorName),
    brand: ids.brandId ? localizedName(row.brandName) : { ...ALL_BRANDS_NAME },
    category: ids.categoryId ? localizedName(row.categoryName) : { ...ALL_CATEGORIES_NAME },
    subCategory: ids.subCategoryId ? localizedName(row.subCategoryName) : { ...ALL_SUBCATEGORIES_NAME },
    collection: ids.collectionId ? localizedName(row.collectionName) : { ...ALL_COLLECTIONS_NAME },
  };
}

export async function saveFilterCommission({
  partner,
  vendorId,
  brandId,
  categoryId,
  subCategoryId,
  collectionId,
  percentage,
  isActive = true,
}) {
  const slug = String(partner || "").trim().toLowerCase();
  if (!slug) throw new CommissionInputError("Unknown partner");
  const rawIds = { vendorId, brandId, categoryId, subCategoryId, collectionId };
  const error = filterIdsError(rawIds);
  if (error) throw new CommissionInputError(error);
  const ids = normalizeFilterIds(rawIds);
  const rate = Number(percentage);
  if (!Number.isFinite(rate) || rate < -99 || rate > 500) {
    throw new CommissionInputError("Invalid percentage");
  }
  const filterPath = await matchedFilterPath(ids);
  if (!filterPath) throw new CommissionInputError(filterNoMatchMessage(ids));
  const targetId = filterCommissionTargetId(ids);
  const item = await Commission.findOneAndUpdate(
    { partner: slug, scope: "filter", targetId },
    {
      $set: {
        partner: slug,
        scope: "filter",
        targetId,
        targetName: filterTargetName(filterPath),
        vendorId: ids.vendorId,
        brandId: ids.brandId || null,
        categoryId: ids.categoryId || null,
        subCategoryId: ids.subCategoryId || null,
        collectionId: ids.collectionId || null,
        filterPath,
        percentage: Math.round(rate * 100) / 100,
        isActive: isActive !== false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return item;
}

export const PLATFORM_PRICE_STEP = 250;

// Final platform prices move up to the next 250 IQD. An exact multiple stays as it is.
export function roundUpPlatformPrice(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const units = value / PLATFORM_PRICE_STEP;
  const nearest = Math.round(units);
  if (Math.abs(value - nearest * PLATFORM_PRICE_STEP) < 1e-6) return nearest * PLATFORM_PRICE_STEP;
  return Math.ceil(units - 1e-9) * PLATFORM_PRICE_STEP;
}

export function applyCommissionRate(price, percentage) {
  const base = Number(price) || 0;
  const rate = Number(percentage);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  const raw = Math.max(0, base * (1 + safeRate / 100));
  return roundUpPlatformPrice(raw);
}

function entityId(value) {
  if (value == null) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

function sameId(ruleId, productId) {
  const left = String(ruleId || "").trim();
  const right = String(productId || "").trim();
  return left !== "" && left === right;
}

function filterRuleScore(rule, productIds) {
  const ids = normalizeFilterIds(rule);
  if (!ids) return 0;
  if (!sameId(ids.vendorId, productIds.vendorId)) return 0;
  if (ids.brandId && !sameId(ids.brandId, productIds.brandId)) return 0;
  if (ids.categoryId && !sameId(ids.categoryId, productIds.categoryId)) return 0;
  if (ids.subCategoryId && !sameId(ids.subCategoryId, productIds.subCategoryId)) return 0;
  if (ids.collectionId && !sameId(ids.collectionId, productIds.collectionId)) return 0;
  return filterSpecificity(ids);
}

export function winningCommission(product, rules) {
  const raw = typeof product?.toObject === "function" ? product.toObject() : product;
  const collectionId = entityId(raw.collectionName);
  const subCategoryId = entityId(raw.subCategory);
  const brandId = entityId(raw.brand);
  const categoryId = entityId(raw.category);
  const vendorId = entityId(raw.createdBy);
  const productIds = { vendorId, brandId, categoryId, subCategoryId, collectionId };

  const active = (rules || []).filter((rule) => rule.isActive !== false);
  let bestFilter = null;
  let bestScore = 0;
  for (const rule of active) {
    if (rule.scope !== "filter") continue;
    const score = filterRuleScore(rule, productIds);
    if (score > bestScore) {
      bestScore = score;
      bestFilter = rule;
    }
  }
  if (bestFilter) return bestFilter;

  const ranked = active
    .filter((rule) => rule.scope !== "filter")
    .map((rule) => ({ rule, rank: SCOPE_RANK[rule.scope] ?? -1 }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => b.rank - a.rank);

  for (const { rule } of ranked) {
    if (rule.scope === "vendor" && vendorId && rule.targetId === vendorId) return rule;
    if (rule.scope === "collection" && collectionId && rule.targetId === collectionId) return rule;
    if (rule.scope === "subcategory" && subCategoryId && rule.targetId === subCategoryId) return rule;
    if (rule.scope === "brand" && brandId && rule.targetId === brandId) return rule;
    if (rule.scope === "category" && categoryId && rule.targetId === categoryId) return rule;
    if (rule.scope === "all") return rule;
  }

  return null;
}

export function resolveCommissionRate(product, rules) {
  const rule = winningCommission(product, rules);
  if (!rule) return 0;
  const rate = Number(rule.percentage);
  return Number.isFinite(rate) ? rate : 0;
}

export function commissionMatchFilter(rules) {
  const active = (rules || []).filter((rule) => rule.isActive !== false);
  if (!active.length) return null;
  if (active.some((rule) => rule.scope === "all")) return {};

  const buckets = {
    category: [],
    subcategory: [],
    collection: [],
    brand: [],
    vendor: [],
  };
  const or = [];
  for (const rule of active) {
    if (rule.scope === "filter") {
      const ids = normalizeFilterIds(rule);
      if (!ids) continue;
      or.push({ $and: filterProductClauses(ids) });
      continue;
    }
    const id = String(rule.targetId || "");
    if (!id || !buckets[rule.scope]) continue;
    buckets[rule.scope].push(id);
  }

  const push = (path, ids) => {
    if (!ids.length) return;
    or.push({
      $expr: {
        $in: [{ $toString: { $ifNull: [`$${path}`, ""] } }, ids],
      },
    });
  };
  push("category._id", buckets.category);
  push("subCategory._id", buckets.subcategory);
  push("collectionName._id", buckets.collection);
  push("brand._id", buckets.brand);
  push("createdBy._id", buckets.vendor);
  return or.length ? { $or: or } : null;
}

export function sortCommissions(items) {
  return [...items].sort((a, b) => {
    const rank = (SCOPE_RANK[b.scope] ?? 0) - (SCOPE_RANK[a.scope] ?? 0);
    if (rank) return rank;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}
