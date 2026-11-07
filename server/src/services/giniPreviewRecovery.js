import mongoose from "mongoose";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncProductResult } from "../models/GiniSyncProductResult.js";
import { Product } from "../models/Product.js";
import { fetchGiniCategoryTree } from "./giniConnection.js";
import { GiniBulkError, assessGiniPreviewProduct, loadGiniPreviewAssessmentContext } from "./giniSyncAll.js";
import { localConfirmedCatalogDecision } from "../utils/giniCatalogSync.js";
import { canReuseLocalPreviewRow } from "../utils/giniPreviewRecovery.js";

const SAMPLE_LIMIT = 20;
const ELIGIBILITY_CODES = new Set([
  "product_inactive",
  "platform_inactive",
  "category_inactive",
  "subcategory_inactive",
  "collection_inactive",
  "brand_inactive",
  "vendor_inactive",
  "vendor_brand_inactive",
]);

function sample(ids) {
  return ids.slice(0, SAMPLE_LIMIT);
}

function eligibilityKey(codes) {
  return [...(codes || [])]
    .map(String)
    .filter((code) => ELIGIBILITY_CODES.has(code))
    .sort()
    .join("|");
}

function snapshotJob(job) {
  if (!job) return null;
  return {
    status: job.status,
    catalogSignature: job.catalogSignature || "",
    policySignature: job.policySignature || "",
    processed: job.processed || 0,
    readyCreate: job.readyCreate || 0,
    updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : "",
  };
}

/**
 * Read-only comparison of one preview's stored rows with the current catalog.
 * Does not write, does not look up GINI products, and does not treat READY_CREATE as absence.
 */
export async function diagnoseGiniPreviewRecovery(sourceJobId) {
  if (!mongoose.isValidObjectId(String(sourceJobId || ""))) {
    throw new GiniBulkError("A GINI preview job is required.", { status: 404, code: "preview_required" });
  }
  const source = await GiniSyncJob.findById(sourceJobId).lean();
  if (!source || source.partner !== "gini" || source.mode !== "preview") {
    throw new GiniBulkError("A GINI preview job is required.", { status: 404, code: "preview_required" });
  }
  const before = snapshotJob(source);
  const jobsBefore = await GiniSyncJob.countDocuments();
  const rowsBefore = await GiniSyncProductResult.countDocuments();
  const live = await fetchGiniCategoryTree();
  if (live.connectionRequired) {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  const shared = await loadGiniPreviewAssessmentContext(live.categories);
  const [products, rows] = await Promise.all([
    Product.find().sort({ _id: 1 }).lean(),
    GiniSyncProductResult.find({ jobId: source._id })
      .select("productId sku skuKey classification blockers payloadHash")
      .lean(),
  ]);
  const rowById = new Map(rows.map((row) => [String(row.productId), row]));
  const liveIds = new Set(products.map((doc) => String(doc._id)));
  const deleted = [];
  const missing = [];
  const payloadMatches = [];
  const payloadChanged = [];
  const ownershipChanges = [];
  const eligibilityChanges = [];
  const locallyReusable = [];
  const freshLookup = [];
  const reusableByClassification = {};
  const freshLookupByPrior = {};

  for (const row of rows) {
    if (!liveIds.has(String(row.productId))) deleted.push(String(row.productId));
  }
  for (const doc of products) {
    const productId = String(doc._id);
    const row = rowById.get(productId) || null;
    if (!row) missing.push(productId);
    const assessed = assessGiniPreviewProduct(doc, shared);
    if (row) {
      if (String(row.payloadHash || "") === String(assessed.payloadHash || "")) payloadMatches.push(productId);
      else payloadChanged.push(productId);
      if (assessed.skuKey) {
        const sourceDuplicate = (row.blockers || []).includes("duplicate_brownstore_sku");
        const soleOwner = assessed.ownerIds.length === 1 && assessed.ownerIds[0] === productId;
        if (sourceDuplicate === soleOwner) ownershipChanges.push(productId);
      }
      if (eligibilityKey(row.blockers) !== eligibilityKey(assessed.inactiveCodes)) eligibilityChanges.push(productId);
      if (!assessed.requiresLookup && canReuseLocalPreviewRow(row, assessed.evaluation)) {
        locallyReusable.push(productId);
        reusableByClassification[row.classification] = (reusableByClassification[row.classification] || 0) + 1;
      }
    }
    const localSend =
      shared.sendByProduct.get(productId) || (assessed.skuKey ? shared.sendBySku.get(assessed.skuKey) : null) || null;
    const confirmedUnchanged =
      assessed.requiresLookup &&
      localSend?.giniProductId &&
      localConfirmedCatalogDecision({ plan: assessed.localPlan, localSend }).action === "store";
    if (assessed.requiresLookup && !confirmedUnchanged) {
      freshLookup.push(productId);
      const prior = row?.classification || "NEW";
      freshLookupByPrior[prior] = (freshLookupByPrior[prior] || 0) + 1;
    }
  }

  const afterJob = await GiniSyncJob.findById(sourceJobId).lean();
  const after = snapshotJob(afterJob);
  if (
    jobsBefore !== (await GiniSyncJob.countDocuments()) ||
    rowsBefore !== (await GiniSyncProductResult.countDocuments()) ||
    JSON.stringify(before) !== JSON.stringify(after)
  ) {
    throw new GiniBulkError("Preview recovery diagnostic must not write.", { status: 500, code: "diagnostic_write" });
  }

  return {
    readOnly: true,
    sourceJobId: String(source._id),
    sourceStatus: source.status,
    readyCreateIsNotRemoteAbsence: true,
    catalogProducts: products.length,
    previewRows: rows.length,
    existingProductRows: rows.length - deleted.length,
    deletedProductIds: deleted.length,
    missingPreviewRows: missing.length,
    payloadMatches: payloadMatches.length,
    payloadChanged: payloadChanged.length,
    skuOwnershipChanges: ownershipChanges.length,
    eligibilityChanges: eligibilityChanges.length,
    locallyReusable: locallyReusable.length,
    freshGiniLookupRequired: freshLookup.length,
    locallyReusableByClassification: reusableByClassification,
    freshLookupByPriorClassification: freshLookupByPrior,
    samples: {
      deletedProductIds: sample(deleted),
      missingPreviewRows: sample(missing),
      payloadChanged: sample(payloadChanged),
      skuOwnershipChanges: sample(ownershipChanges),
      eligibilityChanges: sample(eligibilityChanges),
      locallyReusable: sample(locallyReusable),
      freshGiniLookupRequired: sample(freshLookup),
    },
  };
}
