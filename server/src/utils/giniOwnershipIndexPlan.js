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
