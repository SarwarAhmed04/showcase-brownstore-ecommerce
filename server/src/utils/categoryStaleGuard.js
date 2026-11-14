import { Category } from "../models/Category.js";
import { CategorySyncAudit } from "../models/CategorySyncAudit.js";
import { CategorySyncHold } from "../models/CategorySyncHold.js";
import { Product } from "../models/Product.js";
import { removeLocalCategoryImage } from "./categoryView.js";

/** A category id must be absent from this many completed syncs before approval can delete it. */
export const CATEGORY_DELETE_CONFIRMATIONS = 3;
/** Permanent deletion requires this exact approval value. Category sync never supplies it. */
export const CATEGORY_DELETION_APPROVAL = "DELETE_LOCAL_CATALOG_CATEGORIES";
/** A remote category list below half the local list is an outage, not a confirmation. */
export const CATEGORY_OUTAGE_RATIO = 0.5;
const AUDIT_ID_LIMIT = 500;

function cleanIds(ids) {
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

export async function categoryIdsReferencedByProducts(ids, products = Product) {
  const wanted = cleanIds(ids);
  if (!wanted.length) return new Set();
  const wantedSet = new Set(wanted);
  const rows = await products.aggregate([
    {
      $project: {
        categoryId: { $toString: { $ifNull: ["$category._id", ""] } },
        extraIds: {
          $map: {
            input: { $ifNull: ["$categories", []] },
            as: "item",
            in: { $toString: { $ifNull: ["$$item._id", ""] } },
          },
        },
      },
    },
    { $match: { $or: [{ categoryId: { $in: wanted } }, { extraIds: { $in: wanted } }] } },
  ]);
  const found = new Set();
  for (const row of rows) {
    if (wantedSet.has(row.categoryId)) found.add(row.categoryId);
    for (const id of row.extraIds || []) {
      if (wantedSet.has(id)) found.add(id);
    }
  }
  return found;
}

export function planCategoryAbsence({
  missingIds = [],
  priorHolds = [],
  remoteTotal = 0,
  localTotal = 0,
  referencedIds = [],
} = {}) {
  const missing = cleanIds(missingIds);
  const referenced = new Set(cleanIds(referencedIds));
  const priorById = new Map(priorHolds.map((hold) => [String(hold.ibsherId), hold]));
  const missingSet = new Set(missing);
  const clearIds = [...priorById.keys()].filter((id) => !missingSet.has(id));
  const local = Number(localTotal) || 0;
  const remote = Number(remoteTotal) || 0;
  const base = {
    clearIds,
    missingCount: missing.length,
    remoteTotal: remote,
    localTotal: local,
    referenced: [],
  };

  if (local > 0 && (remote <= 0 || remote < local * CATEGORY_OUTAGE_RATIO)) {
    return { ...base, mode: "outage", quarantine: [], awaitingApproval: [], deleteIds: [] };
  }

  const quarantine = [];
  const awaitingApproval = [];
  const referencedRows = [];
  for (const id of missing) {
    const prior = Number(priorById.get(id)?.missingSyncs) || 0;
    const next = Math.min(CATEGORY_DELETE_CONFIRMATIONS, prior + 1);
    const row = { ibsherId: id, missingSyncs: next, referenced: referenced.has(id) };
    if (row.referenced) referencedRows.push(row);
    else if (next >= CATEGORY_DELETE_CONFIRMATIONS) awaitingApproval.push(row);
    else quarantine.push(row);
  }
  return {
    ...base,
    mode: "confirm",
    quarantine,
    awaitingApproval,
    referenced: referencedRows,
    deleteIds: [],
  };
}

function holdState(row) {
  if (row.referenced) return "referenced";
  if (row.missingSyncs >= CATEGORY_DELETE_CONFIRMATIONS) return "awaiting_approval";
  return "quarantine";
}

export async function applyCategoryAbsence({
  seenIds,
  remoteTotal,
  syncedAt = new Date(),
  categories = Category,
  products = Product,
  holds = CategorySyncHold,
  audits = CategorySyncAudit,
} = {}) {
  const seen = new Set(cleanIds(seenIds));
  const localDocs = await categories.find().select("ibsherId").lean();
  const missingIds = localDocs.map((doc) => String(doc.ibsherId || "")).filter((id) => id && !seen.has(id));
  const referencedIds = await categoryIdsReferencedByProducts(missingIds, products);
  const priorHolds = await holds.find().select("ibsherId missingSyncs").lean();
  const plan = planCategoryAbsence({
    missingIds,
    priorHolds,
    remoteTotal,
    localTotal: localDocs.length,
    referencedIds: [...referencedIds],
  });

  if (plan.clearIds.length) {
    await holds.deleteMany({ ibsherId: { $in: plan.clearIds } });
  }

  const holdRows = [...plan.quarantine, ...plan.awaitingApproval, ...plan.referenced];
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
            approvalState: holdState(row),
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
    referenced: plan.referenced.length,
    cleared: plan.clearIds.length,
    missingCount: plan.missingCount,
    remoteTotal: plan.remoteTotal,
    localTotal: plan.localTotal,
    deleteIds: [],
    quarantineIds: [...plan.quarantine, ...plan.awaitingApproval].map((row) => row.ibsherId).slice(0, AUDIT_ID_LIMIT),
    referencedIds: plan.referenced.map((row) => row.ibsherId).slice(0, AUDIT_ID_LIMIT),
    at: syncedAt,
  });

  return {
    removed: 0,
    quarantined: plan.quarantine.length,
    awaitingApproval: plan.awaitingApproval.length,
    referenced: plan.referenced.length,
    cleared: plan.clearIds.length,
    missingCount: plan.missingCount,
    mode: plan.mode,
    deleteIds: [],
    confirmationsRequired: CATEGORY_DELETE_CONFIRMATIONS,
  };
}

export async function approveCategoryDeletions({
  ibsherIds = [],
  approval = "",
  syncedAt = new Date(),
  categories = Category,
  products = Product,
  holds = CategorySyncHold,
  audits = CategorySyncAudit,
  removeImage = removeLocalCategoryImage,
} = {}) {
  const requested = cleanIds(ibsherIds);
  if (approval !== CATEGORY_DELETION_APPROVAL) {
    return { removed: 0, deleteIds: [], keptReferenced: [], refused: "approval_required" };
  }
  const referenced = await categoryIdsReferencedByProducts(requested, products);
  const ready = await holds.find({
    ibsherId: { $in: requested },
    missingSyncs: { $gte: CATEGORY_DELETE_CONFIRMATIONS },
    approvalState: { $ne: "referenced" },
  }).select("ibsherId").lean();
  const deleteIds = ready.map((row) => row.ibsherId).filter((id) => !referenced.has(id));
  const keptReferenced = requested.filter((id) => referenced.has(id));
  let removed = 0;
  if (deleteIds.length) {
    const doomed = await categories.find({ ibsherId: { $in: deleteIds } }).select("ibsherId overrides").lean();
    const result = await categories.deleteMany({ ibsherId: { $in: deleteIds } });
    removed = result.deletedCount || 0;
    await holds.deleteMany({ ibsherId: { $in: deleteIds } });
    for (const doc of doomed) removeImage(doc.overrides?.image);
  }
  await audits.create({
    mode: "approved_deletion",
    removed,
    quarantined: 0,
    referenced: keptReferenced.length,
    cleared: 0,
    missingCount: requested.length,
    remoteTotal: 0,
    localTotal: 0,
    deleteIds,
    quarantineIds: [],
    referencedIds: keptReferenced,
    at: syncedAt,
  });
  return {
    removed,
    deleteIds,
    keptReferenced,
    refused: deleteIds.length ? "" : (keptReferenced.length ? "referenced_by_products" : "not_confirmed"),
  };
}
