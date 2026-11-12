import { GiniVariantOwnershipOperation } from "../models/GiniVariantOwnershipOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import {
  attemptFutureOwnershipSave,
  auditDuplicateOwnership,
  designFutureOwnershipSave,
  evaluateOwnershipSave,
  OWNERSHIP_SAVE_RELEASED,
  ownershipSaveAuthorization,
  pageOwnershipGroups,
  planOwnershipSelection,
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
  const catalog = await loadCatalog({ force: true });
  const owners = await loadOwners();
  const products = catalog?.products || [];
  return auditDuplicateOwnership({
    products,
    owners,
    plans: products,
    remoteBySku: deps.remoteBySku || remoteFromOwners(owners),
  });
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
  };
}

function sameOwnerIdentity(existing, record) {
  return String(existing?.productId || "") === record.productId
    && String(existing?.vendorId || "") === record.vendorId
    && existing?.status === "approved";
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
  const audit = await currentAudit(deps);
  const owners = await (deps.loadOwners || (() => GiniVariantParentOwner.find({}).lean()))();
  const operations = await (deps.loadOperations || (() => GiniVariantOwnershipOperation.find({}).lean()))();
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
    owners,
    operations,
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
  const writes = [];
  const ownerInsert = await insertOnce(ownerModel, {
    skuKey: decision.record.skuKey,
    parentSku: decision.record.parentSku,
    productId: decision.record.productId,
    vendorId: decision.record.vendorId,
    status: "approved",
    approvedAt: new Date(),
    approvalNote: decision.record.approvalNote,
  });
  if (ownerInsert.inserted) writes.push("GiniVariantParentOwner.create");
  if (ownerInsert.duplicate) {
    const existing = await ownerModel.findOne({ skuKey: decision.record.skuKey }).lean();
    if (existing?.status === "verified_remote") {
      return { ...held, ok: false, code: "owner_already_verified", saved: false, writes };
    }
    if (!sameOwnerIdentity(existing, decision.record)) {
      return { ...held, ok: false, code: "concurrent_selection", saved: false, writes };
    }
  }
  const operationInsert = await insertOnce(operationModel, {
    ...decision.operation,
    administratorId,
    confirmedAt: new Date(),
  });
  if (operationInsert.inserted) writes.push("GiniVariantOwnershipOperation.create");
  if (operationInsert.duplicate) {
    const existing = await operationModel.findOne({ operationKey: decision.operation.operationKey }).lean();
    const same = existing
      && String(existing.productId || "") === decision.operation.productId
      && String(existing.vendorId || "") === decision.operation.vendorId
      && String(existing.sourceItemId || "") === decision.operation.sourceItemId;
    if (!same) return { ...held, ok: false, code: "concurrent_selection", saved: false, writes };
  }
  return {
    ...held,
    ok: true,
    code: ownerInsert.inserted ? "ownership_recorded" : "ownership_already_recorded",
    saved: ownerInsert.inserted === true,
    idempotent: ownerInsert.inserted !== true,
    writes,
    record: decision.record,
  };
}

export async function saveOwnershipSelection(input = {}, deps = {}) {
  const authorization = ownershipSaveAuthorization(deps.env);
  if (authorization.enabled !== true || OWNERSHIP_SAVE_RELEASED !== true) {
    return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  }
  return commitOwnershipSave(input, deps);
}
