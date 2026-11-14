import { Product } from "../models/Product.js";
import { CatalogSyncAudit } from "../models/CatalogSyncAudit.js";
import { CatalogSyncHold } from "../models/CatalogSyncHold.js";

/** A source id must be absent from this many completed syncs before it can be approved for deletion. */
export const CATALOG_DELETE_CONFIRMATIONS = 3;
/** Permanent deletion requires this exact approval value. Catalog sync never supplies it. */
export const CATALOG_DELETION_APPROVAL = "DELETE_PUBLISHED_CATALOG_PRODUCTS";
/** A drop of this many products is treated as a feed fault, not a deletion candidate. */
export const CATALOG_SHRINK_HOLD_COUNT = 250;
/** A drop of this share of the local catalog is also held without advancing deletion. */
export const CATALOG_SHRINK_HOLD_RATIO = 0.01;
/** A remote total below half the local catalog is an outage, not a confirmation. */
export const CATALOG_OUTAGE_RATIO = 0.5;
const AUDIT_ID_LIMIT = 500;

export function planCatalogAbsence({
  missingIds = [],
  priorHolds = [],
  remoteTotal = 0,
  localTotal = 0,
} = {}) {
  const missing = [...new Set(missingIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const priorById = new Map(priorHolds.map((hold) => [String(hold.ibsherId), hold]));
  const missingSet = new Set(missing);
  const clearIds = [...priorById.keys()].filter((id) => !missingSet.has(id));
  const local = Number(localTotal) || 0;
  const remote = Number(remoteTotal) || 0;
  const base = { clearIds, missingCount: missing.length, remoteTotal: remote, localTotal: local };

  if (local > 0 && (remote <= 0 || remote < local * CATALOG_OUTAGE_RATIO)) {
    return { ...base, mode: "outage", quarantine: [], awaitingApproval: [], deleteIds: [] };
  }
  const largeDrop = missing.length >= CATALOG_SHRINK_HOLD_COUNT
    || (local >= 1000 && missing.length / local >= CATALOG_SHRINK_HOLD_RATIO);
  if (largeDrop) {
    return { ...base, mode: "shrink_hold", quarantine: [], awaitingApproval: [], deleteIds: [] };
  }

  const quarantine = [];
  const awaitingApproval = [];
  for (const id of missing) {
    const prior = Number(priorById.get(id)?.missingSyncs) || 0;
    const next = Math.min(CATALOG_DELETE_CONFIRMATIONS, prior + 1);
    const row = { ibsherId: id, missingSyncs: next };
    if (next >= CATALOG_DELETE_CONFIRMATIONS) awaitingApproval.push(row);
    else quarantine.push(row);
  }
  return { ...base, mode: "confirm", quarantine, awaitingApproval, deleteIds: [] };
}

export async function applyCatalogAbsence({
  seenIds,
  remoteTotal,
  syncedAt = new Date(),
  products = Product,
  holds = CatalogSyncHold,
  audits = CatalogSyncAudit,
} = {}) {
  const seen = [...seenIds];
  const localTotal = await products.countDocuments();
  const missingDocs = seen.length
    ? await products.find({
      ibsherId: { $nin: seen },
    }).select("ibsherId").lean()
    : await products.find().select("ibsherId").lean();
  const priorHolds = await holds.find().select("ibsherId missingSyncs").lean();
  const plan = planCatalogAbsence({
    missingIds: missingDocs.map((doc) => doc.ibsherId),
    priorHolds,
    remoteTotal,
    localTotal,
  });

  if (plan.clearIds.length) {
    await holds.deleteMany({ ibsherId: { $in: plan.clearIds } });
  }

  const holdRows = [...plan.quarantine, ...plan.awaitingApproval];
  if (plan.mode === "confirm" && holdRows.length) {
    await holds.bulkWrite(holdRows.map((row) => ({
      updateOne: {
        filter: { ibsherId: row.ibsherId },
        update: {
          $set: {
            missingSyncs: row.missingSyncs,
            lastMissingAt: syncedAt,
            lastRemoteTotal: plan.remoteTotal,
            lastLocalTotal: plan.localTotal,
            approvalState: row.missingSyncs >= CATALOG_DELETE_CONFIRMATIONS ? "awaiting_approval" : "quarantine",
          },
          $setOnInsert: { firstMissingAt: syncedAt },
        },
        upsert: true,
      },
    })), { ordered: false });
  }

  await audits.create({
    mode: plan.mode,
    removed: 0,
    quarantined: plan.quarantine.length,
    cleared: plan.clearIds.length,
    missingCount: plan.missingCount,
    remoteTotal: plan.remoteTotal,
    localTotal: plan.localTotal,
    deleteIds: [],
    quarantineIds: holdRows.map((row) => row.ibsherId).slice(0, AUDIT_ID_LIMIT),
    at: syncedAt,
  });

  return {
    removed: 0,
    quarantined: plan.quarantine.length,
    awaitingApproval: plan.awaitingApproval.length,
    cleared: plan.clearIds.length,
    missingCount: plan.missingCount,
    mode: plan.mode,
    deleteIds: [],
    confirmationsRequired: CATALOG_DELETE_CONFIRMATIONS,
  };
}

export async function approveCatalogDeletions({
  ibsherIds = [],
  approval = "",
  syncedAt = new Date(),
  products = Product,
  holds = CatalogSyncHold,
  audits = CatalogSyncAudit,
} = {}) {
  const requested = [...new Set(ibsherIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (approval !== CATALOG_DELETION_APPROVAL) {
    return { removed: 0, deleteIds: [], refused: "approval_required" };
  }
  const ready = await holds.find({
    ibsherId: { $in: requested },
    missingSyncs: { $gte: CATALOG_DELETE_CONFIRMATIONS },
  }).select("ibsherId").lean();
  const deleteIds = ready.map((row) => row.ibsherId);
  let removed = 0;
  if (deleteIds.length) {
    const result = await products.deleteMany({ ibsherId: { $in: deleteIds } });
    removed = result.deletedCount || 0;
    await holds.deleteMany({ ibsherId: { $in: deleteIds } });
  }
  await audits.create({
    mode: "approved_deletion",
    removed,
    quarantined: 0,
    cleared: 0,
    missingCount: requested.length,
    remoteTotal: 0,
    localTotal: 0,
    deleteIds,
    quarantineIds: [],
    at: syncedAt,
  });
  return { removed, deleteIds, refused: deleteIds.length ? "" : "not_confirmed" };
}
