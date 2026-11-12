import { Commission } from "../models/Commission.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniVariantChangedOperation } from "../models/GiniVariantChangedOperation.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantOperation } from "../models/GiniVariantOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { GiniVariantPricePatch } from "../models/GiniVariantPricePatch.js";
import { performGiniRequest } from "./giniConnection.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { auditDuplicateOwnership } from "../utils/giniVariantOwnershipAudit.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { applyCatalogVariantPrices } from "../utils/giniVariantPricing.js";
import { GINI_VARIANT_UPDATE_CAPABILITIES, unsupportedVariantOperations } from "../utils/giniVariantUpdateContract.js";
import {
  KNOWN_GINI_VARIANT_PARENTS,
  auditBlockedProducts,
  buildGenericChangedPreview,
  collectMissingColors,
  futureBulkPreview,
  interpretColorAttribute,
  isKnownVariantParent,
  planVariantChange,
  publishRemote,
  readRemoteParent,
  readRemoteVariantRows,
  routeGiniOverview,
  selectPricePilot,
  summarizeVariantPlans,
  variantReadCandidates,
} from "../utils/giniVariantChangedPlan.js";

function parentPath(sku) {
  return `/api/v2.0/third-party/products/${encodeURIComponent(sku)}`;
}

function readOnly(perform) {
  return async (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "GET") {
      throw new Error("variant_changed_sync_write_blocked");
    }
    return perform(request);
  };
}

function remoteFor(sku, map) {
  if (!map) return { state: "not_read" };
  return map[sku] || map[giniSkuKey(sku)] || { state: "not_read" };
}

async function readParentAndVariants(perform, sku) {
  try {
    const parent = readRemoteParent(await perform({ method: "GET", path: parentPath(sku) }), sku);
    if (parent.state !== "present") return parent;
    const parsed = readRemoteVariantRows(await perform({ method: "GET", path: `${parentPath(sku)}/variants` }));
    if (parsed.state !== "present") return { ...parent, variants: null };
    return { ...parent, variants: parsed.rows };
  } catch {
    return { state: "uncertain", status: 0, variants: null };
  }
}

function publicPlan(plan) {
  return {
    productId: plan.productId,
    parentSku: plan.parentSku,
    vendorId: plan.vendorId,
    disposition: plan.disposition,
    workflow: plan.workflow,
    knownParent: plan.knownParent,
    canSend: false,
    createAllowed: false,
    blockers: plan.blockers,
    changes: plan.changes,
    manualReview: plan.manualReview,
    differences: plan.differences,
    imageNotes: plan.imageNotes,
    colorPreview: plan.colorPreview,
    priceRows: plan.priceRows,
    proposedPatches: plan.proposedPatches,
    local: plan.local,
  };
}

function selectPilotPlan(plans) {
  const owners = plans.filter((plan) => !(plan.blockers || []).includes("other_vendor_owns_parent"));
  if (owners.length === 1) return owners[0];
  return null;
}

export async function previewVariantChangedSync(deps = {}) {
  const perform = readOnly(deps.perform || performGiniRequest);
  const environment = deps.environment || (process.env.NODE_ENV === "production" ? "production" : "local");
  const catalog = await (deps.loadCatalog || loadVariantCatalog)({ force: true });
  let identities = deps.identities || [];
  let operations = deps.operations || [];
  let owners = deps.owners || [];
  let changedOperations = deps.changedOperations || [];
  let pricePatchJournals = deps.pricePatchJournals || [];
  let commissionRules = deps.commissionRules === undefined ? null : deps.commissionRules;
  let simpleJob = deps.simpleJob === undefined ? null : deps.simpleJob;
  if (deps.skipDatabase !== true) {
    [identities, operations, owners, changedOperations, pricePatchJournals] = await Promise.all([
      deps.identities ? Promise.resolve(deps.identities) : GiniVariantIdentity.find({}).lean(),
      deps.operations ? Promise.resolve(deps.operations) : GiniVariantOperation.find({}).select("productId status").lean(),
      deps.owners !== undefined ? Promise.resolve(deps.owners) : GiniVariantParentOwner.find({}).lean(),
      deps.changedOperations !== undefined ? Promise.resolve(deps.changedOperations) : GiniVariantChangedOperation.find({}).lean(),
      deps.pricePatchJournals !== undefined
        ? Promise.resolve(deps.pricePatchJournals)
        : GiniVariantPricePatch.find({ parentSku: { $in: ["KE20", "EI-8888"] } }).select("parentSku variantId variantSku stage status rawBody").lean(),
    ]);
    if (commissionRules == null) {
      commissionRules = await Commission.find({ partner: "gini", isActive: { $ne: false } }).lean();
    }
    if (deps.simpleJob === undefined) {
      try {
        simpleJob = await GiniSyncJob.findOne({ partner: "gini", mode: "preview" })
          .sort({ createdAt: -1 })
          .select("status readyCreate alreadyExists changed unchanged blocked inactive")
          .lean();
      } catch {
        simpleJob = null;
      }
    }
  }
  let attributeResponse = deps.attributeResponse || null;
  if (!attributeResponse && deps.skipRemote !== true) {
    try {
      attributeResponse = await perform({ method: "GET", path: "/api/v2.0/third-party/attributes/3696" });
    } catch {
      attributeResponse = { status: 0, error: true };
    }
  }
  const color = interpretColorAttribute(attributeResponse);
  const remoteBySku = { ...(deps.remoteBySku || {}) };
  const reads = [];
  const operationByProduct = new Map((operations || []).map((row) => [String(row.productId), row.status || ""]));
  const identityByProduct = new Map();
  for (const row of identities || []) {
    const key = String(row.productId || "");
    if (!identityByProduct.has(key)) identityByProduct.set(key, []);
    identityByProduct.get(key).push(row);
  }
  const parentCounts = new Map();
  for (const product of catalog.products || []) {
    const key = giniSkuKey(product.parentSku);
    if (!key) continue;
    parentCounts.set(key, (parentCounts.get(key) || 0) + 1);
  }
  const sharedParentKeys = new Set([...parentCounts].filter(([, count]) => count > 1).map(([key]) => key));
  if (!deps.remoteBySku && deps.skipRemote !== true) {
    const extra = variantReadCandidates({
      products: catalog.products || [],
      identitiesByProduct: identityByProduct,
      owners,
      colorLabels: color.labels,
      colorAttributeId: color.id,
    });
    const seen = new Set();
    const skus = [];
    for (const sku of [...KNOWN_GINI_VARIANT_PARENTS.map((parent) => parent.parentSku), ...extra]) {
      const key = giniSkuKey(sku);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      skus.push(sku);
    }
    for (const sku of skus) {
      const remote = await readParentAndVariants(perform, sku);
      remoteBySku[sku] = remote;
      reads.push({ method: "GET", parentSku: sku, state: remote.state, status: remote.status || 0 });
    }
  }
  if (!Array.isArray(commissionRules)) commissionRules = [];
  const changedByProduct = new Map();
  for (const row of changedOperations || []) {
    const key = String(row.productId || "");
    if (!changedByProduct.has(key)) changedByProduct.set(key, []);
    changedByProduct.get(key).push(row);
  }
  const plans = (catalog.products || []).map((product) => {
    const priced = applyCatalogVariantPrices(product, commissionRules);
    const owner = (owners || []).find((row) => giniSkuKey(row.parentSku || row.skuKey) === giniSkuKey(priced.parentSku) && String(row.productId || "") === String(priced.productId || "")) || null;
    return planVariantChange({
      productId: priced.productId,
      parentSku: priced.parentSku,
      vendorId: priced.vendorId,
      categoryId: priced.categoryId,
      subcategoryId: priced.subcategoryId,
      combinations: priced.combinations || [],
      identities: identityByProduct.get(String(priced.productId)) || [],
      remote: remoteFor(priced.parentSku, remoteBySku),
      colorLabels: color.labels,
      colorAttributeId: color.id,
      catalogBlockers: priced.blockers || [],
      multipleSizes: priced.multipleSizes === true,
      operationStatus: operationByProduct.get(String(priced.productId)) || "",
      environment,
      identityOrigin: "local",
      variantSkuConflict: (priced.blockers || []).includes("variant_sku_conflict"),
      ownership: "required",
      owner,
      variantOperations: changedByProduct.get(String(priced.productId)) || [],
      pricePatchJournals,
    });
  });
  const { summary, blockerCounts } = summarizeVariantPlans(plans);
  const pilots = KNOWN_GINI_VARIANT_PARENTS.map((parent) => {
    const related = plans.filter((plan) => giniSkuKey(plan.parentSku) === giniSkuKey(parent.parentSku));
    const selected = selectPilotPlan(related);
    const remote = remoteFor(parent.parentSku, remoteBySku);
    return {
      parentSku: parent.parentSku,
      label: parent.label,
      knownParent: true,
      createAllowed: false,
      remote: publishRemote(remote),
      productId: selected?.productId || "",
      disposition: selected?.disposition || (related.length > 1 ? "BLOCKED" : "UNCERTAIN"),
      blockers: selected?.blockers || (related.length ? ["duplicate_parent_sku"] : ["product_not_in_catalog"]),
      differences: selected?.differences || [],
      imageNotes: selected?.imageNotes || [],
      changes: selected?.changes || [],
      manualReview: selected?.manualReview || [],
      priceRows: selected?.priceRows || [],
      proposedPatches: selected?.proposedPatches || [],
      baselineKey: selected?.baselineKey || "",
      local: selected?.local || [],
      candidates: related.map((plan) => ({
        productId: plan.productId,
        vendorId: plan.vendorId,
        disposition: plan.disposition,
        blockers: plan.blockers,
      })),
    };
  });
  const missingColors = collectMissingColors(plans);
  return {
    canSend: false,
    bulkSyncEnabled: false,
    writesEnabled: false,
    environment,
    recordTransfer: "not_copied",
    capabilities: GINI_VARIANT_UPDATE_CAPABILITIES,
    unsupported: unsupportedVariantOperations(),
    colorAttribute: {
      state: color.state,
      id: color.id,
      name: color.name,
      expectedPresent: color.expectedPresent,
      valueCount: Array.isArray(color.labels) ? color.labels.length : 0,
      labels: Array.isArray(color.labels) ? color.labels : [],
    },
    missingColors: missingColors.slice(0, 50),
    summary,
    blockerCounts,
    blockerAudit: auditBlockedProducts(plans),
    ownershipAudit: auditDuplicateOwnership({ products: catalog.products || [], owners, remoteBySku, plans }),
    generic: buildGenericChangedPreview(plans, pricePatchJournals, { sharedParentKeys }),
    overview: routeGiniOverview({ variantSummary: summary, simpleJob }),
    futureBulk: futureBulkPreview(summary),
    pricePilot: selectPricePilot(pilots, changedOperations),
    pilots,
    changed: plans.filter((plan) => plan.disposition === "CHANGED").slice(0, 30).map(publicPlan),
    newProducts: plans.filter((plan) => plan.disposition === "NEW").slice(0, 30).map(publicPlan),
    uncertain: plans.filter((plan) => plan.disposition === "UNCERTAIN").slice(0, 30).map(publicPlan),
    remoteReads: reads,
    knownParentsCreateBlocked: KNOWN_GINI_VARIANT_PARENTS.every((parent) => isKnownVariantParent(parent.parentSku)),
  };
}
