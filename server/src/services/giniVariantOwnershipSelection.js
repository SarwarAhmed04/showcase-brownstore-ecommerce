import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { loadVariantCatalog } from "./giniVariantSync.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import {
  attemptFutureOwnershipSave,
  auditDuplicateOwnership,
  designFutureOwnershipSave,
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
