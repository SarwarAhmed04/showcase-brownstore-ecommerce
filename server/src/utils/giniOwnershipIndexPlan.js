export const OWNERSHIP_OPERATION_COLLECTION = "ginivariantownershipoperations";
export const OWNERSHIP_PARENT_COLLECTION = "ginivariantparentowners";

const OPERATION_INDEXES = Object.freeze([
  Object.freeze({ field: "operationKey", name: "operationKey_1" }),
  Object.freeze({ field: "skuKey", name: "skuKey_1" }),
]);

function indexKeys(index) {
  return Object.keys(index?.key || {});
}

export function matchingUniqueOwnershipIndex(indexes, field) {
  return (
    (indexes || []).find((index) => {
      const keys = indexKeys(index);
      return index?.unique === true
        && keys.length === 1
        && index.key[field] === 1
        && index.sparse !== true
        && !index.partialFilterExpression;
    }) || null
  );
}

function createIndexCommand(field, name) {
  return `db.${OWNERSHIP_OPERATION_COLLECTION}.createIndex({ ${field}: 1 }, { unique: true, name: "${name}" })`;
}

export function assessOwnershipIndexes({
  collectionName = "",
  indexes = [],
  duplicateOperationKeys = 0,
  duplicateSkuKeys = 0,
  parentOwnerIndexes = null,
} = {}) {
  const collectionExists = String(collectionName || "").toLowerCase() === OWNERSHIP_OPERATION_COLLECTION;
  const operationKey = matchingUniqueOwnershipIndex(indexes, "operationKey");
  const skuKey = matchingUniqueOwnershipIndex(indexes, "skuKey");
  const parentOwnerIndexIntact = parentOwnerIndexes == null
    ? null
    : Boolean(matchingUniqueOwnershipIndex(parentOwnerIndexes, "skuKey"));
  const duplicatesWouldPreventIndexCreation = Number(duplicateOperationKeys) > 0 || Number(duplicateSkuKeys) > 0;
  const indexesEnforced = Boolean(operationKey && skuKey);
  const commands = [];
  if (!duplicatesWouldPreventIndexCreation && parentOwnerIndexIntact !== false) {
    if (!collectionExists) commands.push(`db.createCollection("${OWNERSHIP_OPERATION_COLLECTION}")`);
    if (!operationKey) commands.push(createIndexCommand("operationKey", "operationKey_1"));
    if (!skuKey) commands.push(createIndexCommand("skuKey", "skuKey_1"));
  }
  return {
    collection: OWNERSHIP_OPERATION_COLLECTION,
    parentOwnerCollection: OWNERSHIP_PARENT_COLLECTION,
    collectionExists,
    indexesEnforced,
    operationKeyEnforced: Boolean(operationKey),
    skuKeyEnforced: Boolean(skuKey),
    parentOwnerIndexIntact,
    duplicatesWouldPreventIndexCreation,
    readyForOwnershipSave: collectionExists && indexesEnforced && parentOwnerIndexIntact === true && !duplicatesWouldPreventIndexCreation,
    commands,
    requiredIndexes: OPERATION_INDEXES.map((index) => ({ ...index, unique: true })),
    automatic: false,
    runFromThisScript: false,
    executed: false,
    mutatesParentOwners: false,
    mutatesIdentities: false,
  };
}

export function ownershipIndexMigrationPlan(observed = {}) {
  const assessment = assessOwnershipIndexes(observed);
  return {
    executed: false,
    automatic: false,
    runFromThisScript: false,
    idempotent: true,
    mutatesParentOwners: false,
    mutatesIdentities: false,
    collection: OWNERSHIP_OPERATION_COLLECTION,
    parentOwnerCollection: OWNERSHIP_PARENT_COLLECTION,
    commands: assessment.commands,
    verification: assessment,
  };
}

export function executeOwnershipIndexMigration() {
  return {
    ok: false,
    executed: false,
    code: "ownership_index_migration_not_run",
    saved: false,
    writes: [],
    sentToGini: 0,
    plan: ownershipIndexMigrationPlan(),
  };
}

export const OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED = false;

export const SKUKEY_INDEX_COMMAND = `db.${OWNERSHIP_OPERATION_COLLECTION}.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" })`;

function skuKeyIndexes(indexes) {
  return (indexes || []).filter((index) => Object.prototype.hasOwnProperty.call(index?.key || {}, "skuKey"));
}

export function classifySkuKeyIndex(indexes) {
  const present = skuKeyIndexes(indexes);
  const correct = matchingUniqueOwnershipIndex(indexes, "skuKey");
  if (correct && present.length === 1) return { state: "ready", index: correct };
  if (present.length === 0) return { state: "missing", indexes: [] };
  return { state: "incompatible", indexes: present };
}

export function decideSkuKeyIndexMigration({
  collectionExists = false,
  operationIndexes = [],
  parentOwnerIndexes = null,
  duplicateSkuKeyCount = 0,
  blankSkuKeyCount = 0,
  documentCount = 0,
} = {}) {
  const held = {
    ok: false,
    executed: false,
    dryRun: true,
    writes: [],
    sentToGini: 0,
    modifiesDocuments: false,
    modifiesParentOwners: false,
    authorizesOwnershipSave: false,
    collection: OWNERSHIP_OPERATION_COLLECTION,
    documentCount: Number(documentCount) || 0,
    command: SKUKEY_INDEX_COMMAND,
  };
  if (!collectionExists) return { ...held, code: "collection_missing" };
  const parent = matchingUniqueOwnershipIndex(parentOwnerIndexes || [], "skuKey");
  if (!parent) return { ...held, code: "parent_owner_index_not_unique" };
  if (Number(duplicateSkuKeyCount) > 0 || Number(blankSkuKeyCount) > 1) {
    return { ...held, code: "duplicate_sku_key" };
  }
  const skuKey = classifySkuKeyIndex(operationIndexes);
  if (skuKey.state === "incompatible") {
    return { ...held, code: "incompatible_sku_key_index", observedIndexes: skuKey.indexes };
  }
  if (skuKey.state === "ready") {
    return { ...held, ok: true, code: "already_ready", command: null };
  }
  if (!matchingUniqueOwnershipIndex(operationIndexes, "operationKey")) {
    return { ...held, code: "operation_key_index_missing" };
  }
  return { ...held, ok: true, code: "ready_to_create" };
}

export async function readSkuKeyIndexState(db) {
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  const operationName = names.get(OWNERSHIP_OPERATION_COLLECTION) || "";
  const parentName = names.get(OWNERSHIP_PARENT_COLLECTION) || "";
  const operation = operationName ? db.collection(operationName) : null;
  const parent = parentName ? db.collection(parentName) : null;
  const [operationIndexes, parentOwnerIndexes, documentCount, duplicateGroups] = await Promise.all([
    operation ? operation.listIndexes().toArray() : [],
    parent ? parent.listIndexes().toArray() : [],
    operation ? operation.countDocuments() : 0,
    operation ? operation.aggregate([
      { $group: { _id: { $toLower: { $trim: { input: { $ifNull: ["$skuKey", ""] } } } }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray() : [],
  ]);
  const blankGroup = duplicateGroups.find((row) => String(row._id || "") === "");
  return {
    collectionExists: Boolean(operationName),
    operationIndexes,
    parentOwnerIndexes,
    duplicateSkuKeyCount: duplicateGroups.filter((row) => String(row._id || "") !== "").length,
    blankSkuKeyCount: blankGroup ? blankGroup.count : 0,
    documentCount,
  };
}

export async function runSkuKeyIndexMigration({
  readState,
  createSkuKeyIndex,
  dryRun = true,
  confirm = false,
} = {}) {
  if (OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED !== true) {
    return {
      ok: false,
      executed: false,
      dryRun: true,
      code: "sku_key_index_migration_disabled",
      writes: [],
      sentToGini: 0,
      modifiesDocuments: false,
      modifiesParentOwners: false,
      authorizesOwnershipSave: false,
      command: SKUKEY_INDEX_COMMAND,
    };
  }
  const before = await readState();
  const decision = decideSkuKeyIndexMigration(before);
  if (dryRun !== false || confirm !== true || decision.code !== "ready_to_create") {
    return { ...decision, executed: false, writes: [], dryRun: true };
  }
  await createSkuKeyIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
  const after = await readState();
  const verified = decideSkuKeyIndexMigration(after);
  if (verified.code !== "already_ready" || after.documentCount !== before.documentCount) {
    return {
      ...decision,
      ok: false,
      executed: true,
      dryRun: false,
      code: "index_verification_failed",
      writes: [`${OWNERSHIP_OPERATION_COLLECTION}.createIndex`],
      documentCount: after.documentCount,
      verified,
    };
  }
  return {
    ...verified,
    ok: true,
    executed: true,
    dryRun: false,
    code: "sku_key_index_created",
    writes: [`${OWNERSHIP_OPERATION_COLLECTION}.createIndex`],
    documentCount: after.documentCount,
  };
}
