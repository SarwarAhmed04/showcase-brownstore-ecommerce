export const ATTEMPT_COLLECTION = "giniskucreateattempts";
export const REQUIRED_ATTEMPT_STATUSES = Object.freeze(["in_progress", "uncertain", "confirmed"]);

function indexKeys(index) {
  return Object.keys(index?.key || {});
}

export function matchingUniqueAttemptIndex(indexes, field) {
  return (
    (indexes || []).find((index) => {
      const keys = indexKeys(index);
      return (
        index?.unique === true &&
        keys.length === 1 &&
        index.key[field] === 1 &&
        index.sparse !== true &&
        !index.partialFilterExpression
      );
    }) || null
  );
}

export function giniSkuCreateAttemptIndexesMatch(indexes) {
  return Boolean(matchingUniqueAttemptIndex(indexes, "skuKey") && matchingUniqueAttemptIndex(indexes, "productId"));
}

export async function attemptIndexesEnforced(collection) {
  try {
    if (typeof collection?.indexes !== "function") return false;
    return giniSkuCreateAttemptIndexesMatch(await collection.indexes());
  } catch {
    return false;
  }
}

function observedIndexes(indexes, field) {
  return (indexes || [])
    .filter((index) => {
      const keys = indexKeys(index);
      return keys.length === 1 && Object.prototype.hasOwnProperty.call(index.key, field);
    })
    .map((index) => ({
      name: String(index.name || ""),
      unique: index.unique === true,
      sparse: index.sparse === true,
      partial: Boolean(index.partialFilterExpression),
      direction: index.key[field],
    }));
}

function describeField(match, indexes, field) {
  return {
    enforced: Boolean(match),
    name: match ? String(match.name || "") : "",
    observed: observedIndexes(indexes, field),
  };
}

function duplicateSamples(rows) {
  return (rows || []).slice(0, 20).map((row) => ({
    value: row?._id == null ? null : String(row._id),
    count: Number(row?.count) || 0,
  }));
}

export function attemptSummaryPipeline() {
  const duplicate = (field) => [
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ];
  const missingString = (field) => [
    {
      $match: {
        $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: "" }, { [field]: { $not: { $type: "string" } } }],
      },
    },
    { $count: "n" },
  ];
  return [
    {
      $facet: {
        total: [{ $count: "n" }],
        duplicateSkuKeys: duplicate("skuKey"),
        duplicateProductIds: duplicate("productId"),
        missingSkuKey: missingString("skuKey"),
        missingProductId: missingString("productId"),
        missingSku: missingString("sku"),
        invalidStatus: [{ $match: { status: { $nin: [...REQUIRED_ATTEMPT_STATUSES] } } }, { $count: "n" }],
      },
    },
  ];
}

function facetCount(rows) {
  return Number(rows?.[0]?.n) || 0;
}

export function readAttemptSummary(row) {
  const facet = row || {};
  return {
    documentCount: facetCount(facet.total),
    duplicateSkuKeys: duplicateSamples(facet.duplicateSkuKeys),
    duplicateProductIds: duplicateSamples(facet.duplicateProductIds),
    missingSkuKey: facetCount(facet.missingSkuKey),
    missingProductId: facetCount(facet.missingProductId),
    missingSku: facetCount(facet.missingSku),
    invalidStatus: facetCount(facet.invalidStatus),
  };
}

export function assessAttemptCollection({
  collectionName = null,
  indexes = [],
  documentCount = 0,
  duplicateSkuKeys = [],
  duplicateProductIds = [],
  missingSkuKey = 0,
  missingProductId = 0,
  missingSku = 0,
  invalidStatus = 0,
} = {}) {
  const skuKeyIndex = matchingUniqueAttemptIndex(indexes, "skuKey");
  const productIdIndex = matchingUniqueAttemptIndex(indexes, "productId");
  const duplicatesWouldPreventIndexCreation = duplicateSkuKeys.length > 0 || duplicateProductIds.length > 0;
  const schemaMatches =
    Number(missingSkuKey) === 0 &&
    Number(missingProductId) === 0 &&
    Number(missingSku) === 0 &&
    Number(invalidStatus) === 0;
  const indexesPresent = Boolean(collectionName && skuKeyIndex && productIdIndex);
  const enforcementConflict = indexesPresent && duplicatesWouldPreventIndexCreation;
  return {
    collectionExists: Boolean(collectionName),
    collectionName: collectionName || null,
    expectedCollection: ATTEMPT_COLLECTION,
    documentCount: Number(documentCount) || 0,
    skuKey: describeField(skuKeyIndex, indexes, "skuKey"),
    productId: describeField(productIdIndex, indexes, "productId"),
    indexesEnforced: indexesPresent && !enforcementConflict,
    schemaMatches,
    duplicatesWouldPreventIndexCreation,
    enforcementConflict,
    duplicateSkuKeys,
    duplicateProductIds,
    missingSkuKey: Number(missingSkuKey) || 0,
    missingProductId: Number(missingProductId) || 0,
    missingSku: Number(missingSku) || 0,
    invalidStatus: Number(invalidStatus) || 0,
    readyForSkuCreateLock: indexesPresent && !enforcementConflict,
  };
}

export function indexCreationProcedure({ collectionName = ATTEMPT_COLLECTION, dataWouldAcceptIndexes = false } = {}) {
  const safeName = collectionName === ATTEMPT_COLLECTION ? ATTEMPT_COLLECTION : "";
  const commands =
    dataWouldAcceptIndexes && safeName
      ? [
          `db.${safeName}.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" })`,
          `db.${safeName}.createIndex({ productId: 1 }, { unique: true, name: "productId_1" })`,
        ]
      : [];
  return {
    automatic: false,
    runFromThisScript: false,
    dataWouldAcceptIndexes: Boolean(dataWouldAcceptIndexes && safeName),
    commands,
    operatorSteps: dataWouldAcceptIndexes
      ? [
          "Run this read-only preflight on the verified Hostinger server and keep the JSON.",
          "Approve a separate production database change. This preflight does not run it.",
          "In mongosh, select the production brownstore database and run only the two createIndex commands in this report.",
          "Run this preflight again. skuKey.enforced and productId.enforced must both be true before any SKU create gate is enabled.",
          "Leave GINI_SYNC_ONE_WRITES_ENABLED and GINI_ALLOW_LIVE_SYNC_ONE_WRITES unset. The SKU create gates do not authorize legacy Sync One Send.",
        ]
      : [
          "Do not create the unique indexes while duplicate skuKey or productId values are present.",
          "Use the duplicate samples in this report to resolve the data, then run this read-only preflight again.",
          "The createIndex commands are withheld until that preflight reports no duplicate groups.",
        ],
  };
}

export function refuseIndexWriteFlags(argv = []) {
  return argv.filter((arg) => /^--(create|apply|write|ensure|sync)(?:-|$)/.test(String(arg)));
}
