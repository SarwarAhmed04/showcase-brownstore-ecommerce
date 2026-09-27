import { Product } from "../models/Product.js";
import {
  ALL_TARGET_ID,
  COMMISSION_SCOPES,
} from "../models/Commission.js";

export { ALL_TARGET_ID, COMMISSION_SCOPES };

export const ALL_TARGET_NAME = {
  ku: "هەموو بەرهەمەکان",
  en: "All products",
  ar: "كل المنتجات",
};

const SCOPE_RANK = {
  vendor: 4,
  collection: 3,
  subcategory: 2,
  category: 1,
  all: 0,
};

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

export async function commissionTargets() {
  const [categories, subcategories, collections, vendors] = await Promise.all([
    Product.aggregate([
      { $match: { "category._id": { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { $toString: "$category._id" },
          name: { $first: "$category.name" },
          products: { $sum: 1 },
        },
      },
      { $sort: { "name.en": 1, "name.ku": 1 } },
    ]),
    Product.aggregate([
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
    ]),
    Product.aggregate([
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
    ]),
    Product.aggregate([
      { $match: { "createdBy._id": { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { $toString: "$createdBy._id" },
          name: { $first: "$createdBy.name" },
          products: { $sum: 1 },
        },
      },
      { $sort: { name: 1 } },
    ]),
  ]);

  return {
    categories: mapRows(categories),
    subcategories: mapRows(subcategories),
    collections: mapRows(collections),
    vendors: mapRows(vendors),
  };
}

export function findTarget(targets, scope, targetId) {
  if (scope === "all") {
    return { id: ALL_TARGET_ID, name: { ...ALL_TARGET_NAME } };
  }
  const list =
    scope === "category"
      ? targets.categories
      : scope === "subcategory"
        ? targets.subcategories
        : scope === "vendor"
          ? targets.vendors
          : targets.collections;
  return list.find((item) => item.id === String(targetId)) || null;
}

export function applyCommissionRate(price, percentage) {
  const base = Number(price) || 0;
  const rate = Number(percentage);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  return Math.max(0, Math.round(base * (1 + safeRate / 100)));
}

function entityId(value) {
  if (value == null) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

export function winningCommission(product, rules) {
  const raw = typeof product?.toObject === "function" ? product.toObject() : product;
  const collectionId = entityId(raw.collectionName);
  const subCategoryId = entityId(raw.subCategory);
  const categoryId = entityId(raw.category);
  const vendorId = entityId(raw.createdBy);

  const active = (rules || []).filter((rule) => rule.isActive !== false);
  const ranked = active
    .map((rule) => ({ rule, rank: SCOPE_RANK[rule.scope] ?? -1 }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => b.rank - a.rank);

  for (const { rule } of ranked) {
    if (rule.scope === "vendor" && vendorId && rule.targetId === vendorId) return rule;
    if (rule.scope === "collection" && collectionId && rule.targetId === collectionId) return rule;
    if (rule.scope === "subcategory" && subCategoryId && rule.targetId === subCategoryId) return rule;
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
    vendor: [],
  };
  for (const rule of active) {
    const id = String(rule.targetId || "");
    if (!id || !buckets[rule.scope]) continue;
    buckets[rule.scope].push(id);
  }

  const or = [];
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
