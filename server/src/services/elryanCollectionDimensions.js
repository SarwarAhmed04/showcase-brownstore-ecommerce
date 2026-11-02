import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { ElryanCollectionDimension } from "../models/ElryanCollectionDimension.js";
import { ElryanDimensionExclusion } from "../models/ElryanDimensionExclusion.js";
import { ElryanStagingDimensionCheck } from "../models/ElryanStagingDimensionCheck.js";
import { ElryanSyncJob } from "../models/ElryanSyncJob.js";
import { ElryanSyncOnePreview } from "../models/ElryanSyncOnePreview.js";
import { discoverBrownCollections } from "../utils/brownTaxonomy.js";
import {
  brownCollectionIdentity,
  elryanCollectionRuleBucket,
  positiveElryanDimension,
  resolveElryanDimensions,
  summarizeCollectionDimensionCoverage,
} from "../utils/elryanDimensionResolve.js";
import { assessElryanDimensionConfirmation } from "../utils/elryanStagingGate.js";
import { toResolvedProduct } from "../utils/productView.js";
import { getElryanConnectionPublic } from "./elryanConnection.js";

const PAGE_CAP = 50;
const ID_CHUNK = 400;

function inputError(message, code, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function actorLabel(actor) {
  const email = String(actor?.email || "").trim().toLowerCase();
  if (email) return email;
  return String(actor?._id || actor?.id || "").trim();
}

export function collectionIdFilter(collectionId) {
  const id = String(collectionId || "").trim();
  const values = [id];
  if (mongoose.isValidObjectId(id)) values.push(new mongoose.Types.ObjectId(id));
  return { "collectionName._id": { $in: values } };
}

function chunks(values, size) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

function objectIds(ids) {
  return [...new Set(ids.map((id) => String(id || "").trim()).filter((id) => mongoose.isValidObjectId(id)))];
}

export function publicCollectionDimensionRule(rule) {
  if (!rule) return null;
  return {
    environment: "staging",
    brownCollectionId: String(rule.brownCollectionId || ""),
    width: rule.width,
    height: rule.height,
    depth: rule.depth,
    unit: "cm",
    applyMode: rule.applyMode,
    enabled: rule.enabled === true,
    verifiedForCollection: rule.verifiedForCollection === true,
    verificationSource: rule.verificationSource || "",
    confirmedAt: rule.confirmedAt || null,
    confirmedBy: rule.confirmedBy || "",
    createdAt: rule.createdAt || null,
    updatedAt: rule.updatedAt || null,
  };
}

export async function loadAllElryanCollectionDimensionRules() {
  const rules = await ElryanCollectionDimension.find({ environment: "staging" }).lean();
  return new Map(rules.map((rule) => [String(rule.brownCollectionId), rule]));
}

/**
 * Batch-load Staging dimension inputs for one preview page.
 * Collection rules can be reused from the job context so each batch does not query them again.
 */
export async function loadElryanDimensionInputs(environment, docs, rulesMap = null) {
  const rules = rulesMap instanceof Map ? rulesMap : new Map();
  if (environment !== "staging" || !Array.isArray(docs) || !docs.length) {
    return { checks: new Map(), exclusions: new Set(), rules };
  }
  const productIds = docs.map((doc) => String(doc._id));
  const collectionIds = [
    ...new Set(
      docs
        .map((doc) => brownCollectionIdentity(doc))
        .filter((identity) => identity.collectionId && !identity.ambiguous)
        .map((identity) => identity.collectionId)
    ),
  ];
  const [checks, exclusions, loadedRules] = await Promise.all([
    ElryanStagingDimensionCheck.find({ environment: "staging", productId: { $in: productIds } }).lean(),
    ElryanDimensionExclusion.find({
      environment: "staging",
      productId: { $in: productIds },
      excluded: true,
    })
      .select("productId")
      .lean(),
    rulesMap instanceof Map
      ? Promise.resolve(null)
      : ElryanCollectionDimension.find({
          environment: "staging",
          brownCollectionId: { $in: collectionIds },
        }).lean(),
  ]);
  if (Array.isArray(loadedRules)) {
    for (const rule of loadedRules) rules.set(String(rule.brownCollectionId), rule);
  }
  return {
    checks: new Map(checks.map((row) => [String(row.productId), row])),
    exclusions: new Set(exclusions.map((row) => String(row.productId))),
    rules,
  };
}

export async function expireElryanPreviewTokens(productIds) {
  const ids = [...new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  let modified = 0;
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const result = await ElryanSyncOnePreview.updateMany(
      { productId: { $in: chunk }, consumedAt: null },
      { $set: { expiresAt: new Date(0) } }
    );
    modified += result.modifiedCount || 0;
  }
  return modified;
}

async function productsInCollection(collectionId, ids) {
  const valid = objectIds(ids);
  const found = [];
  for (const chunk of chunks(valid, ID_CHUNK)) {
    const rows = await Product.find({
      _id: { $in: chunk },
      ...collectionIdFilter(collectionId),
    })
      .select("_id")
      .lean();
    found.push(...rows.map((row) => String(row._id)));
  }
  return new Set(found);
}

const AMBIGUOUS_EXPR = {
  $expr: {
    $and: [
      { $gt: [{ $strLenCP: { $toString: { $ifNull: ["$collectionName.id", ""] } } }, 0] },
      {
        $ne: [
          { $toString: { $ifNull: ["$collectionName._id", ""] } },
          { $toString: { $ifNull: ["$collectionName.id", ""] } },
        ],
      },
    ],
  },
};

async function coverageNumbers(collectionId, rule) {
  const filter = collectionIdFilter(collectionId);
  const [productCount, ambiguousCount, checks, exclusions] = await Promise.all([
    Product.countDocuments(filter),
    Product.countDocuments({ $and: [filter, AMBIGUOUS_EXPR] }),
    ElryanStagingDimensionCheck.find({ environment: "staging", axesConfirmed: true }).lean(),
    ElryanDimensionExclusion.find({ environment: "staging", excluded: true }).select("productId").lean(),
  ]);
  const confirmed = checks.filter((row) => assessElryanDimensionConfirmation(row).confirmed);
  const overrideIds = await productsInCollection(
    collectionId,
    confirmed.map((row) => row.productId)
  );
  const exclusionIds = await productsInCollection(
    collectionId,
    exclusions.map((row) => row.productId)
  );
  let differs = 0;
  if (rule) {
    for (const row of confirmed) {
      if (!overrideIds.has(String(row.productId))) continue;
      const assessed = assessElryanDimensionConfirmation(row);
      if (
        assessed.unit !== "cm" ||
        assessed.width !== Number(rule.width) ||
        assessed.height !== Number(rule.height) ||
        assessed.depth !== Number(rule.depth)
      ) {
        differs += 1;
      }
    }
  }
  let ambiguousOverride = 0;
  for (const chunk of chunks(objectIds([...overrideIds]), ID_CHUNK)) {
    ambiguousOverride += await Product.countDocuments({
      _id: { $in: chunk },
      ...filter,
      ...AMBIGUOUS_EXPR,
    });
  }
  let excludedOverride = 0;
  for (const id of exclusionIds) if (overrideIds.has(id)) excludedOverride += 1;
  return summarizeCollectionDimensionCoverage({
    productCount,
    productOverride: overrideIds.size,
    excludedOnly: Math.max(0, exclusionIds.size - excludedOverride),
    ambiguousOnly: Math.max(0, ambiguousCount - ambiguousOverride),
    differs,
    excluded: exclusionIds.size,
    ambiguous: ambiguousCount,
    rule,
    collectionId,
  });
}

async function collectionSample(collectionId) {
  const [row] = await Product.aggregate([
    { $match: collectionIdFilter(collectionId) },
    {
      $group: {
        _id: null,
        name: { $first: "$collectionName.name" },
        categoryName: { $first: "$category.name" },
        subCategoryName: { $first: "$subCategory.name" },
        categoryIds: { $addToSet: { $toString: { $ifNull: ["$category._id", ""] } } },
        subCategoryIds: { $addToSet: { $toString: { $ifNull: ["$subCategory._id", ""] } } },
      },
    },
  ]);
  const categoryIds = (row?.categoryIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  const subCategoryIds = (row?.subCategoryIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  return {
    brownCollectionName: row?.name || {},
    brownCategoryName: row?.categoryName || {},
    brownSubCategoryName: row?.subCategoryName || {},
    ambiguousHierarchy: categoryIds.length > 1 || subCategoryIds.length > 1,
  };
}

export async function listElryanCollectionDimensionCatalog() {
  const [discovered, rules, connection] = await Promise.all([
    discoverBrownCollections(),
    ElryanCollectionDimension.find({ environment: "staging" }).lean(),
    getElryanConnectionPublic(),
  ]);
  const byId = new Map(rules.map((rule) => [String(rule.brownCollectionId), publicCollectionDimensionRule(rule)]));
  return {
    environment: "staging",
    activeEnvironment: connection.environment === "production" ? "production" : "staging",
    stagingOnly: true,
    sentToElryan: 0,
    diagnostics: discovered.diagnostics,
    collections: discovered.collections.map((row) => ({
      ...row,
      rule: byId.get(row.brownCollectionId) || null,
    })),
  };
}

export async function getElryanCollectionDimensionDetail(brownCollectionId) {
  const collectionId = String(brownCollectionId || "").trim();
  if (!collectionId) throw inputError("Choose a BrownStore collection.", "collection_required");
  const [rule, sample, connection] = await Promise.all([
    ElryanCollectionDimension.findOne({ environment: "staging", brownCollectionId: collectionId }).lean(),
    collectionSample(collectionId),
    getElryanConnectionPublic(),
  ]);
  const counts = await coverageNumbers(collectionId, rule);
  if (!counts.productCount) throw inputError("That BrownStore collection was not found.", "collection_not_found");
  return {
    environment: "staging",
    activeEnvironment: connection.environment === "production" ? "production" : "staging",
    stagingOnly: true,
    sentToElryan: 0,
    brownCollectionId: collectionId,
    ...sample,
    rule: publicCollectionDimensionRule(rule),
    counts,
    inheritance: elryanCollectionRuleBucket(rule, collectionId).bucket,
  };
}

async function assertNoActivePreview() {
  const active = await ElryanSyncJob.findOne({
    environment: "staging",
    status: { $in: ["running", "paused"] },
  })
    .select("_id status")
    .lean();
  if (active) {
    throw inputError(
      "Pause or stop the active Elryan preview before changing collection dimensions, so one preview does not mix old and new carton sizes.",
      "sync_active",
      409
    );
  }
}

export async function invalidateInheritedDimensionPreviews(brownCollectionId) {
  const filter = collectionIdFilter(brownCollectionId);
  let affectedProducts = 0;
  let invalidatedPreviewTokens = 0;
  let lastId = null;
  while (true) {
    const pageFilter = lastId ? { $and: [filter, { _id: { $gt: lastId } }] } : filter;
    const products = await Product.find(pageFilter).sort({ _id: 1 }).select("_id").limit(ID_CHUNK).lean();
    if (!products.length) break;
    lastId = products[products.length - 1]._id;
    const ids = products.map((row) => String(row._id));
    const checks = await ElryanStagingDimensionCheck.find({
      environment: "staging",
      productId: { $in: ids },
    }).lean();
    const protectedIds = new Set(
      checks.filter((row) => assessElryanDimensionConfirmation(row).confirmed).map((row) => String(row.productId))
    );
    const inherited = ids.filter((id) => !protectedIds.has(id));
    affectedProducts += inherited.length;
    invalidatedPreviewTokens += await expireElryanPreviewTokens(inherited);
    if (products.length < ID_CHUNK) break;
  }
  return { affectedProducts, invalidatedPreviewTokens, confirmedSendsUnchanged: true, rebuiltOnNextPreview: true };
}

export async function saveElryanCollectionDimension(input = {}, actor = null) {
  if (input.confirm !== true) {
    throw inputError("Saving a collection dimension rule requires confirm=true.", "confirm_required");
  }
  if (String(input.environment || "staging") !== "staging") {
    throw inputError("Collection dimension rules can be stored for Staging only. Production is unchanged.", "staging_only");
  }
  const brownCollectionId = String(input.brownCollectionId || "").trim();
  if (!brownCollectionId) throw inputError("Choose a BrownStore collection.", "collection_required");
  const applyMode = String(input.applyMode || "");
  if (!["AUTO_APPLY", "SUGGEST_REVIEW", "DISABLED"].includes(applyMode)) {
    throw inputError("Apply mode must be AUTO_APPLY, SUGGEST_REVIEW, or DISABLED.", "invalid_apply_mode");
  }
  if (String(input.unit || "cm").trim() !== "cm") {
    throw inputError("Collection dimensions must use centimetres.", "invalid_unit");
  }
  const width = positiveElryanDimension(input.width);
  const height = positiveElryanDimension(input.height);
  const depth = positiveElryanDimension(input.depth);
  if (!width || !height || !depth) {
    throw inputError("Width, height, and depth must be positive centimetres. Nothing was assumed.", "invalid_dimensions");
  }
  if (applyMode === "AUTO_APPLY" && (input.confirmAutoApply !== true || input.verifiedForCollection !== true)) {
    throw inputError(
      "AUTO_APPLY needs explicit confirmation that these packed shipping-carton dimensions apply to the collection's eligible products.",
      "auto_apply_confirmation_required"
    );
  }
  const exists = await Product.exists(collectionIdFilter(brownCollectionId));
  if (!exists) throw inputError("That BrownStore collection was not found.", "collection_not_found");
  await assertNoActivePreview();

  const enabled = applyMode !== "DISABLED" && input.enabled === true;
  const verifiedForCollection = applyMode === "AUTO_APPLY" && input.verifiedForCollection === true;
  const saved = await ElryanCollectionDimension.findOneAndUpdate(
    { environment: "staging", brownCollectionId },
    {
      $set: {
        width,
        height,
        depth,
        unit: "cm",
        applyMode,
        enabled,
        verifiedForCollection,
        verificationSource: verifiedForCollection ? "operator" : "",
        confirmedAt: new Date(),
        confirmedBy: actorLabel(actor),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  const invalidation = await invalidateInheritedDimensionPreviews(brownCollectionId);
  return {
    ok: true,
    sentToElryan: 0,
    productWrites: false,
    rule: publicCollectionDimensionRule(saved),
    invalidation,
  };
}

async function loadSku(productId, sku) {
  if (!mongoose.isValidObjectId(productId)) throw inputError("Product not found", "product_not_found", 404);
  const doc = await Product.findById(productId).lean();
  if (!doc) throw inputError("Product not found", "product_not_found", 404);
  const resolved = toResolvedProduct(doc);
  const actual = String(resolved?.sku || "");
  const requested = String(sku || actual).trim();
  if (!actual || requested !== actual) throw inputError("SKU does not match this BrownStore product.", "sku_mismatch");
  return { doc, sku: actual };
}

export async function setElryanDimensionExclusion(input = {}, actor = null) {
  if (input.confirm !== true) {
    throw inputError("Changing collection inheritance requires confirm=true.", "confirm_required");
  }
  if (String(input.environment || "staging") !== "staging") {
    throw inputError("Collection inheritance exclusions are Staging only.", "staging_only");
  }
  const loaded = await loadSku(input.productId, input.sku);
  const productId = String(loaded.doc._id);
  if (input.excluded === false) {
    await ElryanDimensionExclusion.deleteOne({ environment: "staging", productId });
  } else if (input.excluded === true) {
    await ElryanDimensionExclusion.findOneAndUpdate(
      { environment: "staging", productId },
      {
        $set: {
          sku: loaded.sku,
          excluded: true,
          confirmedAt: new Date(),
          confirmedBy: actorLabel(actor),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } else {
    throw inputError("excluded must be true or false.", "invalid_exclusion");
  }
  const invalidatedPreviewTokens = await expireElryanPreviewTokens([productId]);
  return {
    ok: true,
    sentToElryan: 0,
    environment: "staging",
    productId,
    sku: loaded.sku,
    excluded: input.excluded === true,
    invalidatedPreviewTokens,
  };
}

function exceptionKind(resolution, rule) {
  if (resolution.source === "PRODUCT_OVERRIDE") {
    if (!rule) return "product_override";
    if (
      resolution.unit !== "cm" ||
      resolution.width !== Number(rule.width) ||
      resolution.height !== Number(rule.height) ||
      resolution.depth !== Number(rule.depth)
    ) {
      return "differs";
    }
    return "product_override";
  }
  if (resolution.reason === "excluded") return "excluded";
  if (resolution.reason === "ambiguous_collection" || resolution.reason === "missing_collection") return "ambiguous";
  if (resolution.reason === "invalid_dimensions") return "invalid";
  if (resolution.source === "SUGGESTED") return "suggested";
  if (resolution.reason === "disabled" || resolution.reason === "unverified_collection") return "disabled";
  if (resolution.source === "COLLECTION_AUTO") return "inherited";
  return "missing";
}

function presentException(doc, rule, checks, exclusions) {
  const productId = String(doc._id);
  const identity = brownCollectionIdentity(doc);
  const resolution = resolveElryanDimensions({
    environment: "staging",
    product: doc,
    dimensionRow: checks.get(productId) || null,
    collectionRule: !identity.ambiguous && identity.collectionId === String(rule?.brownCollectionId || "") ? rule : null,
    excluded: exclusions.has(productId),
  });
  const resolved = toResolvedProduct(doc);
  return {
    productId,
    sku: resolved?.sku || doc.itemCode || "",
    name: resolved?.name || doc.name || {},
    exceptionKind: exceptionKind(resolution, rule),
    source: resolution.source,
    reason: resolution.reason,
    unit: resolution.unit,
    width: resolution.width,
    height: resolution.height,
    depth: resolution.depth,
    suggestion: resolution.suggestion,
    differs: exceptionKind(resolution, rule) === "differs",
    excluded: exclusions.has(productId),
  };
}

async function classifyProducts(docs, rule) {
  if (!docs.length) return [];
  const ids = docs.map((doc) => String(doc._id));
  const [checks, exclusions] = await Promise.all([
    ElryanStagingDimensionCheck.find({ environment: "staging", productId: { $in: ids } }).lean(),
    ElryanDimensionExclusion.find({ environment: "staging", productId: { $in: ids }, excluded: true })
      .select("productId")
      .lean(),
  ]);
  const checkMap = new Map(checks.map((row) => [String(row.productId), row]));
  const exclusionSet = new Set(exclusions.map((row) => String(row.productId)));
  return docs.map((doc) => presentException(doc, rule, checkMap, exclusionSet));
}

async function boundedExceptionDocs(collectionId, rule) {
  const filter = collectionIdFilter(collectionId);
  const [checks, exclusions, ambiguous] = await Promise.all([
    ElryanStagingDimensionCheck.find({ environment: "staging", axesConfirmed: true }).select("productId").lean(),
    ElryanDimensionExclusion.find({ environment: "staging", excluded: true }).select("productId").lean(),
    Product.find({ $and: [filter, AMBIGUOUS_EXPR] })
      .select("itemCode overrides.sku name collectionName")
      .limit(300)
      .lean(),
  ]);
  const ids = [
    ...new Set([
      ...checks.map((row) => String(row.productId)),
      ...exclusions.map((row) => String(row.productId)),
    ]),
  ];
  const extra = [];
  for (const chunk of chunks(objectIds(ids), ID_CHUNK)) {
    const rows = await Product.find({ _id: { $in: chunk }, ...filter })
      .select("itemCode overrides.sku name collectionName")
      .lean();
    extra.push(...rows);
  }
  const byId = new Map();
  for (const doc of [...ambiguous, ...extra]) byId.set(String(doc._id), doc);
  return { docs: [...byId.values()], truncated: ambiguous.length >= 300 };
}

export async function listElryanDimensionExceptions({
  brownCollectionId,
  reason = "",
  page = 1,
  limit = 25,
} = {}) {
  const collectionId = String(brownCollectionId || "").trim();
  const detail = await getElryanCollectionDimensionDetail(collectionId);
  const rule = detail.rule
    ? await ElryanCollectionDimension.findOne({ environment: "staging", brownCollectionId: collectionId }).lean()
    : null;
  const take = Math.min(PAGE_CAP, Math.max(1, Number(limit) || 25));
  const pageNum = Math.max(1, Number(page) || 1);
  const kind = String(reason || "").trim();
  const boundedKind = !kind || ["differs", "product_override", "excluded", "ambiguous"].includes(kind);
  const autoLike = detail.inheritance === "auto";
  if (boundedKind && (autoLike || kind)) {
    const bounded = await boundedExceptionDocs(collectionId, rule);
    const classified = await classifyProducts(bounded.docs, rule);
    const filtered = classified.filter((row) => {
      if (row.exceptionKind === "inherited") return false;
      if (!kind) return true;
      if (kind === "product_override") return row.exceptionKind === "product_override" || row.exceptionKind === "differs";
      return row.exceptionKind === kind;
    });
    filtered.sort((left, right) => left.sku.localeCompare(right.sku));
    const skip = (pageNum - 1) * take;
    return {
      ok: true,
      environment: "staging",
      sentToElryan: 0,
      brownCollectionId: collectionId,
      counts: detail.counts,
      page: pageNum,
      limit: take,
      total: filtered.length,
      truncated: bounded.truncated,
      rows: filtered.slice(skip, skip + take),
    };
  }
  const skip = (pageNum - 1) * take;
  const docs = await Product.find(collectionIdFilter(collectionId))
    .sort({ _id: 1 })
    .skip(skip)
    .limit(take)
    .select("itemCode overrides.sku name collectionName")
    .lean();
  const classified = await classifyProducts(docs, rule);
  const rows = kind ? classified.filter((row) => row.exceptionKind === kind) : classified.filter((row) => row.exceptionKind !== "inherited");
  const total = kind === "suggested"
    ? detail.counts.suggested
    : kind === "invalid"
      ? detail.counts.invalid
      : kind === "missing" || kind === "disabled"
        ? detail.counts.missing
        : Math.max(0, detail.counts.productCount - detail.counts.collectionAuto);
  return {
    ok: true,
    environment: "staging",
    sentToElryan: 0,
    brownCollectionId: collectionId,
    counts: detail.counts,
    page: pageNum,
    limit: take,
    total,
    truncated: false,
    rows,
  };
}
