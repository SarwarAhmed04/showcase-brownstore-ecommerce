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

export const OWNERSHIP_INDEX_MIGRATION_RELEASED = false;
export const OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED = OWNERSHIP_INDEX_MIGRATION_RELEASED;
export const VERIFIED_OWNERSHIP_DATABASE = "brownstore";

export const SKUKEY_INDEX_COMMAND = createIndexCommand("skuKey", "skuKey_1");
export const OPERATION_KEY_INDEX_COMMAND = createIndexCommand("operationKey", "operationKey_1");
export const OWNERSHIP_MIGRATION_COMMANDS = Object.freeze([
  `db.createCollection("${OWNERSHIP_OPERATION_COLLECTION}")`,
  OPERATION_KEY_INDEX_COMMAND,
  SKUKEY_INDEX_COMMAND,
]);

export function ownershipDatabaseIdentityAccepted(identity = {}) {
  return identity?.databaseName === VERIFIED_OWNERSHIP_DATABASE
    && identity?.loopback === true
    && identity?.merchantHostMatches === true
    && identity?.clientMaskMatches === true
    && identity?.previewFingerprintMatches === true;
}

function indexesOnField(indexes, field) {
  return (indexes || []).filter((index) => Object.prototype.hasOwnProperty.call(index?.key || {}, field));
}

export function classifyFieldIndex(indexes, field) {
  const present = indexesOnField(indexes, field);
  const correct = matchingUniqueOwnershipIndex(indexes, field);
  if (correct && present.length === 1) return { state: "ready", index: correct };
  if (present.length === 0) return { state: "missing", indexes: [] };
  return { state: "incompatible", indexes: present };
}

export function classifySkuKeyIndex(indexes) {
  return classifyFieldIndex(indexes, "skuKey");
}

function unexpectedOperationIndexes(indexes) {
  return (indexes || []).filter((index) => {
    if (index?.name === "_id_") return false;
    const keys = indexKeys(index);
    return !(keys.length === 1 && (keys[0] === "operationKey" || keys[0] === "skuKey"));
  });
}

export function decideOwnershipIndexMigration({
  identity = null,
  databaseName = "",
  parentCollectionExists = true,
  collectionExists = false,
  operationIndexes = [],
  parentOwnerIndexes = null,
  duplicateOperationKeyCount = 0,
  blankOperationKeyCount = 0,
  duplicateSkuKeyCount = 0,
  blankSkuKeyCount = 0,
  documentCount = 0,
  parentDocumentCount = 0,
} = {}) {
  const held = {
    ok: false,
    executed: false,
    dryRun: true,
    writes: [],
    sentToGini: 0,
    modifiesDocuments: false,
    modifiesParentOwners: false,
    modifiesVariantRecords: false,
    authorizesOwnershipSave: false,
    collection: OWNERSHIP_OPERATION_COLLECTION,
    databaseName: databaseName || identity?.databaseName || "",
    documentCount: Number(documentCount) || 0,
    parentDocumentCount: Number(parentDocumentCount) || 0,
    commands: [],
    command: null,
    actions: { createCollection: false, operationKey: false, skuKey: false },
  };
  if (!ownershipDatabaseIdentityAccepted(identity) || databaseName !== identity.databaseName) {
    return { ...held, code: "database_identity_unverified" };
  }
  if (parentCollectionExists === false) return { ...held, code: "parent_owner_collection_missing" };
  if (!matchingUniqueOwnershipIndex(parentOwnerIndexes || [], "skuKey")) {
    return { ...held, code: "parent_owner_index_not_unique" };
  }
  if (Number(duplicateOperationKeyCount) > 0 || Number(blankOperationKeyCount) > 1) {
    return { ...held, code: "duplicate_operation_key" };
  }
  if (Number(duplicateSkuKeyCount) > 0 || Number(blankSkuKeyCount) > 1) {
    return { ...held, code: "duplicate_sku_key" };
  }
  if (!collectionExists) {
    return {
      ...held,
      ok: true,
      code: "ready_to_create",
      commands: [...OWNERSHIP_MIGRATION_COMMANDS],
      command: OWNERSHIP_MIGRATION_COMMANDS[0],
      actions: { createCollection: true, operationKey: true, skuKey: true },
    };
  }
  const unexpected = unexpectedOperationIndexes(operationIndexes);
  if (unexpected.length) return { ...held, code: "unexpected_operation_index", observedIndexes: unexpected };
  const operationKey = classifyFieldIndex(operationIndexes, "operationKey");
  const skuKey = classifyFieldIndex(operationIndexes, "skuKey");
  if (operationKey.state === "incompatible") {
    return { ...held, code: "incompatible_operation_key_index", observedIndexes: operationKey.indexes };
  }
  if (skuKey.state === "incompatible") {
    return { ...held, code: "incompatible_sku_key_index", observedIndexes: skuKey.indexes };
  }
  const commands = [];
  const actions = { createCollection: false, operationKey: false, skuKey: false };
  if (operationKey.state === "missing") {
    commands.push(OPERATION_KEY_INDEX_COMMAND);
    actions.operationKey = true;
  }
  if (skuKey.state === "missing") {
    commands.push(SKUKEY_INDEX_COMMAND);
    actions.skuKey = true;
  }
  if (!commands.length) return { ...held, ok: true, code: "already_ready" };
  return { ...held, ok: true, code: "ready_to_create", commands, command: commands[0], actions };
}

export function decideSkuKeyIndexMigration(observed = {}) {
  return decideOwnershipIndexMigration(observed);
}

async function duplicateKeyCounts(collection, field) {
  if (!collection) return { duplicateCount: 0, blankCount: 0 };
  const groups = await collection.aggregate([
    { $group: { _id: { $toLower: { $trim: { input: { $ifNull: [`$${field}`, ""] } } } }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  const blank = groups.find((row) => String(row._id || "") === "");
  return {
    duplicateCount: groups.filter((row) => String(row._id || "") !== "").length,
    blankCount: blank ? blank.count : 0,
  };
}

export async function readSkuKeyIndexState(db) {
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  const operationName = names.get(OWNERSHIP_OPERATION_COLLECTION) || "";
  const parentName = names.get(OWNERSHIP_PARENT_COLLECTION) || "";
  const operation = operationName ? db.collection(operationName) : null;
  const parent = parentName ? db.collection(parentName) : null;
  const [operationIndexes, parentOwnerIndexes, documentCount, parentDocumentCount, operationKeys, skuKeys] = await Promise.all([
    operation ? operation.listIndexes().toArray() : [],
    parent ? parent.listIndexes().toArray() : [],
    operation ? operation.countDocuments() : 0,
    parent ? parent.countDocuments() : 0,
    duplicateKeyCounts(operation, "operationKey"),
    duplicateKeyCounts(operation, "skuKey"),
  ]);
  return {
    databaseName: db.databaseName,
    parentCollectionExists: Boolean(parentName),
    collectionExists: Boolean(operationName),
    operationIndexes,
    parentOwnerIndexes,
    duplicateOperationKeyCount: operationKeys.duplicateCount,
    blankOperationKeyCount: operationKeys.blankCount,
    duplicateSkuKeyCount: skuKeys.duplicateCount,
    blankSkuKeyCount: skuKeys.blankCount,
    documentCount,
    parentDocumentCount,
  };
}

export async function applyOwnershipIndexMigration({
  readState,
  createCollection,
  createOperationKeyIndex,
  createSkuKeyIndex,
  dryRun = true,
  confirm = false,
} = {}) {
  const before = await readState();
  const decision = decideOwnershipIndexMigration(before);
  const stopped = {
    ...decision,
    executed: false,
    writes: [],
    dryRun: true,
    modifiesDocuments: false,
    modifiesParentOwners: false,
    modifiesVariantRecords: false,
    authorizesOwnershipSave: false,
    sentToGini: 0,
  };
  if (dryRun !== false || confirm !== true || decision.code !== "ready_to_create") return stopped;
  const writes = [];
  if (decision.actions.createCollection) {
    await createCollection(OWNERSHIP_OPERATION_COLLECTION);
    writes.push(`${OWNERSHIP_OPERATION_COLLECTION}.createCollection`);
  }
  if (decision.actions.operationKey) {
    await createOperationKeyIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" });
    writes.push(`${OWNERSHIP_OPERATION_COLLECTION}.createIndex(operationKey_1)`);
  }
  if (decision.actions.skuKey) {
    await createSkuKeyIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    writes.push(`${OWNERSHIP_OPERATION_COLLECTION}.createIndex(skuKey_1)`);
  }
  const after = await readState();
  const verified = decideOwnershipIndexMigration(after);
  const unchanged = after.documentCount === before.documentCount && after.parentDocumentCount === before.parentDocumentCount;
  if (verified.code !== "already_ready" || !unchanged) {
    return {
      ok: false,
      executed: true,
      dryRun: false,
      code: "index_verification_failed",
      writes,
      documentCount: after.documentCount,
      parentDocumentCount: after.parentDocumentCount,
      verified,
      modifiesDocuments: false,
      modifiesParentOwners: false,
      modifiesVariantRecords: false,
      authorizesOwnershipSave: false,
      sentToGini: 0,
    };
  }
  return {
    ...verified,
    ok: true,
    executed: true,
    dryRun: false,
    code: "ownership_indexes_created",
    writes,
    documentCount: after.documentCount,
    parentDocumentCount: after.parentDocumentCount,
    modifiesDocuments: false,
    modifiesParentOwners: false,
    modifiesVariantRecords: false,
    authorizesOwnershipSave: false,
    sentToGini: 0,
  };
}

export async function runOwnershipIndexMigration(options = {}) {
  if (OWNERSHIP_INDEX_MIGRATION_RELEASED !== true) {
    return {
      ok: false,
      executed: false,
      dryRun: true,
      code: "ownership_index_migration_disabled",
      writes: [],
      sentToGini: 0,
      modifiesDocuments: false,
      modifiesParentOwners: false,
      modifiesVariantRecords: false,
      authorizesOwnershipSave: false,
      commands: [...OWNERSHIP_MIGRATION_COMMANDS],
    };
  }
  return applyOwnershipIndexMigration(options);
}

export async function runSkuKeyIndexMigration(options = {}) {
  return runOwnershipIndexMigration(options);
}
