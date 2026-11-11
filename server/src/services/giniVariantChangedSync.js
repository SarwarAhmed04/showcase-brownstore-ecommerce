import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantOperation } from "../models/GiniVariantOperation.js";
import { performGiniRequest } from "./giniConnection.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { GINI_VARIANT_UPDATE_CAPABILITIES, unsupportedVariantOperations } from "../utils/giniVariantUpdateContract.js";
import {
  KNOWN_GINI_VARIANT_PARENTS,
  collectMissingColors,
  futureBulkPreview,
  interpretColorAttribute,
  isKnownVariantParent,
  planVariantChange,
  publishRemote,
  readRemoteParent,
  readRemoteVariantRows,
  routeGiniOverview,
  summarizeVariantPlans,
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
  let simpleJob = deps.simpleJob === undefined ? null : deps.simpleJob;
  if (deps.skipDatabase !== true) {
    [identities, operations] = await Promise.all([
      deps.identities ? Promise.resolve(deps.identities) : GiniVariantIdentity.find({}).lean(),
      deps.operations ? Promise.resolve(deps.operations) : GiniVariantOperation.find({}).select("productId status").lean(),
    ]);
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
  if (!deps.remoteBySku && deps.skipRemote !== true) {
    for (const parent of KNOWN_GINI_VARIANT_PARENTS) {
      const remote = await readParentAndVariants(perform, parent.parentSku);
      remoteBySku[parent.parentSku] = remote;
      reads.push({ method: "GET", parentSku: parent.parentSku, state: remote.state, status: remote.status || 0 });
    }
  }
  const operationByProduct = new Map((operations || []).map((row) => [String(row.productId), row.status || ""]));
  const identityByProduct = new Map();
  for (const row of identities || []) {
    const key = String(row.productId || "");
    if (!identityByProduct.has(key)) identityByProduct.set(key, []);
    identityByProduct.get(key).push(row);
  }
  const plans = (catalog.products || []).map((product) => planVariantChange({
    productId: product.productId,
    parentSku: product.parentSku,
    vendorId: product.vendorId,
    categoryId: product.categoryId,
    subcategoryId: product.subcategoryId,
    combinations: product.combinations || [],
    identities: identityByProduct.get(String(product.productId)) || [],
    remote: remoteFor(product.parentSku, remoteBySku),
    colorLabels: color.labels,
    colorAttributeId: color.id,
    catalogBlockers: product.blockers || [],
    multipleSizes: product.multipleSizes === true,
    operationStatus: operationByProduct.get(String(product.productId)) || "",
    environment,
    identityOrigin: "local",
    variantSkuConflict: (product.blockers || []).includes("variant_sku_conflict"),
  }));
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
    overview: routeGiniOverview({ variantSummary: summary, simpleJob }),
    futureBulk: futureBulkPreview(summary),
    pilots,
    changed: plans.filter((plan) => plan.disposition === "CHANGED").slice(0, 30).map(publicPlan),
    newProducts: plans.filter((plan) => plan.disposition === "NEW").slice(0, 30).map(publicPlan),
    uncertain: plans.filter((plan) => plan.disposition === "UNCERTAIN").slice(0, 30).map(publicPlan),
    remoteReads: reads,
    knownParentsCreateBlocked: KNOWN_GINI_VARIANT_PARENTS.every((parent) => isKnownVariantParent(parent.parentSku)),
  };
}
