import { giniSkuKey } from "./giniSyncOnePlan.js";
import { isKnownVariantParent, publishRemote } from "./giniVariantChangedPlan.js";

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
  const imageUrls = Array.isArray(product?.imageUrls) ? product.imageUrls.map((url) => String(url || "").trim()).filter(Boolean).slice(0, 8) : [];
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

export function designFutureOwnershipSave() {
  return {
    phase: "design_only",
    implemented: false,
    routeExposed: false,
    authorization: {
      enabledByDefault: false,
      requiresAdministratorConfirmation: true,
      bothGatesRequired: ["GINI_VARIANT_OWNERSHIP_SAVE_ENABLED", "GINI_ALLOW_OWNERSHIP_SAVE"],
    },
    uniquenessChecks: [
      "Reload the SKU group from the current catalog before any future save.",
      "The selected product id must be one member of that group.",
      "GiniVariantParentOwner.skuKey stays unique.",
      "Refuse when a different product already has approved or verified_remote status for that SKU.",
      "Refuse when more than one owner record matches the SKU.",
    ],
    operationAudit: {
      wouldRecord: ["parentSku", "skuKey", "selectedProductId", "selectedVendorId", "excludedProductIds", "administratorId", "confirmedAt", "previousOwnerProductId"],
      writesInThisPhase: false,
    },
    forbiddenEffects: ["gini_api_write", "stock_merge", "variant_sku_approval", "color_mapping", "brownstore_delete", "commission_rule_change"],
  };
}

export function attemptFutureOwnershipSave() {
  return {
    ok: false,
    code: "ownership_save_disabled",
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    authorizationEnabled: false,
    design: designFutureOwnershipSave(),
  };
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
