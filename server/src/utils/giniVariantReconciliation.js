import { partnerPricePreview } from "./partnerCatalog.js";
import { proposeVariantSku, variationCombinations } from "./giniVariantCatalog.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";
import { interpretColorAttribute } from "./giniVariantChangedPlan.js";

export const RECONCILIATION_AUTHORIZATION = "REGISTER_VERIFIED_GINI_IDENTITIES";

export const VERIFIED_VARIANT_PARENTS = Object.freeze([
  Object.freeze({
    parentSku: "KE20",
    giniProductId: "618623",
    vendorName: "Kozano",
    variants: Object.freeze([
      Object.freeze({ sku: "KE20-BLUE", giniVariantId: "164306", color: "Blue" }),
      Object.freeze({ sku: "KE20-BLACK", giniVariantId: "164307", color: "Black" }),
    ]),
  }),
  Object.freeze({
    parentSku: "EFR-575D-1ADF",
    giniProductId: "618624",
    vendorName: "Versace",
    variants: Object.freeze([
      Object.freeze({ sku: "EFR-575D-1ADF-BLACK", giniVariantId: "164308", color: "Black" }),
      Object.freeze({ sku: "EFR-575D-1ADF-BLUE", giniVariantId: "164309", color: "Blue" }),
    ]),
  }),
  Object.freeze({
    parentSku: "EI-8888",
    giniProductId: "618651",
    vendorName: "Sokany",
    variants: Object.freeze([
      Object.freeze({ sku: "EI-8888-BLUE", giniVariantId: "164312", color: "Blue" }),
      Object.freeze({ sku: "EI-8888-PURPLE", giniVariantId: "164313", color: "Purple" }),
    ]),
  }),
  Object.freeze({
    parentSku: "71868",
    giniProductId: "618652",
    vendorName: "IT Lobby",
    variants: Object.freeze([
      Object.freeze({ sku: "71868-BLUE", giniVariantId: "164314", color: "Blue" }),
      Object.freeze({ sku: "71868-BLACK", giniVariantId: "164315", color: "Black" }),
    ]),
  }),
  Object.freeze({
    parentSku: "69392",
    giniProductId: "618653",
    vendorName: "IT Lobby",
    variants: Object.freeze([
      Object.freeze({ sku: "69392-BLUE", giniVariantId: "164316", color: "Blue" }),
      Object.freeze({ sku: "69392-PURPLE", giniVariantId: "164317", color: "Purple" }),
      Object.freeze({ sku: "69392-BLACK", giniVariantId: "164318", color: "Black" }),
    ]),
  }),
  Object.freeze({
    parentSku: "75244",
    giniProductId: "613402",
    vendorName: "Jawal Flex",
    variants: Object.freeze([
      Object.freeze({ sku: "75244-BLUE", giniVariantId: "163992", color: "Blue" }),
      Object.freeze({ sku: "75244-BLACK", giniVariantId: "163993", color: "Black" }),
      Object.freeze({ sku: "75244-PURPLE", giniVariantId: "163994", color: "Purple" }),
    ]),
  }),
]);

const EXPECTED_COLORS = Object.freeze(["Blue", "Black", "Purple"]);

export const REQUIRED_RECONCILIATION_INDEXES = Object.freeze([
  Object.freeze({ collection: "ginivariantidentities", key: { productId: 1, sourceVariantId: 1, sourceSizeId: 1 }, unique: true }),
  Object.freeze({ collection: "ginivariantidentities", key: { approvedSkuKey: 1 }, unique: true, partialField: "approvedSkuKey" }),
  Object.freeze({ collection: "ginivariantidentities", key: { confirmedGiniVariantId: 1 }, unique: true, partialField: "confirmedGiniVariantId" }),
  Object.freeze({ collection: "ginivariantparentowners", key: { skuKey: 1 }, unique: true }),
  Object.freeze({ collection: "ginivariantattributecontracts", key: { key: 1 }, unique: true }),
]);

function text(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return String(value.en || value.ku || value.ar || value.name || "").trim();
}

function same(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

function idOf(doc) {
  return String(doc?._id || doc?.id || doc?.productId || "");
}

export function vendorIdentity(doc) {
  const created = doc?.createdBy;
  return {
    vendorId: String(created?._id || created?.id || doc?.vendorId || ""),
    vendorName: text(created?.name) || text(doc?.vendor) || text(doc?.vendorName),
  };
}

function conflict(code, detail, extra = {}) {
  return { code, detail, ...extra };
}

function sameKey(actual = {}, expected = {}) {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => actual[key] === expected[key]);
}

export function missingReconciliationIndexes(indexesByCollection = {}) {
  const missing = [];
  for (const expected of REQUIRED_RECONCILIATION_INDEXES) {
    const found = (indexesByCollection[expected.collection] || []).some((index) => {
      if (!sameKey(index.key, expected.key) || index.unique !== true) return false;
      if (!expected.partialField) return true;
      const partial = index.partialFilterExpression?.[expected.partialField];
      return Boolean(partial && (partial.$gt === "" || partial.$gt === 0));
    });
    if (!found) missing.push({ collection: expected.collection, key: expected.key });
  }
  return missing;
}

export function explainMultiVariantCount(rows = []) {
  const multi = [];
  const omitted = [];
  for (const row of rows) {
    const variantCount = Number(row.variantCount);
    if (!Number.isInteger(variantCount) || variantCount < 2) continue;
    const entry = {
      productId: idOf(row),
      itemCode: String(row.itemCode || ""),
      vendor: vendorIdentity(row).vendorName,
      name: text(row.name),
      variantCount,
    };
    multi.push(entry);
    if (!giniSkuKey(row.itemCode)) omitted.push(entry);
  }
  return {
    multiVariantDocuments: multi.length,
    catalogRows: multi.length - omitted.length,
    omittedBlankSku: omitted,
  };
}

function colorContractFromGet(colorAttribute) {
  const color = colorAttribute?.state ? colorAttribute : interpretColorAttribute(colorAttribute);
  const labels = Array.isArray(color.labels) ? color.labels : [];
  const exact = labels.length === EXPECTED_COLORS.length && EXPECTED_COLORS.every((label, index) => labels[index] === label);
  return { color, exact, labels };
}

function contractDocument(labels) {
  return {
    key: "color",
    attributeId: "3696",
    name: "Color",
    values: [...labels],
    source: "gini-get-3696",
  };
}

function sameContract(existing, proposed) {
  if (!existing) return false;
  const values = Array.isArray(existing.values) ? existing.values : [];
  return existing.key === "color"
    && String(existing.attributeId) === proposed.attributeId
    && String(existing.name) === proposed.name
    && values.length === proposed.values.length
    && proposed.values.every((value, index) => values[index] === value);
}

function identityDocument({ product, vendor, parent, remote, source }) {
  return {
    productId: idOf(product),
    ibsherId: String(product.ibsherId || ""),
    vendorId: vendor.vendorId,
    parentSku: parent.parentSku,
    parentSkuKey: giniSkuKey(parent.parentSku),
    sourceVariantId: source.sourceVariantId,
    sourceSizeId: source.sourceSizeId || "",
    proposedSku: remote.sku,
    proposedSkuKey: giniSkuKey(remote.sku),
    approvedSku: remote.sku,
    approvedSkuKey: giniSkuKey(remote.sku),
    confirmedGiniVariantId: String(remote.id),
    attributeId: "3696",
    attributeName: "Color",
    attributeValue: remote.color,
    lastVerifiedQuantity: remote.quantity,
    lastVerifiedPrice: remote.price,
    status: "verified",
    approvalNote: "Prepared from a GET-only reconciliation of an existing GINI variant. Nothing was sent to GINI.",
  };
}

function sameIdentity(existing, proposed) {
  if (!existing) return false;
  const fields = ["productId", "sourceVariantId", "sourceSizeId", "approvedSku", "confirmedGiniVariantId", "attributeId", "attributeValue", "status"];
  return fields.every((field) => String(existing[field] || "") === String(proposed[field] || ""));
}

function ownerDocument({ product, vendor, parent, remote }) {
  return {
    skuKey: giniSkuKey(parent.parentSku),
    parentSku: parent.parentSku,
    productId: idOf(product),
    vendorId: vendor.vendorId,
    giniProductId: String(remote.id),
    parentQuantity: remote.quantity,
    visibility: remote.visibility,
    status: "verified_remote",
    approvalNote: "Prepared from a GET-only reconciliation of an existing GINI parent. Nothing was sent to GINI.",
  };
}

function sameOwner(existing, proposed) {
  if (!existing) return false;
  return ["skuKey", "parentSku", "productId", "giniProductId", "visibility", "status"].every((field) => String(existing[field] || "") === String(proposed[field] || ""));
}

function remoteVariantMap(remote) {
  const map = new Map();
  for (const row of remote?.variants || []) {
    const key = giniSkuKey(row.sku);
    if (!key) continue;
    if (map.has(key)) map.get(key).duplicate = true;
    else map.set(key, { ...row, id: String(row.id || ""), duplicate: false });
  }
  return map;
}

export function commissionImplication(product, rules = []) {
  const priced = partnerPricePreview(product, rules);
  return {
    productId: idOf(product),
    itemCode: String(product?.itemCode || ""),
    storePrice: priced.storePrice,
    rate: priced.rate,
    rawPrice: priced.rawPrice,
    platformPrice: priced.price,
    rule: priced.commission
      ? {
          scope: priced.commission.scope,
          percentage: priced.commission.percentage,
          targetId: priced.commission.targetId,
          targetName: text(priced.commission.targetName),
        }
      : null,
  };
}

export function planVariantReconciliation({
  products = [],
  identities = [],
  owners = [],
  contracts = [],
  indexesByCollection = null,
  remoteBySku = {},
  colorAttribute = null,
  commissionRules = [],
} = {}) {
  const conflicts = [];
  const excluded = [];
  const matches = [];
  const records = [];
  const colorRead = colorContractFromGet(colorAttribute);
  if (!colorRead.exact) {
    conflicts.push(conflict("color_contract_not_verified", "GET /attributes/3696 did not return Color values Blue, Black, Purple."));
  }

  const contract = colorRead.exact ? contractDocument(colorRead.labels) : null;
  const existingContract = (contracts || []).find((row) => row.key === "color") || null;
  if (contract && existingContract && !sameContract(existingContract, contract)) {
    conflicts.push(conflict("color_contract_conflict", "An existing color contract does not match attribute 3696.", {
      existingAttributeId: String(existingContract.attributeId || ""),
    }));
  } else if (contract) {
    records.push({
      collection: "ginivariantattributecontracts",
      action: existingContract ? "unchanged" : "insert",
      naturalKey: { key: "color" },
      before: existingContract ? { attributeId: String(existingContract.attributeId), values: existingContract.values || [] } : null,
      after: contract,
    });
  }

  const missingIndexes = indexesByCollection == null ? REQUIRED_RECONCILIATION_INDEXES.map((row) => ({ collection: row.collection, key: row.key, unchecked: true })) : missingReconciliationIndexes(indexesByCollection);
  if (indexesByCollection == null) conflicts.push(conflict("indexes_not_checked", "Unique indexes were not read, so apply stays closed."));
  else if (missingIndexes.length) conflicts.push(conflict("unique_index_missing", "A required unique index is missing. Apply stays closed and no index is created.", { missing: missingIndexes }));

  for (const parent of VERIFIED_VARIANT_PARENTS) {
    const candidates = (products || []).filter((product) => giniSkuKey(product.itemCode) === giniSkuKey(parent.parentSku));
    const ownersForSku = candidates.filter((product) => same(vendorIdentity(product).vendorName, parent.vendorName));
    for (const product of candidates) {
      const vendor = vendorIdentity(product);
      if (!same(vendor.vendorName, parent.vendorName)) {
        excluded.push({
          parentSku: parent.parentSku,
          productId: idOf(product),
          vendor: vendor.vendorName,
          vendorId: vendor.vendorId,
          reason: "other_vendor_not_registered",
        });
      }
    }
    if (ownersForSku.length !== 1) {
      conflicts.push(conflict(ownersForSku.length ? "duplicate_owner_candidate" : "owner_product_missing", `${parent.parentSku} must match one ${parent.vendorName} product.`, {
        parentSku: parent.parentSku,
        count: ownersForSku.length,
      }));
      continue;
    }
    const product = ownersForSku[0];
    const vendor = vendorIdentity(product);
    const remote = remoteBySku[parent.parentSku] || remoteBySku[giniSkuKey(parent.parentSku)] || null;
    const remoteProblems = [];
    if (!remote || remote.state !== "present") remoteProblems.push("remote_parent_unread");
    else if (String(remote.id || "") !== parent.giniProductId || !same(remote.sku, parent.parentSku)) remoteProblems.push("remote_parent_mismatch");
    else if (remote.visibility !== "hidden") remoteProblems.push("remote_visibility_not_hidden");
    const remoteVariants = remoteVariantMap(remote);
    const combinations = variationCombinations(product);
    const sizes = new Set(combinations.map((row) => row.sizeKey));
    const multipleSizes = sizes.size > 1;
    const variantMatches = [];
    for (const expected of parent.variants) {
      const live = remoteVariants.get(giniSkuKey(expected.sku));
      const source = combinations.find((row) => giniSkuKey(proposeVariantSku(parent.parentSku, row.color, row.size, { multipleSizes })) === giniSkuKey(expected.sku));
      if (!live || live.duplicate || String(live.id) !== expected.giniVariantId || !same(live.color, expected.color) || String(live.attributeId || "") !== "3696") {
        remoteProblems.push(`remote_variant_mismatch:${expected.sku}`);
      }
      if (!source?.sourceVariantId || !source.sourceSizeId) remoteProblems.push(`source_variant_missing:${expected.sku}`);
      if (live && source?.sourceVariantId && source.sourceSizeId && !remoteProblems.some((code) => code.endsWith(expected.sku))) {
        variantMatches.push({ expected, live, source });
      }
    }
    if (remoteProblems.length) {
      conflicts.push(conflict("remote_or_source_mismatch", `${parent.parentSku} did not match the verified GINI variants and production source ids.`, {
        parentSku: parent.parentSku,
        productId: idOf(product),
        problems: remoteProblems,
      }));
      continue;
    }
    const owner = ownerDocument({ product, vendor, parent, remote });
    const existingOwner = (owners || []).find((row) => giniSkuKey(row.skuKey || row.parentSku) === owner.skuKey) || null;
    let ownerAction = "insert";
    if (existingOwner && sameOwner(existingOwner, owner)) ownerAction = "unchanged";
    else if (existingOwner) {
      conflicts.push(conflict("owner_conflict", `${parent.parentSku} already has a different owner or GINI id. It was not overwritten.`, {
        parentSku: parent.parentSku,
        existingProductId: String(existingOwner.productId || ""),
        existingGiniProductId: String(existingOwner.giniProductId || ""),
      }));
      ownerAction = "conflict";
    }
    if (ownerAction !== "conflict") {
      records.push({
        collection: "ginivariantparentowners",
        action: ownerAction,
        naturalKey: { skuKey: owner.skuKey },
        before: existingOwner ? { productId: String(existingOwner.productId || ""), giniProductId: String(existingOwner.giniProductId || "") } : null,
        after: owner,
      });
    }
    for (const match of variantMatches) {
      const proposed = identityDocument({ product, vendor, parent, remote: match.live, source: match.source });
      const existing = (identities || []).find((row) => String(row.productId) === proposed.productId && String(row.sourceVariantId) === proposed.sourceVariantId && String(row.sourceSizeId || "") === proposed.sourceSizeId) || null;
      const skuOwner = (identities || []).find((row) => giniSkuKey(row.approvedSkuKey || row.approvedSku) === proposed.approvedSkuKey) || null;
      const idOwner = (identities || []).find((row) => String(row.confirmedGiniVariantId || "") === proposed.confirmedGiniVariantId) || null;
      let action = "insert";
      if (existing && sameIdentity(existing, proposed)) action = "unchanged";
      else if (existing || (skuOwner && String(skuOwner.productId) !== proposed.productId) || (idOwner && String(idOwner.productId) !== proposed.productId)) {
        action = "conflict";
        conflicts.push(conflict("identity_conflict", `${proposed.approvedSku} is already registered to a different source or remote id. It was not overwritten.`, {
          parentSku: parent.parentSku,
          sku: proposed.approvedSku,
          existingProductId: String((existing || skuOwner || idOwner)?.productId || ""),
        }));
      }
      if (action !== "conflict") {
        records.push({
          collection: "ginivariantidentities",
          action,
          naturalKey: { productId: proposed.productId, sourceVariantId: proposed.sourceVariantId, sourceSizeId: proposed.sourceSizeId },
          before: existing ? { approvedSku: existing.approvedSku || "", confirmedGiniVariantId: existing.confirmedGiniVariantId || "" } : null,
          after: proposed,
        });
      }
      variantMatches.found = true;
      match.proposed = proposed;
      match.action = action;
    }
    matches.push({
      parentSku: parent.parentSku,
      giniProductId: parent.giniProductId,
      productId: idOf(product),
      vendor: vendor.vendorName,
      vendorId: vendor.vendorId,
      name: text(product.name),
      variants: variantMatches.map((match) => ({
        sku: match.expected.sku,
        giniVariantId: match.expected.giniVariantId,
        color: match.live.color,
        quantity: match.live.quantity,
        price: match.live.price,
        sourceVariantId: match.source.sourceVariantId,
        sourceSizeId: match.source.sourceSizeId,
        action: match.action,
      })),
    });
  }

  const priceNotes = (products || [])
    .filter((product) => VERIFIED_VARIANT_PARENTS.some((parent) => giniSkuKey(product.itemCode) === giniSkuKey(parent.parentSku) && same(vendorIdentity(product).vendorName, parent.vendorName)))
    .map((product) => commissionImplication(product, commissionRules));
  const inserts = records.filter((record) => record.action === "insert");
  const expectedCounts = { contract: contract ? 1 : 0, owners: VERIFIED_VARIANT_PARENTS.length, identities: VERIFIED_VARIANT_PARENTS.reduce((sum, parent) => sum + parent.variants.length, 0) };
  const actualCounts = {
    contract: records.filter((record) => record.collection === "ginivariantattributecontracts" && record.action !== "conflict").length,
    owners: records.filter((record) => record.collection === "ginivariantparentowners").length,
    identities: records.filter((record) => record.collection === "ginivariantidentities").length,
  };
  if (actualCounts.contract !== expectedCounts.contract || actualCounts.owners !== expectedCounts.owners || actualCounts.identities !== expectedCounts.identities) {
    conflicts.push(conflict("record_count_mismatch", "The proposal is not exactly one color contract, six owners, and fourteen identities.", { expectedCounts, actualCounts }));
  }
  return {
    canApply: conflicts.length === 0,
    writesEnabled: false,
    giniWrites: [],
    authorization: "required",
    before: {
      contracts: (contracts || []).filter((row) => row.key === "color").length,
      owners: (owners || []).length,
      identities: (identities || []).length,
    },
    after: {
      contracts: records.filter((record) => record.collection === "ginivariantattributecontracts").length,
      owners: actualCounts.owners,
      identities: actualCounts.identities,
      inserts: inserts.length,
      unchanged: records.filter((record) => record.action === "unchanged").length,
    },
    matches,
    excluded,
    records,
    conflicts,
    priceNotes,
    protectedCollections: ["products", "commissions", "miswag", "elryan", "ibsher"],
  };
}

export async function applyVariantReconciliation(plan, { authorization = "", confirm = false, write } = {}) {
  if (authorization !== RECONCILIATION_AUTHORIZATION || confirm !== true) {
    return { applied: false, code: "authorization_required", writes: 0 };
  }
  if (!plan?.canApply || (plan.conflicts || []).length || (plan.giniWrites || []).length) {
    return { applied: false, code: "plan_not_applicable", writes: 0 };
  }
  if (typeof write !== "function") return { applied: false, code: "writer_required", writes: 0 };
  const inserts = (plan.records || []).filter((record) => record.action === "insert");
  for (const record of inserts) await write(record);
  return { applied: inserts.length > 0, code: inserts.length ? "registered" : "already_registered", writes: inserts.length };
}
