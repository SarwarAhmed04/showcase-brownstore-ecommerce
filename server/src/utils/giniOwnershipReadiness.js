import { ObjectId } from "mongodb";
import { assessOwnershipIndexes, OWNERSHIP_OPERATION_COLLECTION, OWNERSHIP_PARENT_COLLECTION } from "./giniOwnershipIndexPlan.js";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./giniVariantOwnershipAudit.js";
import { OWNERSHIP_PILOT_SKU, rememberVerifiedSnapshot, verifyOwnershipDatabase } from "./giniOwnershipProductionContext.js";

export { OWNERSHIP_PILOT_SKU };

export const LAST_OWNERSHIP_REVIEW = Object.freeze({
  parentSku: OWNERSHIP_PILOT_SKU,
  duplicateProducts: 2,
  saved: false,
  ownerRecorded: false,
  operationRecorded: false,
  sentToGini: 0,
});

const READ_OPERATIONS = Object.freeze(["listCollections", "listIndexes", "aggregate", "find"]);

export function ownershipDuplicatePipelines() {
  return {
    ownersBySkuKey: [
      { $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ["$skuKey", ""] } } } },
        count: { $sum: 1 },
        productIds: { $addToSet: { $toString: { $ifNull: ["$productId", ""] } } },
        statuses: { $addToSet: { $ifNull: ["$status", ""] } },
        parentSkus: { $addToSet: { $ifNull: ["$parentSku", ""] } },
      } },
      { $match: { count: { $gt: 1 } } },
    ],
    ownersByParentSku: [
      { $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ["$parentSku", ""] } } } },
        skuKeys: { $addToSet: { $toLower: { $trim: { input: { $ifNull: ["$skuKey", ""] } } } } },
        count: { $sum: 1 },
        productIds: { $addToSet: { $toString: { $ifNull: ["$productId", ""] } } },
        statuses: { $addToSet: { $ifNull: ["$status", ""] } },
      } },
      { $match: { count: { $gt: 1 } } },
    ],
    operationsByKey: [
      { $group: {
        _id: { $ifNull: ["$operationKey", ""] },
        count: { $sum: 1 },
        productIds: { $addToSet: { $toString: { $ifNull: ["$productId", ""] } } },
        skuKeys: { $addToSet: { $toLower: { $trim: { input: { $ifNull: ["$skuKey", ""] } } } } },
      } },
      { $match: { count: { $gt: 1 } } },
    ],
    operationsBySku: [
      { $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: ["$skuKey", ""] } } } },
        count: { $sum: 1 },
        operationKeys: { $addToSet: { $ifNull: ["$operationKey", ""] } },
        productIds: { $addToSet: { $toString: { $ifNull: ["$productId", ""] } } },
      } },
      { $match: { count: { $gt: 1 } } },
    ],
    ownerStatus: [
      { $group: { _id: { $ifNull: ["$status", ""] }, count: { $sum: 1 } } },
    ],
  };
}

export function pilotSkuMatch(sku = OWNERSHIP_PILOT_SKU) {
  const escaped = String(sku).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { $regex: `^\\s*${escaped}\\s*$`, $options: "i" };
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (typeof value === "object") {
    if (value._id) return text(value._id);
    return text(value.en || value.name || value.ku || value.ar || "");
  }
  return "";
}

function idCandidates(value) {
  const id = text(value);
  if (!id) return [];
  if (!/^[a-f0-9]{24}$/i.test(id)) return [id];
  try {
    return [id, new ObjectId(id)];
  } catch {
    return [id];
  }
}

function skuKey(value) {
  return text(value).replace(/\s+/g, "-").toLowerCase();
}

export function publicOwnershipIndex(index) {
  return {
    name: String(index?.name || ""),
    key: index?.key || {},
    unique: index?.unique === true,
    sparse: index?.sparse === true,
  };
}

function vendorOf(value) {
  if (value && typeof value === "object") {
    return { id: text(value._id || value.id), name: text(value.name || value.en) };
  }
  return { id: text(value), name: "" };
}

export function publicPilotProduct(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const imageCount = variants.reduce((sum, variant) => sum + (Array.isArray(variant?.images) ? variant.images.filter((image) => image?.url).length : 0), 0);
  return {
    productId: text(product?._id),
    parentSku: text(product?.itemCode || product?.sku),
    sourceItemId: text(product?.ibsherId),
    vendorId: vendorOf(product?.createdBy).id,
    vendor: vendorOf(product?.createdBy).name,
    name: text(product?.name),
    variantCount: variants.length,
    imageCount,
  };
}

export function publicOwner(owner) {
  return {
    skuKey: text(owner?.skuKey),
    parentSku: text(owner?.parentSku),
    productId: text(owner?.productId),
    vendorId: text(owner?.vendorId),
    status: text(owner?.status),
    hasRemoteProductId: Boolean(text(owner?.giniProductId)),
  };
}

export function publicOperation(operation) {
  return {
    operationKey: text(operation?.operationKey),
    skuKey: text(operation?.skuKey),
    parentSku: text(operation?.parentSku),
    productId: text(operation?.productId),
    vendorId: text(operation?.vendorId),
    sourceItemId: text(operation?.sourceItemId),
    excludedProductIds: (operation?.excludedProductIds || []).map((id) => text(id)).filter(Boolean),
    status: text(operation?.status),
  };
}

function limited(rows, count = 20) {
  return (rows || []).slice(0, count).map((row) => ({
    key: row._id == null ? "" : String(row._id),
    count: row.count,
    productIds: row.productIds || [],
    statuses: row.statuses || [],
    parentSkus: row.parentSkus || [],
    skuKeys: row.skuKeys || [],
    operationKeys: row.operationKeys || [],
  }));
}

export function summarizeOwnershipReadiness({
  parentCollection = "",
  parentIndexes = [],
  ownerStatus = [],
  duplicateSkuKeys = [],
  duplicateParentSkus = [],
  operationCollection = "",
  operationIndexes = [],
  duplicateOperationKeys = [],
  duplicateOperationSkus = [],
  missingOwnerProducts = [],
  ownerSkuMismatches = [],
  operationMismatches = [],
  pilotProducts = [],
  pilotOwners = [],
  pilotOperations = [],
} = {}) {
  const indexes = assessOwnershipIndexes({
    collectionName: operationCollection,
    indexes: operationIndexes,
    duplicateOperationKeys: duplicateOperationKeys.length,
    duplicateSkuKeys: duplicateOperationSkus.length + duplicateSkuKeys.length,
    parentOwnerIndexes: parentCollection ? parentIndexes : [],
  });
  const products = pilotProducts.map(publicPilotProduct);
  const owners = pilotOwners.map(publicOwner);
  const operations = pilotOperations.map(publicOperation);
  const productIds = new Set(products.map((row) => row.productId));
  const ownerOutsidePair = owners.filter((row) => row.productId && !productIds.has(row.productId));
  const comparedWithLastReview = {
    parentSku: LAST_OWNERSHIP_REVIEW.parentSku,
    lastReviewSaved: false,
    lastReviewExpectedProducts: LAST_OWNERSHIP_REVIEW.duplicateProducts,
    currentProductCount: products.length,
    currentOwnerCount: owners.length,
    currentOperationCount: operations.length,
    productCountMatches: products.length === LAST_OWNERSHIP_REVIEW.duplicateProducts,
    stillUnowned: owners.length === 0 && operations.length === 0,
    productIds: products.map((row) => row.productId),
    vendors: products.map((row) => row.vendor || row.vendorId),
    sourceItemIds: products.map((row) => row.sourceItemId),
  };
  const conflicts = {
    duplicateOwnerSkuKeys: limited(duplicateSkuKeys),
    duplicateOwnerParentSkus: limited(duplicateParentSkus),
    duplicateOperationKeys: limited(duplicateOperationKeys),
    duplicateOperationSkus: limited(duplicateOperationSkus),
    missingOwnerProducts,
    ownerSkuMismatches,
    operationMismatches,
    pilotOwnerOutsideCurrentProducts: ownerOutsidePair,
  };
  const conflictCount = conflicts.duplicateOwnerSkuKeys.length
    + conflicts.duplicateOwnerParentSkus.length
    + conflicts.duplicateOperationKeys.length
    + conflicts.duplicateOperationSkus.length
    + conflicts.missingOwnerProducts.length
    + conflicts.ownerSkuMismatches.length
    + conflicts.operationMismatches.length
    + conflicts.pilotOwnerOutsideCurrentProducts.length;
  const missing = [];
  if (!parentCollection) missing.push("ginivariantparentowners collection");
  if (indexes.parentOwnerIndexIntact !== true) missing.push("unique parent-owner skuKey index");
  if (!indexes.collectionExists) missing.push("ginivariantownershipoperations collection");
  if (!indexes.operationKeyEnforced) missing.push("unique operationKey index");
  if (!indexes.skuKeyEnforced) missing.push("unique ownership-operation skuKey index");
  const gatesOpen = OWNERSHIP_SAVE_RELEASED === true || OWNERSHIP_SAVE_INDEXES_READY === true;
  return {
    readOnly: true,
    operations: READ_OPERATIONS,
    saved: false,
    sentToGini: 0,
    readyForOwnershipSave: false,
    gates: {
      released: OWNERSHIP_SAVE_RELEASED === true,
      indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
      pilotParentSku: OWNERSHIP_SAVE_PILOT.parentSku,
      pilotProductId: OWNERSHIP_SAVE_PILOT.productId,
      anyOpen: gatesOpen,
    },
    ownerStatus: ownerStatus.map((row) => ({ status: String(row._id || ""), count: row.count })),
    indexes,
    conflicts,
    conflictCount,
    missing,
    migration: {
      safeToPrepare: indexes.parentOwnerIndexIntact === true && indexes.duplicatesWouldPreventIndexCreation !== true && conflictCount === 0,
      executedByThisAudit: false,
      commands: indexes.commands,
    },
    pilot: {
      parentSku: OWNERSHIP_PILOT_SKU,
      products,
      owners,
      operations,
      comparedWithLastReview,
    },
  };
}

export function stoppedOwnershipReport() {
  return {
    readOnly: true,
    code: "production_context_unverified",
    stopped: true,
    saved: false,
    sentToGini: 0,
    readyForOwnershipSave: false,
    operations: [],
    gates: {
      released: OWNERSHIP_SAVE_RELEASED === true,
      indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
      pilotParentSku: OWNERSHIP_SAVE_PILOT.parentSku,
      pilotProductId: OWNERSHIP_SAVE_PILOT.productId,
      anyOpen: OWNERSHIP_SAVE_RELEASED === true || OWNERSHIP_SAVE_INDEXES_READY === true,
    },
    indexes: null,
    conflicts: null,
    conflictCount: null,
    missing: [],
    migration: { safeToPrepare: false, executedByThisAudit: false, commands: [] },
    pilot: null,
    productionSnapshot: null,
  };
}

export async function readOwnershipReadiness(db, { sku = OWNERSHIP_PILOT_SKU, confirmProduction = false, allowLoopback = false, loopback = false } = {}) {
  const verdict = await verifyOwnershipDatabase(db, { confirmProduction, allowLoopback, loopback });
  if (!verdict.ok) return stoppedOwnershipReport();
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  const parentName = names.get(OWNERSHIP_PARENT_COLLECTION) || "";
  const operationName = names.get(OWNERSHIP_OPERATION_COLLECTION) || "";
  const productName = names.get("products") || "";
  const pipelines = ownershipDuplicatePipelines();
  const parent = parentName ? db.collection(parentName) : null;
  const operations = operationName ? db.collection(operationName) : null;
  const products = productName ? db.collection(productName) : null;
  const parentIndexes = parent ? (await parent.listIndexes().toArray()).map(publicOwnershipIndex) : [];
  const operationIndexes = operations ? (await operations.listIndexes().toArray()).map(publicOwnershipIndex) : [];
  const [duplicateSkuKeys, duplicateParentSkus, ownerStatus, duplicateOperationKeys, duplicateOperationSkus] = await Promise.all([
    parent ? parent.aggregate(pipelines.ownersBySkuKey).toArray() : [],
    parent ? parent.aggregate(pipelines.ownersByParentSku).toArray() : [],
    parent ? parent.aggregate(pipelines.ownerStatus).toArray() : [],
    operations ? operations.aggregate(pipelines.operationsByKey).toArray() : [],
    operations ? operations.aggregate(pipelines.operationsBySku).toArray() : [],
  ]);
  const ownerRows = parent
    ? await parent.find({}, { projection: { skuKey: 1, parentSku: 1, productId: 1, status: 1 } }).toArray()
    : [];
  const operationRows = operations
    ? await operations.find({}, { projection: { operationKey: 1, skuKey: 1, parentSku: 1, productId: 1, sourceItemId: 1, excludedProductIds: 1, status: 1 } }).toArray()
    : [];
  const ownerProductIds = [...new Set(ownerRows.map((row) => text(row.productId)).filter(Boolean))];
  const foundProducts = ownerProductIds.length && products
    ? await products.find(
      { _id: { $in: ownerProductIds.flatMap(idCandidates) } },
      { projection: { itemCode: 1 } }
    ).toArray()
    : [];
  const foundIds = new Set(foundProducts.map((row) => text(row._id)));
  const byId = new Map(foundProducts.map((row) => [text(row._id), skuKey(row.itemCode)]));
  const missingOwnerProducts = ownerRows
    .filter((row) => text(row.productId) && !foundIds.has(text(row.productId)))
    .map((row) => ({ skuKey: text(row.skuKey), productId: text(row.productId), status: text(row.status) }));
  const ownerSkuMismatches = ownerRows
    .filter((row) => byId.has(text(row.productId)) && skuKey(row.skuKey || row.parentSku) && byId.get(text(row.productId)) !== skuKey(row.skuKey || row.parentSku))
    .map((row) => ({
      skuKey: text(row.skuKey),
      productId: text(row.productId),
      productSku: byId.get(text(row.productId)) || "",
    }));
  const ownerBySku = new Map(ownerRows.map((row) => [skuKey(row.skuKey || row.parentSku), row]));
  const operationMismatches = operationRows.flatMap((row) => {
    const owner = ownerBySku.get(skuKey(row.skuKey || row.parentSku));
    const reasons = [];
    if (owner && text(owner.productId) !== text(row.productId)) reasons.push("operation_product_differs_from_owner");
    if ((row.excludedProductIds || []).map(text).includes(text(row.productId))) reasons.push("operation_excludes_its_owner");
    if (!reasons.length) return [];
    return [{ operationKey: text(row.operationKey), skuKey: text(row.skuKey), productId: text(row.productId), reasons }];
  });
  const skuMatch = pilotSkuMatch(sku);
  const pilotProducts = products
    ? await products.find({ $or: [{ itemCode: skuMatch }, { sku: skuMatch }] }).toArray()
    : [];
  const pilotOwners = parent
    ? await parent.find({ $or: [{ skuKey: skuKey(sku) }, { parentSku: skuMatch }] }).toArray()
    : [];
  const pilotOperations = operations
    ? await operations.find({ $or: [{ skuKey: skuKey(sku) }, { parentSku: skuMatch }] }).toArray()
    : [];
  const namesAfter = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => String(item.name).toLowerCase()));
  if (namesAfter.has(OWNERSHIP_OPERATION_COLLECTION) !== Boolean(operationName)) {
    throw new Error("Ownership readiness read changed the operation collection.");
  }
  const report = summarizeOwnershipReadiness({
    parentCollection: parentName,
    parentIndexes,
    ownerStatus,
    duplicateSkuKeys,
    duplicateParentSkus,
    operationCollection: operationName,
    operationIndexes,
    duplicateOperationKeys,
    duplicateOperationSkus,
    missingOwnerProducts,
    ownerSkuMismatches,
    operationMismatches,
    pilotProducts,
    pilotOwners,
    pilotOperations,
  });
  return {
    ...report,
    code: "verified_production_loopback",
    stopped: false,
    productionSnapshot: rememberVerifiedSnapshot({
      productIds: report.pilot.products.map((row) => row.productId),
      sourceItemIds: report.pilot.products.map((row) => row.sourceItemId),
    }),
  };
}

