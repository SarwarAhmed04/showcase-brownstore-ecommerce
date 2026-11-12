import { GiniVariantOwnershipOperation } from "../models/GiniVariantOwnershipOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { acceptFreshProductionSnapshot, OWNERSHIP_PILOT_SKU } from "../utils/giniOwnershipProductionContext.js";
import {
  attemptFutureOwnershipSave,
  auditDuplicateOwnership,
  designFutureOwnershipSave,
  evaluateOwnershipSave,
  interpretOwnershipIndexConflict,
  OWNERSHIP_SAVE_INDEXES_READY,
  OWNERSHIP_SAVE_RELEASED,
  ownershipPilotAllows,
  ownershipSaveAuthorization,
  pageOwnershipGroups,
  planCommitOutcome,
  planOwnershipSelection,
  previewOwnershipSaveDocuments,
} from "../utils/giniVariantOwnershipAudit.js";

const OWNERSHIP_CODES = new Set(["duplicate_parent_sku", "other_vendor_owns_parent"]);

function remoteFromOwners(owners) {
  const remoteBySku = {};
  for (const owner of owners || []) {
    if (!owner?.giniProductId) continue;
    const sku = String(owner.parentSku || owner.skuKey || "");
    if (!sku) continue;
    remoteBySku[sku] = {
      state: "present",
      id: String(owner.giniProductId),
      sku,
      visibility: String(owner.visibility || ""),
      variants: [],
    };
  }
  return remoteBySku;
}

async function currentAudit(deps = {}) {
  const loadCatalog = deps.loadCatalog || loadVariantCatalog;
  const loadOwners = deps.loadOwners || (() => GiniVariantParentOwner.find({}).lean());
  const loadOperations = deps.loadOperations || (() => GiniVariantOwnershipOperation.find({}).lean());
  const [catalog, owners, operations] = await Promise.all([
    loadCatalog({ force: true }),
    loadOwners(),
    loadOperations(),
  ]);
  const products = catalog?.products || [];
  return {
    ...auditDuplicateOwnership({
      products,
      owners,
      plans: products,
      remoteBySku: deps.remoteBySku || remoteFromOwners(owners),
    }),
    owners,
    operations,
  };
}

function excludedCandidates(group, productId) {
  return (group?.candidates || [])
    .filter((row) => String(row.productId) !== String(productId || ""))
    .map((row) => ({
      productId: row.productId,
      name: row.name,
      vendor: row.vendor,
      sourceItemId: row.sourceItemId,
      disposition: "excluded_from_gini_ownership",
      deletedFromBrownStore: false,
    }));
}

export async function listOwnershipGroups({ query = "", page = 1, pageSize = 10 } = {}, deps = {}) {
  const audit = await currentAudit(deps);
  return {
    ...pageOwnershipGroups(audit, { query, page, pageSize }),
    databaseRechecked: true,
    futureSaveAttempt: attemptFutureOwnershipSave(),
  };
}

export async function prepareOwnershipSelection({ parentSku = "", productId = "", confirm = false } = {}, deps = {}) {
  const audit = await currentAudit(deps);
  const group = audit.groups.find((row) => row.parentSkuKey === giniSkuKey(parentSku)) || null;
  const decision = planOwnershipSelection({ group, productId, confirm: confirm === true });
  const selected = group?.candidates?.find((row) => String(row.productId) === String(productId || "")) || null;
  const nextBlockers = (selected?.blockers || []).filter((code) => !OWNERSHIP_CODES.has(code));
  return {
    ...decision,
    databaseRechecked: true,
    parentSku: group?.parentSku || String(parentSku || ""),
    selected: selected
      ? {
          productId: selected.productId,
          name: selected.name,
          vendor: selected.vendor,
          vendorId: selected.vendorId,
          sourceItemId: selected.sourceItemId,
          blockers: selected.blockers,
          nextGate: selected.nextGate,
        }
      : null,
    excluded: decision.ok && group ? excludedCandidates(group, productId) : [],
    nextBlockers,
    futureSave: designFutureOwnershipSave(),
    save: attemptFutureOwnershipSave(),
    savePreview: previewOwnershipSaveDocuments({
      group,
      owners: audit.owners || [],
      operations: audit.operations || [],
      parentSku: group?.parentSku || parentSku,
      productId,
      vendorId: selected?.vendorId || "",
      sourceItemId: selected?.sourceItemId || "",
      confirm: confirm === true,
      confirmOwnershipSave: true,
      productionSnapshot: deps.productionSnapshot || null,
    }),
  };
}

async function insertOnce(model, doc) {
  try {
    await model.create(doc);
    return { inserted: true };
  } catch (err) {
    if (Number(err?.code) !== 11000) throw err;
    return { duplicate: true };
  }
}

async function commitOwnershipSave(input, deps) {
  if (OWNERSHIP_SAVE_RELEASED !== true) return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  if (OWNERSHIP_SAVE_INDEXES_READY !== true) {
    return { ...attemptFutureOwnershipSave(input, deps.env), code: "ownership_indexes_not_ready", databaseRechecked: false };
  }
  if (!ownershipPilotAllows(input.parentSku, input.productId)) {
    return { ...attemptFutureOwnershipSave(input, deps.env), code: "pilot_not_authorized", databaseRechecked: false };
  }
  if (giniSkuKey(input.parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU)) {
    const accepted = acceptFreshProductionSnapshot(input.productionSnapshot, {
      productIds: input.productionSnapshot?.productIds || [],
      productId: input.productId,
    });
    if (!accepted) {
      return {
        ok: false,
        code: "production_context_unverified",
        saved: false,
        sentToGini: 0,
        canSend: false,
        writes: [],
        databaseRechecked: false,
        publishesToGini: false,
      };
    }
  }
  const audit = await currentAudit(deps);
  const group = audit.groups.find((row) => row.parentSkuKey === giniSkuKey(input.parentSku)) || null;
  const decision = evaluateOwnershipSave({
    group,
    parentSku: input.parentSku,
    productId: input.productId,
    vendorId: input.vendorId,
    sourceItemId: input.sourceItemId,
    confirm: input.confirm === true,
    confirmOwnershipSave: input.confirmOwnershipSave === true,
    seenProductIds: input.seenProductIds,
    owners: audit.owners || [],
    operations: audit.operations || [],
    expectedFingerprint: input.decisionFingerprint,
    requireFingerprint: true,
    productionSnapshot: input.productionSnapshot,
  });
  const held = {
    databaseRechecked: true,
    authorizationEnabled: true,
    publishesToGini: false,
    sentToGini: 0,
    canSend: false,
    mergesStock: false,
    approvesVariantSkus: false,
    modifiesKe20: false,
    modifiesEi8888: false,
    automaticVendorSelection: false,
    overwritesOwner: false,
  };
  if (!decision.ok || decision.idempotent) {
    return { ...decision, ...held, saved: false, writes: [] };
  }
  const administratorId = String(input.administratorId || "").trim();
  if (!administratorId) {
    return { ...decision, ...held, ok: false, code: "approval_required", saved: false, writes: [] };
  }
  const ownerModel = deps.ownerModel || GiniVariantParentOwner;
  const operationModel = deps.operationModel || GiniVariantOwnershipOperation;
  const documents = decision.documents;
  if (!documents || documents.owner.status !== "approved" || documents.owner.giniProductId) {
    return { ...held, ok: false, code: "remote_verification_missing", saved: false, writes: [] };
  }
  const ownerInsert = await insertOnce(ownerModel, {
    ...documents.owner,
    approvedAt: new Date(),
  });
  const existingOwner = ownerInsert.duplicate ? await ownerModel.findOne({ skuKey: documents.owner.skuKey }).lean() : null;
  const ownerConflict = interpretOwnershipIndexConflict({
    record: documents.owner,
    operation: documents.operation,
    ownerDuplicate: ownerInsert.duplicate === true,
    existingOwner,
  });
  if (ownerInsert.duplicate === true && !ownerConflict.ok) {
    return { ...held, ...ownerConflict, saved: false, writes: [] };
  }
  const operationInsert = await insertOnce(operationModel, {
    ...documents.operation,
    administratorId,
    confirmedAt: new Date(),
  });
  const existingOperation = operationInsert.duplicate
    ? await operationModel.findOne({ $or: [{ operationKey: documents.operation.operationKey }, { skuKey: documents.operation.skuKey }] }).lean()
    : null;
  const outcome = planCommitOutcome({
    record: documents.owner,
    operation: documents.operation,
    ownerInsert,
    existingOwner,
    operationInsert,
    existingOperation,
  });
  return { ...held, ...outcome, record: documents.owner, remoteVerification: "not_performed" };
}

export async function saveOwnershipSelection(input = {}, deps = {}) {
  const authorization = ownershipSaveAuthorization(deps.env);
  if (authorization.enabled !== true || OWNERSHIP_SAVE_RELEASED !== true) {
    return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  }
  return commitOwnershipSave(input, deps);
}
