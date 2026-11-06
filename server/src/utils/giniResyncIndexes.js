export const RESYNC_LOCK_COLLECTION = "giniresynclocks";
export const RESYNC_AUDIT_COLLECTION = "giniresyncaudits";
export const RESYNC_JOB_COLLECTION = "giniresyncjobs";
export const RESYNC_PREVIEW_COLLECTION = "giniresyncpreviews";

const AUDIT_LOOKUP = Object.freeze({ skuKey: 1, createdAt: -1 });

function indexKeys(index) {
  return Object.keys(index?.key || {});
}

function plainIndex(index) {
  return index?.sparse !== true && !index.partialFilterExpression && index?.expireAfterSeconds == null;
}

export function matchingUniqueResyncIndex(indexes, field) {
  return (
    (indexes || []).find((index) => {
      const keys = indexKeys(index);
      return plainIndex(index) && index?.unique === true && keys.length === 1 && index.key[field] === 1;
    }) || null
  );
}

export function matchingResyncFieldIndex(indexes, field) {
  return (
    (indexes || []).find((index) => {
      const keys = indexKeys(index);
      return plainIndex(index) && index?.unique !== true && keys.length === 1 && index.key[field] === 1;
    }) || null
  );
}

export function matchingResyncAuditLookup(indexes) {
  const fields = Object.keys(AUDIT_LOOKUP);
  return (
    (indexes || []).find((index) => {
      const keys = indexKeys(index);
      return (
        plainIndex(index) &&
        index?.unique !== true &&
        keys.length === fields.length &&
        fields.every((field) => index.key[field] === AUDIT_LOOKUP[field])
      );
    }) || null
  );
}

function fieldReport(match) {
  return { enforced: Boolean(match), name: match ? String(match.name || "") : "" };
}

export function assessResyncIndexes({
  lockExists = false,
  lockIndexes = [],
  auditExists = false,
  auditIndexes = [],
  jobExists = false,
  jobIndexes = [],
  previewExists = false,
  previewIndexes = [],
} = {}) {
  const lock = matchingUniqueResyncIndex(lockIndexes, "skuKey");
  const auditLookup = matchingResyncAuditLookup(auditIndexes);
  const jobPartner = matchingResyncFieldIndex(jobIndexes, "partner");
  const jobStatus = matchingResyncFieldIndex(jobIndexes, "status");
  const previewPartner = matchingResyncFieldIndex(previewIndexes, "partner");
  const readyForResyncIndexes = Boolean(
    lockExists && lock && auditExists && auditLookup && jobExists && jobPartner && jobStatus && previewExists && previewPartner
  );
  return {
    lock: { collection: RESYNC_LOCK_COLLECTION, exists: Boolean(lockExists), skuKey: fieldReport(lock) },
    audit: { collection: RESYNC_AUDIT_COLLECTION, exists: Boolean(auditExists), skuKeyCreatedAt: fieldReport(auditLookup) },
    job: {
      collection: RESYNC_JOB_COLLECTION,
      exists: Boolean(jobExists),
      partner: fieldReport(jobPartner),
      status: fieldReport(jobStatus),
    },
    preview: { collection: RESYNC_PREVIEW_COLLECTION, exists: Boolean(previewExists), partner: fieldReport(previewPartner) },
    readyForResyncIndexes,
  };
}

export function resyncIndexCreationProcedure({ ready = false } = {}) {
  if (ready) {
    return {
      automatic: false,
      runFromThisScript: false,
      commands: [],
      operatorSteps: ["The required re-sync indexes are already present. Do not create them again."],
    };
  }
  return {
    automatic: false,
    runFromThisScript: false,
    commands: [
      `db.${RESYNC_LOCK_COLLECTION}.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" })`,
      `db.${RESYNC_AUDIT_COLLECTION}.createIndex({ skuKey: 1, createdAt: -1 }, { name: "skuKey_1_createdAt_-1" })`,
      `db.${RESYNC_JOB_COLLECTION}.createIndex({ partner: 1 }, { name: "partner_1" })`,
      `db.${RESYNC_JOB_COLLECTION}.createIndex({ status: 1 }, { name: "status_1" })`,
      `db.${RESYNC_PREVIEW_COLLECTION}.createIndex({ partner: 1 }, { name: "partner_1" })`,
    ],
    operatorSteps: [
      "Run this read-only preflight on the verified Hostinger server and keep the JSON.",
      "Approve a separate production database change. This preflight does not run it.",
      "In mongosh, select the production brownstore database and run only the createIndex commands in this report.",
      "Run this preflight again. readyForResyncIndexes must be true before Re-sync Preview or Re-sync start is used.",
      "Leave GINI_RESYNC_WRITES_ENABLED and GINI_ALLOW_LIVE_RESYNC_WRITES unset.",
    ],
  };
}

async function readModelIndexes(model) {
  try {
    const name = model.collection.collectionName;
    const listed = await model.db.db.listCollections({ name }, { nameOnly: true }).toArray();
    if (!listed.length) return { exists: false, indexes: [] };
    return { exists: true, indexes: await model.collection.indexes() };
  } catch {
    return { exists: false, indexes: [] };
  }
}

export async function readResyncIndexState() {
  const [{ GiniResyncLock }, { GiniResyncAudit }, { GiniResyncJob }, { GiniResyncPreview }] = await Promise.all([
    import("../models/GiniResyncLock.js"),
    import("../models/GiniResyncAudit.js"),
    import("../models/GiniResyncJob.js"),
    import("../models/GiniResyncPreview.js"),
  ]);
  const [lock, audit, job, preview] = await Promise.all([
    readModelIndexes(GiniResyncLock),
    readModelIndexes(GiniResyncAudit),
    readModelIndexes(GiniResyncJob),
    readModelIndexes(GiniResyncPreview),
  ]);
  return assessResyncIndexes({
    lockExists: lock.exists,
    lockIndexes: lock.indexes,
    auditExists: audit.exists,
    auditIndexes: audit.indexes,
    jobExists: job.exists,
    jobIndexes: job.indexes,
    previewExists: preview.exists,
    previewIndexes: preview.indexes,
  });
}

export async function resyncIndexesEnforced() {
  const state = await readResyncIndexState();
  return state.readyForResyncIndexes === true;
}
