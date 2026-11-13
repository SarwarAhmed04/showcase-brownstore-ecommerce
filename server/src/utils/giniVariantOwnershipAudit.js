import { giniSkuKey } from "./giniSyncOnePlan.js";
import { OWNERSHIP_PILOT_SKU, productionSnapshotDecision } from "./giniOwnershipProductionContext.js";
import { isKnownVariantParent, KNOWN_GINI_VARIANT_PARENTS, publishRemote } from "./giniVariantChangedPlan.js";
import { resolveOwnershipImageUrls } from "./ownershipImageUrl.js";

const OWNERSHIP_CODES = new Set(["duplicate_parent_sku", "other_vendor_owns_parent"]);

export function nextValidationGate(blockers = []) {
  const codes = new Set((blockers || []).filter((code) => !OWNERSHIP_CODES.has(code)));
  if (codes.has("size_attribute_unverified")) return "missing_size_attribute";
  if (codes.has("missing_color_mapping") || codes.has("missing_attribute") || codes.has("color_attribute_unread")) return "unmapped_colors";
  if (codes.has("missing_variant_sku_approval") || codes.has("missing_variant_sku")) return "missing_approved_variant_skus";
  if (codes.has("ownership_unverified") || codes.has("remote_absence_unconfirmed") || codes.has("known_parent_not_reconciled")) return "remote_verification";
  if (codes.size) return "other";
  return "remote_verification";
}

function uniqueColors(combinations) {
  const seen = new Set();
  const colors = [];
  for (const row of combinations || []) {
    const color = String(row?.color || "").trim();
    const key = color.toLowerCase();
    if (!color || seen.has(key)) continue;
    seen.add(key);
    colors.push(color);
  }
  return colors;
}

function remoteSummary(remote) {
  const published = publishRemote(remote || { state: "not_read" });
  return {
    state: published.state,
    id: published.id || "",
    visibility: published.visibility || "",
    variantCount: published.variantCount,
  };
}

function candidateView(product, plan, role) {
  const combinations = product?.combinations || [];
  const blockers = plan?.blockers?.length ? plan.blockers : (product?.blockers || []);
  const imageUrls = resolveOwnershipImageUrls(product?.imageUrls);
  return {
    productId: String(product?.productId || ""),
    name: String(product?.name || ""),
    parentSku: String(product?.parentSku || ""),
    vendor: String(product?.vendor || ""),
    vendorId: String(product?.vendorId || ""),
    sourceItemId: String(product?.sourceItemId || ""),
    imageUrls,
    colors: uniqueColors(combinations),
    variantSkus: combinations.map((row) => String(row?.proposedSku || "")).filter(Boolean),
    stock: combinations.map((row) => ({
      color: String(row?.color || ""),
      sku: String(row?.proposedSku || ""),
      stock: Number.isFinite(Number(row?.stock)) ? Number(row.stock) : null,
    })),
    totalStock: combinations.reduce((sum, row) => sum + (Number.isFinite(Number(row?.stock)) ? Number(row.stock) : 0), 0),
    role,
    blockers: [...blockers],
    nextGate: nextValidationGate(blockers),
    sendReady: false,
  };
}

function ownerRole(owner, productId) {
  if (!owner || String(owner.productId || "") !== String(productId || "")) return "non_owner";
  if (owner.status === "verified_remote") return "verified_owner";
  if (owner.status === "approved") return "approved_owner";
  return "non_owner";
}

export function auditDuplicateOwnership({ products = [], owners = [], remoteBySku = {}, plans = [] } = {}) {
  const planByProduct = new Map((plans || []).map((plan) => [String(plan.productId || ""), plan]));
  const grouped = new Map();
  for (const product of products || []) {
    const key = giniSkuKey(product?.parentSku);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(product);
  }
  const groups = [];
  for (const [key, members] of grouped) {
    if (members.length < 2) continue;
    const parentSku = String(members.find((row) => row.parentSku)?.parentSku || key);
    const matchingOwners = (owners || []).filter((row) => giniSkuKey(row.parentSku || row.skuKey) === key);
    const owner = matchingOwners[0] || null;
    const ownerInGroup = owner ? members.some((product) => String(product.productId || "") === String(owner.productId || "")) : false;
    const conflictingOwners = matchingOwners.length > 1 || Boolean(owner && !ownerInGroup);
    const remote = remoteBySku[parentSku] || remoteBySku[key] || { state: "not_read" };
    const candidates = members
      .map((product) => candidateView(product, planByProduct.get(String(product.productId)), ownerRole(owner, product.productId)))
      .sort((left, right) => left.vendor.localeCompare(right.vendor) || left.productId.localeCompare(right.productId));
    const verifiedOwner = candidates.find((row) => row.role === "verified_owner") || null;
    const approvedOwner = candidates.find((row) => row.role === "approved_owner") || null;
    const locked = Boolean(verifiedOwner) || isKnownVariantParent(parentSku) || conflictingOwners;
    groups.push({
      parentSku,
      parentSkuKey: key,
      productRows: candidates.length,
      blockedRows: candidates.filter((row) => row.role === "non_owner" && (row.blockers.includes("duplicate_parent_sku") || row.blockers.includes("other_vendor_owns_parent"))).length,
      vendors: [...new Set(candidates.map((row) => row.vendor).filter(Boolean))],
      verifiedOwner: verifiedOwner ? { productId: verifiedOwner.productId, vendor: verifiedOwner.vendor } : null,
      approvedOwner: approvedOwner ? { productId: approvedOwner.productId, vendor: approvedOwner.vendor } : null,
      selectionOpen: !locked && !approvedOwner,
      knownReconciledParent: isKnownVariantParent(parentSku),
      conflictingOwners,
      selectedProductId: null,
      preferredCandidate: null,
      remote: remoteSummary(remote),
      candidates,
    });
  }
  groups.sort((left, right) => left.parentSku.localeCompare(right.parentSku));
  const blockedRows = groups.reduce((sum, group) => sum + group.blockedRows, 0);
  const unresolved = groups.filter((group) => group.selectionOpen);
  const nextGateCounts = {};
  for (const group of unresolved) {
    for (const candidate of group.candidates) {
      nextGateCounts[candidate.nextGate] = (nextGateCounts[candidate.nextGate] || 0) + 1;
    }
  }
  return {
    readOnly: true,
    automaticSelection: false,
    saved: false,
    canSend: false,
    mergesStock: false,
    approvesVariantSkus: false,
    inventsAttributeMappings: false,
    blockedProductRows: blockedRows,
    uniqueDuplicateSkuGroups: groups.length,
    groupsWithVerifiedOwner: groups.filter((group) => group.verifiedOwner).length,
    groupsAwaitingSelection: unresolved.length,
    afterOwnershipApproval: {
      sendReady: 0,
      productsThatCanAdvance: unresolved.length,
      copiesThatStayBlocked: unresolved.reduce((sum, group) => sum + Math.max(0, group.candidates.length - 1), 0),
      nextGateByCandidate: nextGateCounts,
      note: "One selected product per unresolved group can leave the duplicate-SKU gate. That product still has to pass the next validation gate. It is not send-ready, and its copies stay blocked.",
    },
    selectionWorkflow: {
      automaticSelection: false,
      savesOwner: false,
      steps: [
        "Open one duplicate parent SKU group.",
        "Read every competing vendor, product id, source item id, colors, variant SKUs, and stock.",
        "If a verified owner is already recorded, keep it and leave the other copies blocked.",
        "Otherwise an administrator selects one product id and confirms that exact choice.",
        "The check requires the product to belong to that SKU group, one product id only, and no different owner record.",
        "A later explicit save may record the owner. This preview does not save it, does not merge stock, and does not approve variant SKUs or color mappings.",
      ],
    },
    groups,
  };
}

function closed(code, extra = {}) {
  return {
    ok: false,
    code,
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    mergesStock: false,
    approvesVariantSkus: false,
    inventsAttributeMappings: false,
    overwritesOwner: false,
    ...extra,
  };
}

export function planOwnershipSelection({ group = null, productId = "", confirm = false } = {}) {
  if (confirm !== true) return closed("approval_required");
  if (!group || !Array.isArray(group.candidates)) return closed("group_not_found");
  if (group.conflictingOwners) return closed("conflicting_owner", { overwritesOwner: false });
  const matches = group.candidates.filter((row) => String(row.productId) === String(productId || ""));
  if (matches.length !== 1) return closed(matches.length === 0 ? "candidate_not_in_group" : "candidate_not_unique");
  const candidate = matches[0];
  if (group.knownReconciledParent || group.verifiedOwner) {
    return closed("owner_already_verified", { overwritesOwner: false, verifiedOwner: group.verifiedOwner || null });
  }
  if (group.approvedOwner && group.approvedOwner.productId !== candidate.productId) {
    return closed("owner_already_approved", { overwritesOwner: false, approvedOwner: group.approvedOwner });
  }
  if (candidate.role === "verified_owner" || candidate.role === "approved_owner") return closed("already_owner");
  return {
    ok: true,
    code: "selection_prepared_not_saved",
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    mergesStock: false,
    approvesVariantSkus: false,
    inventsAttributeMappings: false,
    overwritesOwner: false,
    proposal: {
      parentSku: group.parentSku,
      productId: candidate.productId,
      vendorId: candidate.vendorId,
      status: "pending_explicit_save",
    },
    nextGate: candidate.nextGate,
    sendReady: false,
  };
}

export const OWNERSHIP_SAVE_RELEASED = false;
export const OWNERSHIP_SAVE_INDEXES_READY = false;
export const OWNERSHIP_SAVE_PILOT = Object.freeze({
  parentSku: "38104",
  productId: "6adf9ca49dedbaa3dd573cce",
  sourceItemId: "6adf9824ef43bcf3ec7d1ee4",
  vendorName: "IT Lobby",
});
export const OWNERSHIP_SAVE_EXCLUDED = Object.freeze({
  parentSku: "38104",
  productId: "6ae08bbd9dedbaa3dd5740d9",
  sourceItemId: "6adf9cf4ef43bcf3ec7daac1",
  vendorName: "Jawal Flex",
});

const OWNERSHIP_SAVE_SOURCE_LOCKS = Object.freeze(["OWNERSHIP_SAVE_RELEASED", "OWNERSHIP_SAVE_INDEXES_READY"]);
const OWNERSHIP_SAVE_ENVIRONMENT_GATES = Object.freeze(["GINI_VARIANT_OWNERSHIP_SAVE_ENABLED", "GINI_ALLOW_OWNERSHIP_SAVE"]);

export function ownershipPilotAuthorization(pilot = OWNERSHIP_SAVE_PILOT) {
  const parentSku = String(pilot?.parentSku || "").trim();
  const productId = String(pilot?.productId || "").trim();
  const named = Boolean(parentSku && productId);
  return {
    authorized: named && OWNERSHIP_SAVE_RELEASED === true && OWNERSHIP_SAVE_INDEXES_READY === true,
    named,
    parentSku,
    productId,
    globalSave: false,
    maxGroups: named ? 1 : 0,
  };
}

export function ownershipPilotAllows(parentSku, productId, pilot = OWNERSHIP_SAVE_PILOT) {
  const gate = ownershipPilotAuthorization(pilot);
  if (!gate.named) return false;
  return giniSkuKey(parentSku) === giniSkuKey(gate.parentSku) && String(productId || "").trim() === gate.productId;
}

export function ownershipSaveAuthorization(env = process.env) {
  const explicitGate = env?.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED === "true";
  const allowGate = env?.GINI_ALLOW_OWNERSHIP_SAVE === "true";
  const released = OWNERSHIP_SAVE_RELEASED === true;
  const indexesReady = OWNERSHIP_SAVE_INDEXES_READY === true;
  return {
    released,
    indexesReady,
    explicitGate,
    allowGate,
    enabled: released && indexesReady && explicitGate && allowGate,
    enabledByDefault: false,
    requiresAdministratorConfirmation: true,
    sourceLocks: [...OWNERSHIP_SAVE_SOURCE_LOCKS],
    environmentGates: [...OWNERSHIP_SAVE_ENVIRONMENT_GATES],
  };
}

export function ownershipOperationKey(parentSku, productId) {
  const skuKey = giniSkuKey(parentSku);
  const id = String(productId || "").trim();
  if (!skuKey || !id) return "";
  return `ownership-save:${skuKey}:${id}`;
}

export function designFutureOwnershipSave() {
  const authorization = ownershipSaveAuthorization();
  return {
    phase: authorization.enabled ? "authorized" : "implemented_unavailable",
    implemented: true,
    routeExposed: true,
    available: authorization.enabled,
    authorization: {
      enabled: authorization.enabled,
      enabledByDefault: false,
      released: authorization.released,
      requiresAdministratorConfirmation: true,
      bothGatesRequired: [...OWNERSHIP_SAVE_ENVIRONMENT_GATES],
      sourceLocks: [...OWNERSHIP_SAVE_SOURCE_LOCKS],
      releaseLock: "OWNERSHIP_SAVE_RELEASED",
      indexLock: "OWNERSHIP_SAVE_INDEXES_READY",
    },
    uniquenessChecks: [
      "Require a fresh snapshot from a verified Hostinger production read in this process. A desktop catalog cannot authorize the ownership pilot.",
      "Re-read both vendor products, their source item ids, and every owner and operation row in one snapshot.",
      "Accept only the one SKU and BrownStore product id named by OWNERSHIP_SAVE_PILOT.",
      "Require the fresh fingerprint to match the reviewed decision.",
      "GiniVariantParentOwner.skuKey stays unique. A duplicate key is an idempotent retry only when the product id matches an approved row.",
      "GiniVariantOwnershipOperation.operationKey and skuKey are both unique. A different product for that SKU is an index conflict.",
      "Refuse a different existing owner, more than one owner row, a verified owner, or any of the six reconciled parents.",
      "Insert status approved only. Remote verification is a separate later read.",
    ],
    operationAudit: {
      wouldRecord: ["parentSku", "skuKey", "selectedProductId", "selectedVendorId", "sourceItemId", "excludedProductIds", "administratorId", "confirmedAt", "previousOwnerProductId"],
      writesInThisPhase: false,
    },
    forbiddenEffects: ["gini_api_write", "stock_merge", "variant_sku_approval", "color_mapping", "brownstore_delete", "commission_rule_change", "ke20_journal_change", "ei8888_journal_change"],
  };
}

function closedSave(code, extra = {}) {
  return {
    ok: false,
    code,
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    publishesToGini: false,
    mergesStock: false,
    approvesVariantSkus: false,
    inventsAttributeMappings: false,
    overwritesOwner: false,
    automaticVendorSelection: false,
    modifiesKe20: false,
    modifiesEi8888: false,
    idempotent: false,
    ...extra,
  };
}

function sameText(left, right) {
  return String(left || "") === String(right || "");
}

function ownersForSku(owners, skuKey) {
  return (owners || []).filter((row) => giniSkuKey(row?.parentSku || row?.skuKey) === skuKey);
}

function operationsForSku(operations, skuKey) {
  return (operations || []).filter((row) => giniSkuKey(row?.skuKey || row?.parentSku) === skuKey);
}

export function evaluateOwnershipSave({
  group = null,
  parentSku = "",
  productId = "",
  vendorId = "",
  sourceItemId = "",
  confirm = false,
  confirmOwnershipSave = false,
  seenProductIds = null,
  owners = [],
  operations = [],
  expectedFingerprint = "",
  requireFingerprint = false,
  productionSnapshot = null,
  now = Date.now(),
} = {}) {
  if (giniSkuKey(parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU) || giniSkuKey(group?.parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU)) {
    const candidateIds = (group?.candidates || []).map((row) => String(row?.productId || ""));
    const snapshotCode = productionSnapshotDecision(productionSnapshot, { productIds: candidateIds, productId, now });
    if (snapshotCode) return { ...closedSave(snapshotCode), deletedFromBrownStore: false };
    if (!ownershipPilotAllows(parentSku || group?.parentSku, productId)) {
      return { ...closedSave("pilot_not_authorized"), deletedFromBrownStore: false };
    }
  }
  if (confirm !== true || confirmOwnershipSave !== true) return closedSave("approval_required");
  const requestedSku = String(parentSku || "").trim();
  const requestedProductId = String(productId || "").trim();
  const requestedVendorId = String(vendorId || "").trim();
  const requestedSourceItemId = String(sourceItemId || "").trim();
  if (!requestedSku || !requestedProductId || !requestedVendorId || !requestedSourceItemId) {
    return closedSave("identity_mismatch");
  }
  if (!group || !Array.isArray(group.candidates)) return closedSave("group_not_found");
  const skuKey = giniSkuKey(group.parentSku);
  if (!skuKey || skuKey !== giniSkuKey(requestedSku)) return closedSave("stale_selection");
  if (isKnownVariantParent(group.parentSku) || group.knownReconciledParent) {
    return closedSave("reconciled_parent_protected", { verifiedOwner: group.verifiedOwner || null });
  }
  const liveOwners = ownersForSku(owners, skuKey);
  const ownerOutsideGroup = liveOwners.some((owner) => !group.candidates.some((row) => sameText(row.productId, owner.productId)));
  if (liveOwners.length > 1 || group.conflictingOwners || ownerOutsideGroup) {
    return closedSave("conflicting_owner");
  }
  const verified = liveOwners.find((owner) => owner.status === "verified_remote") || (group.verifiedOwner ? liveOwners[0] || { productId: group.verifiedOwner.productId, status: "verified_remote" } : null);
  if (group.verifiedOwner || verified?.status === "verified_remote") {
    return closedSave("owner_already_verified", { verifiedOwner: group.verifiedOwner || { productId: verified.productId } });
  }
  if (group.candidates.length < 2) return closedSave("competing_product_missing");
  const matches = group.candidates.filter((row) => sameText(row.productId, requestedProductId));
  if (matches.length !== 1) return closedSave(matches.length === 0 ? "candidate_not_in_group" : "candidate_not_unique");
  const candidate = matches[0];
  if (!sameText(candidate.vendorId, requestedVendorId) || !sameText(candidate.sourceItemId, requestedSourceItemId) || giniSkuKey(candidate.parentSku || group.parentSku) !== skuKey) {
    return closedSave("stale_identity");
  }
  if (Array.isArray(seenProductIds)) {
    const seen = [...new Set(seenProductIds.map((id) => String(id || "").trim()).filter(Boolean))].sort();
    const live = group.candidates.map((row) => String(row.productId)).sort();
    if (seen.length !== live.length || seen.some((id, index) => id !== live[index])) return closedSave("concurrent_selection");
  }
  const liveOperations = operationsForSku(operations, skuKey);
  if (liveOperations.some((row) => !sameText(row.productId, requestedProductId))) return closedSave("concurrent_selection");
  const approved = liveOwners.find((owner) => owner.status === "approved") || null;
  if (approved && !sameText(approved.productId, requestedProductId)) {
    return closedSave("owner_already_approved", { approvedOwner: { productId: approved.productId } });
  }
  if (approved && sameText(approved.productId, requestedProductId) && String(approved.vendorId || "") && !sameText(approved.vendorId, requestedVendorId)) {
    return closedSave("stale_identity");
  }
  if ((group.approvedOwner && !sameText(group.approvedOwner.productId, requestedProductId))) {
    return closedSave("owner_already_approved", { approvedOwner: group.approvedOwner });
  }
  const excludedProductIds = group.candidates
    .map((row) => String(row.productId))
    .filter((id) => id && id !== requestedProductId);
  const operationKey = ownershipOperationKey(group.parentSku, requestedProductId);
  const record = {
    skuKey,
    parentSku: group.parentSku,
    productId: requestedProductId,
    vendorId: requestedVendorId,
    status: "approved",
    approvalNote: "Administrator confirmed this parent owner. Nothing was sent to GINI.",
  };
  const operation = {
    operationKey,
    skuKey,
    parentSku: group.parentSku,
    productId: requestedProductId,
    vendorId: requestedVendorId,
    sourceItemId: requestedSourceItemId,
    excludedProductIds,
    previousOwnerProductId: approved ? String(approved.productId) : "",
    status: "recorded",
  };
  const fingerprint = ownershipDecisionFingerprint({ group, owners, operations });
  if (requireFingerprint === true && fingerprint !== String(expectedFingerprint || "")) return closedSave("stale_selection");
  const sameApprovedOwner = approved && sameText(approved.productId, requestedProductId) && sameText(approved.vendorId, requestedVendorId);
  const sameOperation = liveOperations.some((row) => sameText(row.operationKey, operationKey) && sameText(row.productId, requestedProductId) && sameText(row.vendorId, requestedVendorId) && sameText(row.sourceItemId, requestedSourceItemId));
  if (sameApprovedOwner && sameOperation) {
    return {
      ...closedSave("ownership_already_recorded"),
      ok: true,
      idempotent: true,
      fingerprint,
      record,
      operation,
      documents: ownershipInsertDocuments({ record, operation }),
    };
  }
  return {
    ...closedSave("ownership_save_ready"),
    ok: true,
    fingerprint,
    record,
    operation,
    documents: ownershipInsertDocuments({ record, operation }),
  };
}

export function ownershipDecisionFingerprint({ group = null, owners = [], operations = [] } = {}) {
  const skuKey = giniSkuKey(group?.parentSku);
  const candidates = (group?.candidates || [])
    .map((row) => ({
      productId: String(row.productId || ""),
      vendorId: String(row.vendorId || ""),
      sourceItemId: String(row.sourceItemId || ""),
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  const ownerRows = ownersForSku(owners, skuKey)
    .map((row) => ({
      productId: String(row.productId || ""),
      vendorId: String(row.vendorId || ""),
      status: String(row.status || ""),
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  const operationRows = operationsForSku(operations, skuKey)
    .map((row) => ({
      operationKey: String(row.operationKey || ""),
      productId: String(row.productId || ""),
      sourceItemId: String(row.sourceItemId || ""),
    }))
    .sort((left, right) => left.operationKey.localeCompare(right.operationKey));
  return JSON.stringify({ skuKey, candidates, ownerRows, operationRows });
}

export function ownershipInsertDocuments(decision) {
  if (!decision?.record || !decision?.operation) return null;
  return {
    owner: {
      skuKey: decision.record.skuKey,
      parentSku: decision.record.parentSku,
      productId: decision.record.productId,
      vendorId: decision.record.vendorId,
      status: "approved",
      giniProductId: "",
      approvalNote: "Administrator confirmed this parent owner. Nothing was sent to GINI.",
    },
    operation: {
      operationKey: decision.operation.operationKey,
      skuKey: decision.operation.skuKey,
      parentSku: decision.operation.parentSku,
      productId: decision.operation.productId,
      vendorId: decision.operation.vendorId,
      sourceItemId: decision.operation.sourceItemId,
      excludedProductIds: [...(decision.operation.excludedProductIds || [])],
      previousOwnerProductId: String(decision.operation.previousOwnerProductId || ""),
      status: "recorded",
    },
  };
}

export function interpretOwnershipIndexConflict({
  record = null,
  operation = null,
  ownerDuplicate = false,
  operationDuplicate = false,
  existingOwner = null,
  existingOperation = null,
} = {}) {
  if (ownerDuplicate) {
    if (!existingOwner || existingOwner.status === "verified_remote") {
      return { ok: false, code: existingOwner?.status === "verified_remote" ? "owner_already_verified" : "concurrent_selection", overwritesOwner: false };
    }
    const sameOwner = sameText(existingOwner.productId, record?.productId)
      && sameText(existingOwner.vendorId, record?.vendorId)
      && existingOwner.status === "approved";
    if (!sameOwner) return { ok: false, code: "index_conflict", overwritesOwner: false };
  }
  if (operationDuplicate) {
    const sameOperation = existingOperation
      && sameText(existingOperation.productId, operation?.productId)
      && sameText(existingOperation.vendorId, operation?.vendorId)
      && sameText(existingOperation.sourceItemId, operation?.sourceItemId)
      && sameText(existingOperation.skuKey, operation?.skuKey);
    if (!sameOperation) return { ok: false, code: "index_conflict", overwritesOwner: false };
  }
  return { ok: true, code: "ownership_save_ready", overwritesOwner: false };
}

export function planCommitOutcome({
  record = null,
  operation = null,
  ownerInsert = { inserted: false, duplicate: false },
  existingOwner = null,
  operationInsert = { inserted: false, duplicate: false },
  existingOperation = null,
} = {}) {
  const owner = interpretOwnershipIndexConflict({
    record,
    operation,
    ownerDuplicate: ownerInsert.duplicate === true,
    existingOwner,
  });
  if (ownerInsert.duplicate === true && !owner.ok) {
    return { ...owner, saved: false, writes: [], sentToGini: 0, canSend: false };
  }
  const audited = interpretOwnershipIndexConflict({
    record,
    operation,
    operationDuplicate: operationInsert.duplicate === true,
    existingOperation,
  });
  if (operationInsert.duplicate === true && !audited.ok) {
    return {
      ok: false,
      code: ownerInsert.inserted === true ? "audit_incomplete" : audited.code,
      saved: ownerInsert.inserted === true,
      writes: ownerInsert.inserted === true ? ["GiniVariantParentOwner.create"] : [],
      sentToGini: 0,
      canSend: false,
      overwritesOwner: false,
    };
  }
  const writes = [];
  if (ownerInsert.inserted === true) writes.push("GiniVariantParentOwner.create");
  if (operationInsert.inserted === true) writes.push("GiniVariantOwnershipOperation.create");
  return {
    ok: true,
    code: ownerInsert.inserted === true ? "ownership_recorded" : "ownership_already_recorded",
    saved: ownerInsert.inserted === true,
    idempotent: ownerInsert.inserted !== true,
    writes,
    sentToGini: 0,
    canSend: false,
    overwritesOwner: false,
    remoteVerification: "not_performed",
  };
}

const OWNERSHIP_BLOCKERS = new Set(["duplicate_parent_sku", "other_vendor_owns_parent"]);

export function previewOwnershipSaveDocuments({
  group = null,
  owners = [],
  operations = [],
  parentSku = "",
  productId = "",
  vendorId = "",
  sourceItemId = "",
  confirm = false,
  confirmOwnershipSave = false,
  productionSnapshot = null,
  now = Date.now(),
} = {}) {
  if (giniSkuKey(parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU) || giniSkuKey(group?.parentSku) === giniSkuKey(OWNERSHIP_PILOT_SKU)) {
    const candidateIds = (group?.candidates || []).map((row) => String(row?.productId || ""));
    const snapshotCode = productionSnapshotDecision(productionSnapshot, { productIds: candidateIds, productId, now });
    if (snapshotCode || !ownershipPilotAllows(parentSku || group?.parentSku, productId)) {
      return {
        readOnly: true,
        stopped: true,
        code: snapshotCode || "pilot_not_authorized",
        saved: false,
        wouldWrite: false,
        wouldInsert: [],
        documents: null,
        fingerprint: "",
        remainingBlockers: [],
        nextGate: "",
        excluded: [],
        ownerStatus: "",
        remoteVerification: "not_performed",
        sendEligible: false,
        sentToGini: 0,
        canSend: false,
        pilot: ownershipPilotAuthorization(),
        indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
        released: OWNERSHIP_SAVE_RELEASED === true,
        reread: null,
      };
    }
  }
  const decision = evaluateOwnershipSave({
    group,
    parentSku,
    productId,
    vendorId,
    sourceItemId,
    confirm,
    confirmOwnershipSave,
    owners,
    operations,
    productionSnapshot,
    now,
  });
  const selected = group?.candidates?.find((row) => String(row.productId) === String(productId || "")) || null;
  const remainingBlockers = (selected?.blockers || []).filter((code) => !OWNERSHIP_BLOCKERS.has(code));
  const documents = decision.documents || null;
  return {
    readOnly: true,
    saved: false,
    wouldWrite: false,
    wouldInsert: decision.ok && decision.idempotent !== true && documents ? [documents.owner, documents.operation] : [],
    documents,
    code: decision.code,
    fingerprint: decision.fingerprint || ownershipDecisionFingerprint({ group, owners, operations }),
    remainingBlockers,
    nextGate: selected?.nextGate || decision.nextGate || "",
    excluded: (group?.candidates || [])
      .filter((row) => String(row.productId) !== String(productId || ""))
      .map((row) => ({
        productId: row.productId,
        vendor: row.vendor,
        vendorId: row.vendorId,
        sourceItemId: row.sourceItemId,
        disposition: "excluded_from_gini_ownership",
        deletedFromBrownStore: false,
      })),
    ownerStatus: "approved",
    remoteVerification: "not_performed",
    sendEligible: false,
    sentToGini: 0,
    canSend: false,
    pilot: ownershipPilotAuthorization(),
    indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
    released: OWNERSHIP_SAVE_RELEASED === true,
    reread: {
      candidateCount: group?.candidates?.length || 0,
      candidates: (group?.candidates || []).map((row) => ({
        productId: row.productId,
        vendorId: row.vendorId,
        sourceItemId: row.sourceItemId,
      })),
      ownerCount: ownersForSku(owners, giniSkuKey(group?.parentSku)).length,
      operationCount: operationsForSku(operations, giniSkuKey(group?.parentSku)).length,
    },
  };
}

export function attemptFutureOwnershipSave(_input, env = process.env) {
  const authorization = ownershipSaveAuthorization(env);
  return {
    ...closedSave("ownership_save_disabled"),
    authorizationEnabled: authorization.enabled,
    design: designFutureOwnershipSave(),
  };
}

export function protectedReconciledParentSkus() {
  return KNOWN_GINI_VARIANT_PARENTS.map((row) => row.parentSku);
}

function groupSearchText(group) {
  return [
    group.parentSku,
    group.parentSkuKey,
    ...(group.vendors || []),
    ...(group.candidates || []).flatMap((row) => [row.name, row.vendor, row.vendorId, row.productId, row.sourceItemId, row.parentSku, ...(row.variantSkus || [])]),
  ].join("\n").toLowerCase();
}

export function pageOwnershipGroups(audit, { query = "", page = 1, pageSize = 10 } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const filtered = (audit?.groups || []).filter((group) => !needle || groupSearchText(group).includes(needle));
  const size = Math.min(20, Math.max(1, Number(pageSize) || 10));
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  const groups = filtered.slice(start, start + size);
  return {
    readOnly: true,
    automaticSelection: false,
    saved: false,
    canSend: false,
    mergesStock: false,
    approvesVariantSkus: false,
    inventsAttributeMappings: false,
    preferredCandidate: null,
    query: String(query || ""),
    page: current,
    pageSize: size,
    total,
    pages,
    pageGroupCount: groups.length,
    unresolvedInResult: filtered.filter((group) => group.selectionOpen).length,
    groupsAwaitingSelection: audit?.groupsAwaitingSelection || 0,
    groupsWithVerifiedOwner: audit?.groupsWithVerifiedOwner || 0,
    uniqueDuplicateSkuGroups: audit?.uniqueDuplicateSkuGroups || 0,
    blockedProductRows: audit?.blockedProductRows || 0,
    futureSave: designFutureOwnershipSave(),
    groups,
  };
}
