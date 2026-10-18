import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { Partner } from "../models/Partner.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "../models/PlatformTaxonomyNotice.js";
import { PlatformVisibilityRule, VISIBILITY_SCOPES } from "../models/PlatformVisibilityRule.js";
import { Product } from "../models/Product.js";
import { discoverBrownCollections } from "./brownTaxonomy.js";
import { catalogGroups } from "./commission.js";
import {
  eligibilityBucket,
  eligibilityMongoFilter,
  emptyInactiveSets,
  evaluatePlatformEligibility,
  LARGE_BULK_COUNT,
  productScopeIds,
} from "./platformEligibility.js";
import {
  isTaxonomyComplete,
  requiredTaxonomyKeys,
  sanitizeTaxonomyValues,
  taxonomyFieldsFor,
} from "./platformTaxonomyFields.js";
import { listOpenTaxonomyNotices, resolveTaxonomyNotices } from "./taxonomyNotices.js";

export { evaluatePlatformEligibility, eligibilityMongoFilter, LARGE_BULK_COUNT };

function inputError(message, details) {
  const error = new Error(message);
  error.status = 400;
  if (details) error.details = details;
  return error;
}

function cleanText(value) {
  return String(value || "").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function loadEligibilityContext(partnerSlug) {
  const slug = cleanText(partnerSlug).toLowerCase();
  const partner = await Partner.findOne({ slug }).select("slug isActive").lean();
  const [rules, configs] = await Promise.all([
    PlatformVisibilityRule.find({ partner: slug, isActive: false }).select("scope targetId").lean(),
    PlatformTaxonomyConfig.find({ partner: slug }).select("brownCollectionId values").lean(),
  ]);

  const inactive = emptyInactiveSets();
  for (const rule of rules) {
    const targetId = cleanText(rule.targetId);
    if (targetId && inactive[rule.scope]) inactive[rule.scope].add(targetId);
  }

  const configuredCollectionIds = new Set();
  const taxonomyByCollection = new Map();
  for (const row of configs) {
    const collectionId = cleanText(row.brownCollectionId);
    if (!collectionId) continue;
    const values = row.values || {};
    taxonomyByCollection.set(collectionId, values);
    if (isTaxonomyComplete(slug, values)) configuredCollectionIds.add(collectionId);
  }

  return {
    partnerSlug: slug,
    partnerActive: partner ? partner.isActive !== false : false,
    inactive,
    taxonomyRequired: requiredTaxonomyKeys(slug).length > 0,
    configuredCollectionIds,
    taxonomyByCollection,
  };
}

export function taxonomyValuesForProduct(product, context) {
  const collectionId = productScopeIds(product).collection;
  if (!collectionId) return null;
  return context?.taxonomyByCollection?.get(collectionId) || null;
}

function shiftBucket(counts, bucket, delta) {
  if (bucket === "ready") counts.exportReady += delta;
  else if (bucket === "missing_setup") counts.missingSetup += delta;
  else counts.inactiveExcluded += delta;
}

export async function countEligibility(context) {
  const groups = await Product.aggregate([
    {
      $group: {
        _id: {
          category: { $toString: { $ifNull: ["$category._id", ""] } },
          subcategory: { $toString: { $ifNull: ["$subCategory._id", ""] } },
          collection: { $toString: { $ifNull: ["$collectionName._id", ""] } },
          brand: { $toString: { $ifNull: ["$brand._id", ""] } },
          vendor: { $toString: { $ifNull: ["$createdBy._id", ""] } },
        },
        count: { $sum: 1 },
      },
    },
  ]).allowDiskUse(true);

  const groupContext = {
    ...context,
    inactive: { ...context.inactive, product: new Set() },
  };
  const counts = { exportReady: 0, inactiveExcluded: 0, missingSetup: 0 };

  for (const group of groups) {
    const sample = {
      _id: "group",
      category: { _id: group._id.category },
      subCategory: { _id: group._id.subcategory },
      collectionName: { _id: group._id.collection },
      brand: { _id: group._id.brand },
      createdBy: { _id: group._id.vendor },
    };
    const bucket = eligibilityBucket(evaluatePlatformEligibility(sample, groupContext));
    shiftBucket(counts, bucket, Number(group.count) || 0);
  }

  const objectIds = [...context.inactive.product]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length) {
    const products = await Product.find({ _id: { $in: objectIds } })
      .select("category subCategory collectionName brand createdBy")
      .lean();
    for (const product of products) {
      const before = eligibilityBucket(evaluatePlatformEligibility(product, groupContext));
      const after = eligibilityBucket(evaluatePlatformEligibility(product, context));
      if (before === after) continue;
      shiftBucket(counts, before, -1);
      shiftBucket(counts, after, 1);
    }
  }

  counts.exportReady = Math.max(0, counts.exportReady);
  counts.inactiveExcluded = Math.max(0, counts.inactiveExcluded);
  counts.missingSetup = Math.max(0, counts.missingSetup);
  return {
    totalProducts: counts.exportReady + counts.inactiveExcluded + counts.missingSetup,
    ...counts,
  };
}

export async function platformDashboard(partner) {
  const context = await loadEligibilityContext(partner.slug);
  const schemaReady = requiredTaxonomyKeys(partner.slug).length > 0;
  const [eligibility, priceRules, collectionIds, newTaxonomyAlerts] = await Promise.all([
    countEligibility(context),
    Commission.countDocuments({ partner: partner.slug }),
    Product.aggregate([
      { $match: { "collectionName._id": { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: { $toString: "$collectionName._id" } } },
    ]),
    PlatformTaxonomyNotice.countDocuments({ partner: partner.slug, status: "open" }),
  ]);
  const known = new Set(collectionIds.map((row) => String(row._id || "")).filter(Boolean));
  let configuredCollections = 0;
  for (const id of context.configuredCollectionIds) {
    if (known.has(id)) configuredCollections += 1;
  }
  return {
    totalProducts: eligibility.totalProducts,
    exportReady: eligibility.exportReady,
    inactiveExcluded: eligibility.inactiveExcluded,
    missingSetup: eligibility.missingSetup,
    priceRules,
    totalCollections: known.size,
    configuredCollections,
    missingSetupCollections: schemaReady ? Math.max(0, known.size - configuredCollections) : 0,
    newTaxonomyAlerts,
    taxonomyFieldsReady: schemaReady,
    platformActive: context.partnerActive,
  };
}

function haystack(name, id) {
  if (typeof name === "string") return `${name} ${id || ""}`.toLowerCase();
  return [name?.en, name?.ku, name?.ar, id].map((value) => String(value || "")).join(" ").toLowerCase();
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

async function inactiveIds(partner, scope) {
  const rules = await PlatformVisibilityRule.find({ partner, scope, isActive: false })
    .select("targetId")
    .lean();
  return new Set(rules.map((rule) => String(rule.targetId)));
}

function productQuery({ q, status, inactive }) {
  const and = [];
  const needle = cleanText(q);
  if (needle) {
    const rx = new RegExp(escapeRegex(needle), "i");
    and.push({
      $or: [
        { "name.ku": rx },
        { "name.en": rx },
        { "name.ar": rx },
        { itemCode: rx },
        { "overrides.sku": rx },
      ],
    });
  }
  const ids = [...inactive].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  if (status === "inactive") and.push({ _id: { $in: objectIds } });
  else if (status === "active" && objectIds.length) and.push({ _id: { $nin: objectIds } });
  return and.length ? { $and: and } : {};
}

async function listProductAvailability({ partner, inactive, q, status, page, limit }) {
  const context = await loadEligibilityContext(partner);
  const query = productQuery({ q, status, inactive });
  const [items, total] = await Promise.all([
    Product.find(query)
      .select("name itemCode overrides.sku category subCategory collectionName brand createdBy")
      .sort({ itemCode: 1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Product.countDocuments(query),
  ]);
  return {
    scope: "product",
    inactiveCount: inactive.size,
    rows: items.map((item) => {
      const id = String(item._id);
      return {
        id,
        name: item.name || {},
        sku: item.overrides?.sku || item.itemCode || "",
        productCount: 1,
        isActive: !inactive.has(id),
        eligibility: evaluatePlatformEligibility(item, context),
      };
    }),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function listAvailability({ partner, scope, q, status, page, limit }) {
  if (!VISIBILITY_SCOPES.includes(scope)) throw inputError("Unknown availability scope");
  const inactive = await inactiveIds(partner, scope);
  if (scope === "product") {
    return listProductAvailability({ partner, inactive, q, status, page, limit });
  }

  let rows = (await catalogGroups(scope)).map((item) => ({
    id: String(item.id),
    name: item.name,
    productCount: Number(item.products) || 0,
    isActive: !inactive.has(String(item.id)),
    categoryId: item.categoryId || "",
    subCategoryId: item.subCategoryId || "",
  }));
  const needle = cleanText(q).toLowerCase();
  if (needle) rows = rows.filter((row) => haystack(row.name, row.id).includes(needle));
  if (status === "active") rows = rows.filter((row) => row.isActive);
  if (status === "inactive") rows = rows.filter((row) => !row.isActive);
  rows.sort((a, b) => haystack(a.name, a.id).localeCompare(haystack(b.name, b.id)));
  return { scope, inactiveCount: inactive.size, ...paginate(rows, page, limit) };
}

async function matchingIds({ partner, scope, q, status }) {
  if (scope === "product") {
    const inactive = await inactiveIds(partner, scope);
    const docs = await Product.find(productQuery({ q, status, inactive })).select("_id").lean();
    return docs.map((doc) => String(doc._id));
  }
  const listed = await listAvailability({
    partner,
    scope,
    q,
    status,
    page: 1,
    limit: 100000,
  });
  return listed.rows.map((row) => row.id);
}

async function assertTargets(scope, ids) {
  if (scope === "product") {
    const objectIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (objectIds.length !== ids.length) throw inputError("Unknown product");
    const found = await Product.countDocuments({
      _id: { $in: objectIds.map((id) => new mongoose.Types.ObjectId(id)) },
    });
    if (found !== ids.length) throw inputError("Unknown product");
    return;
  }
  const known = new Set((await catalogGroups(scope)).map((item) => String(item.id)));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw inputError("Unknown target", { missing: missing.slice(0, 20) });
}

async function writeVisibility(partner, scope, ids, isActive) {
  if (!ids.length) return;
  if (isActive) {
    await PlatformVisibilityRule.deleteMany({ partner, scope, targetId: { $in: ids } });
    return;
  }
  const ops = ids.map((targetId) => ({
    updateOne: {
      filter: { partner, scope, targetId },
      update: { $set: { partner, scope, targetId, isActive: false } },
      upsert: true,
    },
  }));
  for (let index = 0; index < ops.length; index += 1000) {
    await PlatformVisibilityRule.bulkWrite(ops.slice(index, index + 1000), { ordered: false });
  }
}

export async function applyAvailability({
  partner,
  scope,
  targetIds,
  isActive,
  confirm,
  allMatching,
  q,
  status,
}) {
  if (!VISIBILITY_SCOPES.includes(scope)) throw inputError("Unknown availability scope");
  const ids = allMatching
    ? await matchingIds({ partner, scope, q, status })
    : [...new Set((targetIds || []).map((id) => cleanText(id)).filter(Boolean))];
  if (!ids.length) return { updated: 0, isActive: Boolean(isActive) };
  const needsConfirm = Boolean(allMatching) || ids.length >= LARGE_BULK_COUNT;
  if (needsConfirm && confirm !== true) {
    throw inputError("Confirmation required for this bulk availability change", {
      count: ids.length,
    });
  }
  if (!allMatching) await assertTargets(scope, ids);
  await writeVisibility(partner, scope, ids, Boolean(isActive));
  return { updated: ids.length, isActive: Boolean(isActive) };
}

export async function productEligibility(partner, product) {
  const context = await loadEligibilityContext(partner);
  return {
    platformActive: !context.inactive.product.has(String(product._id)),
    eligibility: evaluatePlatformEligibility(product, context),
    taxonomy: taxonomyValuesForProduct(product, context),
  };
}

function localizedText(name) {
  if (typeof name === "string") return name;
  return [name?.en, name?.ku, name?.ar].map((value) => String(value || "")).join(" ");
}

export async function listCategorySetup({ partner, q, status, page, limit }) {
  const [{ collections }, configs, notices] = await Promise.all([
    discoverBrownCollections(),
    PlatformTaxonomyConfig.find({ partner }).lean(),
    listOpenTaxonomyNotices(partner),
  ]);
  const byCollection = new Map(configs.map((row) => [String(row.brownCollectionId), row.values || {}]));
  const schemaReady = requiredTaxonomyKeys(partner).length > 0;
  let rows = collections.map((row) => {
    const values = byCollection.get(String(row.brownCollectionId)) || {};
    const configured = schemaReady && isTaxonomyComplete(partner, values);
    return {
      id: String(row.brownCollectionId),
      name: row.brownCollectionName,
      categoryName: row.brownCategoryName,
      subCategoryName: row.brownSubCategoryName,
      productCount: Number(row.productCount) || 0,
      configured,
      status: !schemaReady ? "unavailable" : configured ? "configured" : "missing",
      values,
    };
  });
  const configuredCount = rows.filter((row) => row.configured).length;
  const needle = cleanText(q).toLowerCase();
  if (needle) {
    rows = rows.filter((row) => {
      const values = Object.values(row.values || {}).join(" ");
      return `${localizedText(row.categoryName)} ${localizedText(row.subCategoryName)} ${localizedText(row.name)} ${values}`
        .toLowerCase()
        .includes(needle);
    });
  }
  if (status === "configured" || status === "mapped") rows = rows.filter((row) => row.configured);
  if (status === "missing" || status === "unmapped") rows = rows.filter((row) => schemaReady && !row.configured);
  rows.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? 1 : -1;
    return localizedText(a.name).localeCompare(localizedText(b.name));
  });
  return {
    ...paginate(rows, page, limit),
    fields: taxonomyFieldsFor(partner),
    schemaReady,
    counts: {
      total: collections.length,
      configured: configuredCount,
      missing: schemaReady ? Math.max(0, collections.length - configuredCount) : 0,
    },
    notices: notices.notices,
    noticeCount: notices.count,
  };
}

export async function saveCategorySetup(partner, brownCollectionId, input) {
  const collectionId = cleanText(brownCollectionId);
  if (!collectionId) throw inputError("Choose a BrownStore collection");
  const values = sanitizeTaxonomyValues(partner, input);
  const collection = await Product.exists({
    $expr: {
      $eq: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, collectionId],
    },
  });
  if (!collection) throw inputError("That BrownStore collection was not found");
  const saved = await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner, brownCollectionId: collectionId },
    { $set: { partner, brownCollectionId: collectionId, values } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  try {
    await resolveTaxonomyNotices(partner);
  } catch (err) {
    console.error("Taxonomy notice resolve failed:", err?.message || err);
  }
  const noticeCount = await PlatformTaxonomyNotice.countDocuments({ partner, status: "open" });
  return {
    id: collectionId,
    configured: isTaxonomyComplete(partner, saved.values),
    values: saved.values || {},
    noticeCount,
  };
}

export function combineFilters(...filters) {
  const items = filters.filter((filter) => filter && Object.keys(filter).length);
  if (!items.length) return {};
  if (items.length === 1) return items[0];
  return { $and: items };
}
