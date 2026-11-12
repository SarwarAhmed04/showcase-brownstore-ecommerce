import mongoose from "mongoose";
import { GiniVariantOwnershipOperation } from "../models/GiniVariantOwnershipOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { liveOwnershipIndexesAllowSave, OWNERSHIP_OPERATION_COLLECTION, OWNERSHIP_PARENT_COLLECTION } from "../utils/giniOwnershipIndexPlan.js";
import { readOwnershipReadiness } from "../utils/giniOwnershipReadiness.js";
import {
  OWNERSHIP_PILOT_SKU,
  registerOwnershipAuthorization,
  resolveOwnershipAuthorization,
} from "../utils/giniOwnershipProductionContext.js";
import {
  attemptFutureOwnershipSave,
  auditDuplicateOwnership,
  designFutureOwnershipSave,
  evaluateOwnershipSave,
  interpretOwnershipIndexConflict,
  OWNERSHIP_SAVE_EXCLUDED,
  OWNERSHIP_SAVE_INDEXES_READY,
  OWNERSHIP_SAVE_PILOT,
  OWNERSHIP_SAVE_RELEASED,
  ownershipPilotAllows,
  ownershipSaveAuthorization,
  pageOwnershipGroups,
  planCommitOutcome,
  planOwnershipSelection,
  previewOwnershipSaveDocuments,
} from "../utils/giniVariantOwnershipAudit.js";

export const OWNERSHIP_COMMIT_TEST = Symbol("ownership-commit-test");

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

function connectionHost(deps = {}) {
  return String(deps.host || mongoose.connection?.host || "");
}

function connectionIsLoopback(deps = {}) {
  return ["127.0.0.1", "localhost", "::1"].includes(connectionHost(deps));
}

function ownershipDatabase(deps = {}) {
  if (deps.db) return deps.db;
  if (mongoose.connection?.readyState === 1 && mongoose.connection.db) return mongoose.connection.db;
  return null;
}

function saveGateView(liveIndexesReady = false) {
  const environmentEnabled = ownershipSaveAuthorization().enabled === true;
  return {
    released: OWNERSHIP_SAVE_RELEASED === true,
    indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
    liveIndexesReady: liveIndexesReady === true,
    environmentEnabled,
    anyOpen: OWNERSHIP_SAVE_RELEASED === true || OWNERSHIP_SAVE_INDEXES_READY === true,
    saveAvailable: OWNERSHIP_SAVE_RELEASED === true
      && OWNERSHIP_SAVE_INDEXES_READY === true
      && environmentEnabled
      && liveIndexesReady === true,
  };
}

function closedReview(code, extra = {}) {
  return {
    ok: false,
    code,
    readOnly: true,
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    publishesToGini: false,
    mergesStock: false,
    approvesVariantSkus: false,
    deletedFromBrownStore: false,
    databaseRechecked: false,
    authorizationSnapshot: null,
    productionReview: { verified: false, code: "production_context_unverified", liveIndexesReady: false },
    gates: saveGateView(false),
    saveAvailable: false,
    save: attemptFutureOwnershipSave(),
    ...extra,
  };
}

async function listNamedIndexes(db) {
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => String(item.name).toLowerCase()));
  const read = async (name) => {
    if (!present.has(name)) return [];
    return db.collection(name).listIndexes().toArray();
  };
  const [parentIndexes, operationIndexes] = await Promise.all([
    read(OWNERSHIP_PARENT_COLLECTION),
    read(OWNERSHIP_OPERATION_COLLECTION),
  ]);
  return {
    parentIndexes,
    operationIndexes,
    ready: liveOwnershipIndexesAllowSave(parentIndexes, operationIndexes),
  };
}

function pilotGroup(report) {
  const products = (report?.pilot?.products || []).map((row) => ({
    productId: row.productId,
    parentSku: row.parentSku,
    vendor: row.vendor,
    vendorId: row.vendorId,
    sourceItemId: row.sourceItemId,
    name: row.name,
    blockers: ["duplicate_parent_sku", "missing_variant_sku_approval"],
    combinations: [],
  }));
  const owners = (report?.pilot?.owners || []).map((row) => ({
    parentSku: row.parentSku || report.pilot.parentSku,
    skuKey: row.skuKey,
    productId: row.productId,
    vendorId: row.vendorId,
    status: row.status,
    giniProductId: "",
  }));
  const operations = report?.pilot?.operations || [];
  const audit = auditDuplicateOwnership({ products, owners, plans: products });
  return {
    group: audit.groups.find((row) => row.parentSkuKey === giniSkuKey(OWNERSHIP_PILOT_SKU)) || null,
    owners,
    operations,
  };
}

function selectedFields(selected) {
  if (!selected) return null;
  return {
    productId: selected.productId,
    name: selected.name,
    vendor: selected.vendor,
    vendorId: selected.vendorId,
    sourceItemId: selected.sourceItemId,
    blockers: selected.blockers,
    nextGate: selected.nextGate,
  };
}

async function reviewVerifiedSelection(input, deps) {
  const db = ownershipDatabase(deps);
  if (!db || connectionIsLoopback(deps) !== true) return closedReview("production_context_unverified");
  const report = await readOwnershipReadiness(db, {
    confirmProduction: true,
    allowLoopback: true,
    loopback: true,
  });
  if (report.stopped || report.code !== "verified_production_loopback") {
    return closedReview("production_context_unverified");
  }
  const indexes = await listNamedIndexes(db);
  const { group, owners, operations } = pilotGroup(report);
  const productId = String(input.productId || "");
  const selected = group?.candidates?.find((row) => row.productId === productId) || null;
  const productionReview = {
    verified: true,
    code: "verified_production_loopback",
    liveIndexesReady: indexes.ready === true,
  };
  const gates = saveGateView(indexes.ready === true);
  const base = {
    readOnly: true,
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    publishesToGini: false,
    mergesStock: false,
    approvesVariantSkus: false,
    deletedFromBrownStore: false,
    databaseRechecked: true,
    productionReview,
    gates,
    saveAvailable: false,
    save: attemptFutureOwnershipSave(),
    futureSave: designFutureOwnershipSave(),
    parentSku: group?.parentSku || OWNERSHIP_PILOT_SKU,
    selected: selectedFields(selected),
    authorizationSnapshot: null,
  };
  if (indexes.ready !== true) {
    return { ...base, ok: false, code: "ownership_indexes_not_ready", excluded: [], nextBlockers: [], savePreview: null };
  }
  const livePilot = selected
    && selected.productId === OWNERSHIP_SAVE_PILOT.productId
    && selected.sourceItemId === OWNERSHIP_SAVE_PILOT.sourceItemId
    && giniSkuKey(selected.parentSku || group?.parentSku) === giniSkuKey(OWNERSHIP_SAVE_PILOT.parentSku);
  if (!livePilot || productId === OWNERSHIP_SAVE_EXCLUDED.productId) {
    return {
      ...base,
      ok: false,
      code: "pilot_not_authorized",
      excluded: group ? excludedCandidates(group, productId) : [],
      nextBlockers: [],
      savePreview: null,
    };
  }
  const administratorId = String(input.administratorId || "").trim();
  if (input.confirm !== true || !administratorId) {
    return { ...base, ok: false, code: "approval_required", excluded: excludedCandidates(group, productId), nextBlockers: [], savePreview: null };
  }
  const conflicting = (report.pilot?.owners || []).some((row) => row.productId !== OWNERSHIP_SAVE_PILOT.productId)
    || (report.pilot?.operations || []).some((row) => row.productId !== OWNERSHIP_SAVE_PILOT.productId);
  if (conflicting) {
    return { ...base, ok: false, code: "conflicting_owner", excluded: excludedCandidates(group, productId), nextBlockers: [], savePreview: null };
  }
  const authorizationSnapshot = registerOwnershipAuthorization({
    parentSku: OWNERSHIP_SAVE_PILOT.parentSku,
    productId: selected.productId,
    sourceItemId: selected.sourceItemId,
    vendorId: selected.vendorId,
    administratorId,
    productIds: (report.pilot?.products || []).map((row) => row.productId),
    sourceItemIds: (report.pilot?.products || []).map((row) => row.sourceItemId),
  });
  const decision = planOwnershipSelection({ group, productId, confirm: true });
  const nextBlockers = (selected.blockers || []).filter((code) => !OWNERSHIP_CODES.has(code));
  return {
    ...base,
    ...decision,
    saved: false,
    sentToGini: 0,
    writes: [],
    databaseRechecked: true,
    productionReview,
    gates,
    saveAvailable: false,
    authorizationSnapshot,
    selected: selectedFields(selected),
    excluded: decision.ok ? excludedCandidates(group, productId) : [],
    nextBlockers,
    savePreview: previewOwnershipSaveDocuments({
      group,
      owners,
      operations,
      parentSku: group.parentSku,
      productId: selected.productId,
      vendorId: selected.vendorId,
      sourceItemId: selected.sourceItemId,
      confirm: true,
      confirmOwnershipSave: true,
      productionSnapshot: report.productionSnapshot,
    }),
  };
}

export async function prepareOwnershipSelection({
  parentSku = "",
  productId = "",
  confirm = false,
  administratorId = "",
  requireProductionReview = false,
} = {}, deps = {}) {
  if (requireProductionReview === true && giniSkuKey(parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU)) {
    return reviewVerifiedSelection({ parentSku, productId, confirm, administratorId }, deps);
  }
  if (requireProductionReview === true) {
    const db = ownershipDatabase(deps);
    if (!db || connectionIsLoopback(deps) !== true) return closedReview("production_context_unverified");
    const report = await readOwnershipReadiness(db, { confirmProduction: true, allowLoopback: true, loopback: true });
    if (report.stopped || report.code !== "verified_production_loopback") return closedReview("production_context_unverified");
  }
  const audit = await currentAudit(deps);
  const group = audit.groups.find((row) => row.parentSkuKey === giniSkuKey(parentSku)) || null;
  const decision = planOwnershipSelection({ group, productId, confirm: confirm === true });
  const selected = group?.candidates?.find((row) => String(row.productId) === String(productId || "")) || null;
  const nextBlockers = (selected?.blockers || []).filter((code) => !OWNERSHIP_CODES.has(code));
  return {
    ...decision,
    databaseRechecked: true,
    parentSku: group?.parentSku || String(parentSku || ""),
    selected: selectedFields(selected),
    excluded: decision.ok && group ? excludedCandidates(group, productId) : [],
    nextBlockers,
    futureSave: designFutureOwnershipSave(),
    save: attemptFutureOwnershipSave(),
    authorizationSnapshot: null,
    saveAvailable: false,
    gates: saveGateView(false),
    productionReview: requireProductionReview === true
      ? { verified: true, code: "verified_production_loopback", liveIndexesReady: false }
      : null,
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
      productionSnapshot: requireProductionReview === true ? null : (deps.productionSnapshot || null),
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

function refusedSave(code, extra = {}) {
  return {
    ok: false,
    code,
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    publishesToGini: false,
    deletedFromBrownStore: false,
    mergesStock: false,
    approvesVariantSkus: false,
    databaseRechecked: false,
    ...extra,
  };
}

export async function commitOwnershipSave(input, deps = {}) {
  const unit = deps.unitCommit === OWNERSHIP_COMMIT_TEST;
  if (!unit && (OWNERSHIP_SAVE_RELEASED !== true || OWNERSHIP_SAVE_INDEXES_READY !== true)) {
    return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  }
  const environmentOpen = deps.env?.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED === "true"
    && deps.env?.GINI_ALLOW_OWNERSHIP_SAVE === "true";
  if (!environmentOpen) {
    return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  }
  const administratorId = String(input.administratorId || "").trim();
  if (input.confirm !== true || input.confirmOwnershipSave !== true || !administratorId) {
    return refusedSave("approval_required");
  }
  if (!ownershipPilotAllows(input.parentSku, input.productId) || String(input.productId || "") === OWNERSHIP_SAVE_EXCLUDED.productId) {
    return refusedSave("pilot_not_authorized");
  }
  if (String(input.sourceItemId || "") !== OWNERSHIP_SAVE_PILOT.sourceItemId) {
    return refusedSave("pilot_not_authorized");
  }
  const authorization = resolveOwnershipAuthorization(input.snapshotId, {
    parentSku: input.parentSku,
    productId: input.productId,
    sourceItemId: input.sourceItemId,
    vendorId: input.vendorId,
    administratorId,
    now: deps.now,
  });
  if (!authorization.ok) return refusedSave(authorization.code);
  const db = ownershipDatabase(deps);
  if (!db || connectionIsLoopback(deps) !== true) return refusedSave("production_context_unverified");
  const report = await readOwnershipReadiness(db, { confirmProduction: true, allowLoopback: true, loopback: true });
  if (report.stopped || report.code !== "verified_production_loopback") return refusedSave("production_context_unverified");
  const indexes = await listNamedIndexes(db);
  if (indexes.ready !== true) return refusedSave("ownership_indexes_not_ready", { databaseRechecked: true });
  const liveIds = (report.pilot?.products || []).map((row) => String(row.productId || "")).filter(Boolean).sort();
  const savedIds = [...(authorization.snapshot.productIds || [])].sort();
  if (liveIds.length !== savedIds.length || liveIds.some((id, index) => id !== savedIds[index])) {
    return refusedSave("production_context_unverified", { databaseRechecked: true });
  }
  const { group, owners, operations } = pilotGroup(report);
  const selected = group?.candidates?.find((row) => row.productId === String(input.productId || "")) || null;
  if (!selected || selected.sourceItemId !== authorization.snapshot.sourceItemId || selected.vendorId !== authorization.snapshot.vendorId) {
    return refusedSave("stale_identity", { databaseRechecked: true });
  }
  const decision = evaluateOwnershipSave({
    group,
    parentSku: input.parentSku,
    productId: input.productId,
    vendorId: input.vendorId,
    sourceItemId: input.sourceItemId,
    confirm: true,
    confirmOwnershipSave: true,
    seenProductIds: input.seenProductIds,
    owners,
    operations,
    requireFingerprint: false,
    productionSnapshot: report.productionSnapshot,
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
  const ownerModel = deps.ownerModel || GiniVariantParentOwner;
  const operationModel = deps.operationModel || GiniVariantOwnershipOperation;
  const documents = decision.documents;
  if (!documents || documents.owner.status !== "approved" || documents.owner.giniProductId || documents.operation?.status !== "recorded") {
    return { ...held, ok: false, code: "remote_verification_missing", saved: false, writes: [] };
  }
  let ownerInsert;
  try {
    ownerInsert = await insertOnce(ownerModel, {
      ...documents.owner,
      approvedAt: new Date(),
    });
  } catch {
    return { ...held, ok: false, code: "ownership_save_failed", saved: false, writes: [] };
  }
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
  let operationInsert;
  try {
    operationInsert = await insertOnce(operationModel, {
      ...documents.operation,
      administratorId,
      confirmedAt: new Date(),
    });
  } catch {
    return {
      ...held,
      ok: false,
      code: "ownership_operation_incomplete",
      saved: false,
      writes: ownerInsert.inserted === true ? ["GiniVariantParentOwner.create"] : [],
    };
  }
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
  if (authorization.enabled !== true || OWNERSHIP_SAVE_RELEASED !== true || OWNERSHIP_SAVE_INDEXES_READY !== true) {
    return { ...attemptFutureOwnershipSave(input, deps.env), databaseRechecked: false };
  }
  return commitOwnershipSave(input, deps);
}
