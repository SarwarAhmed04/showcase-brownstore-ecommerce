import { Commission } from "../models/Commission.js";
import { GiniVariantAttributeContract } from "../models/GiniVariantAttributeContract.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantOperation } from "../models/GiniVariantOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { productScopeIds } from "../utils/platformEligibility.js";
import { isTaxonomyComplete } from "../utils/platformTaxonomyFields.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { classifyVariantProduct, giniVariantSyncWritesEnabled, proposalConflicts } from "../utils/giniVariantCatalog.js";
import { buildReusableVariantFields, buildVariantParentPreview } from "../utils/giniVariantPayload.js";
import { giniCatalogText, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import { explicitRemoteAttributeId } from "../utils/giniVariantTestContract.js";

const CACHE_MS = 15000;
let cache = { at: 0, value: null };

export function clearVariantCatalogCache() {
  cache = { at: 0, value: null };
}

function emptySummary() {
  return {
    total: 0,
    readyForReview: 0,
    awaitingCategory: 0,
    awaitingAttribute: 0,
    duplicateParent: 0,
    awaitingOwnership: 0,
    missingSkuApproval: 0,
    existingRemoteParent: 0,
    verifiedUnchanged: 0,
    blocked: 0,
    uncertain: 0,
    approvedForFutureSync: 0,
    needsReview: 0,
  };
}

function addCounters(summary, row) {
  summary.total += 1;
  if (row.status === "READY_FOR_REVIEW") summary.readyForReview += 1;
  if (row.status === "APPROVED_FOR_FUTURE_SYNC") summary.approvedForFutureSync += 1;
  if (row.status === "NEEDS_REVIEW") summary.needsReview += 1;
  if (row.status === "BLOCKED") summary.blocked += 1;
  if (row.status === "UNCERTAIN") summary.uncertain += 1;
  if (row.status === "VERIFIED_REMOTE") summary.verifiedUnchanged += 1;
  if (row.blockers.includes("missing_mapping")) summary.awaitingCategory += 1;
  if (row.blockers.includes("missing_attribute") || row.blockers.includes("size_attribute_unverified")) summary.awaitingAttribute += 1;
  if (row.blockers.includes("duplicate_parent_sku") || row.ownerCount > 1) summary.duplicateParent += 1;
  if (row.blockers.includes("duplicate_parent_sku")) summary.awaitingOwnership += 1;
  if (row.blockers.includes("missing_variant_sku_approval")) summary.missingSkuApproval += 1;
  if (row.remoteParent?.giniProductId) summary.existingRemoteParent += 1;
}

export async function loadVariantCatalog({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [rules, eligibility, identities, owners, contracts, operations, remoteParents] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    GiniVariantIdentity.find({}).lean(),
    GiniVariantParentOwner.find({}).lean(),
    GiniVariantAttributeContract.find({}).lean(),
    GiniVariantOperation.find({}).lean(),
    GiniVariantParentOwner.find({ status: "verified_remote" }).lean(),
  ]);
  const colorContract = contracts.find((row) => row.key === "color") || null;
  const sizeContract = contracts.find((row) => row.key === "size") || null;
  const identityByProduct = new Map();
  for (const row of identities) {
    if (!identityByProduct.has(row.productId)) identityByProduct.set(row.productId, []);
    identityByProduct.get(row.productId).push(row);
  }
  const ownerBySku = new Map(owners.map((row) => [row.skuKey, row]));
  const operationByProduct = new Map(operations.map((row) => [row.productId, row]));
  const remoteBySku = new Map(remoteParents.map((row) => [row.skuKey, row]));
  const skuOwners = new Map();
  const multi = [];
  const cursor = Product.find({ "variants.1": { $exists: true } })
    .select("ibsherId itemCode name description price variants category subCategory collectionName brand createdBy isActive")
    .lean()
    .cursor();
  for await (const doc of cursor) {
    const key = giniSkuKey(doc.itemCode);
    if (!key) continue;
    if (!skuOwners.has(key)) skuOwners.set(key, []);
    skuOwners.get(key).push(String(doc._id));
    multi.push(doc);
  }
  const rows = [];
  for (const doc of multi) {
    const key = giniSkuKey(doc.itemCode);
    const ids = productScopeIds(doc);
    const saved = ids.collection ? taxonomyValuesForProduct(doc, eligibility) : null;
    const mappingOk = Boolean(saved && isTaxonomyComplete("gini", saved));
    const priced = partnerPricePreview(doc, rules);
    const canonical = ownerBySku.get(key);
    const remote = remoteBySku.get(key);
    const classified = classifyVariantProduct({
      doc,
      giniPrice: priced.priceReview ? null : priced.price,
      mappingOk,
      categoryId: saved?.categoryId || "",
      subcategoryId: saved?.subcategoryId || "",
      ownerIds: skuOwners.get(key) || [],
      canonicalOwnerId: canonical?.productId || "",
      identities: identityByProduct.get(String(doc._id)) || [],
      colorContract,
      sizeContract,
      remoteParent: remote ? { giniProductId: remote.giniProductId, productId: remote.productId, visibility: remote.visibility, parentQuantity: remote.parentQuantity } : null,
      operationStatus: operationByProduct.get(String(doc._id))?.status || "",
    });
    classified.ownerCount = (skuOwners.get(key) || []).length;
    classified.mappingLiveStatus = "unknown";
    classified.canSend = false;
    classified.priceScope = {
      storePrice: priced.priceReview ? null : priced.storePrice,
      priceReview: priced.priceReview === true,
      vendorId: ids.vendor,
      brandId: ids.brand,
      categoryId: ids.category,
      subCategoryId: ids.subcategory,
      collectionId: ids.collection,
    };
    rows.push(classified);
  }
  const conflicts = proposalConflicts(rows);
  const conflictIds = new Set(conflicts.map((row) => row.productId));
  for (const row of rows) {
    if (conflictIds.has(row.productId) && row.status === "READY_FOR_REVIEW") {
      row.status = "NEEDS_REVIEW";
      row.blockers = [...new Set([...row.blockers, "variant_sku_conflict"])];
    }
  }
  const summary = emptySummary();
  for (const row of rows) addCounters(summary, row);
  const value = { summary, products: rows, conflicts, writesEnabled: giniVariantSyncWritesEnabled(), canSend: false };
  cache = { at: Date.now(), value };
  return value;
}

export async function variantCatalogPage({ status = "", page = 1, pageSize = 20 } = {}) {
  const catalog = await loadVariantCatalog();
  const filtered = status ? catalog.products.filter((row) => row.status === status) : catalog.products;
  const start = Math.max(0, (Number(page) || 1) - 1) * pageSize;
  return {
    summary: catalog.summary,
    writesEnabled: false,
    canSend: false,
    page: Number(page) || 1,
    total: filtered.length,
    products: filtered.slice(start, start + pageSize).map(publicProduct),
  };
}

function publicProduct(row) {
  return {
    productId: row.productId,
    name: row.name,
    vendor: row.vendor,
    sourceItemId: row.sourceItemId || "",
    parentSku: row.parentSku,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    status: row.status,
    blockers: row.blockers,
    canSend: false,
    intendedAction: row.intendedAction,
    mappingLiveStatus: row.mappingLiveStatus,
    remoteParent: row.remoteParent,
    combinations: (row.combinations || []).map((item) => ({
      sourceVariantId: item.sourceVariantId,
      sourceSizeId: item.sourceSizeId,
      color: item.color,
      size: item.size,
      stock: item.stock,
      price: item.price,
      images: item.images,
      proposedSku: item.proposedSku,
      attributeId: item.attributeId,
      attributeName: item.attributeName,
    })),
  };
}

async function ensureIdentityIndexes() {
  await GiniVariantIdentity.createIndexes();
  await GiniVariantParentOwner.createIndexes();
}

export async function approveVariantSkus({ productId, confirm = false, combinations = [] } = {}) {
  if (confirm !== true) return { ok: false, code: "approval_required", sentToGini: 0 };
  const catalog = await loadVariantCatalog({ force: true });
  const row = catalog.products.find((item) => item.productId === String(productId || ""));
  if (!row) return { ok: false, code: "product_not_found", sentToGini: 0 };
  if (row.status !== "READY_FOR_REVIEW") return { ok: false, code: "not_ready_for_approval", status: row.status, sentToGini: 0 };
  if (row.blockers.includes("variant_sku_conflict")) return { ok: false, code: "variant_sku_conflict", sentToGini: 0 };
  const submitted = new Map((combinations || []).map((item) => [`${item.sourceVariantId}\0${item.sourceSizeId || ""}`, normalizeGiniItemCode(item.sku)]));
  if (submitted.size !== row.combinations.length) return { ok: false, code: "approval_mismatch", sentToGini: 0 };
  for (const combo of row.combinations) {
    const key = `${combo.sourceVariantId}\0${combo.sourceSizeId}`;
    if (giniSkuKey(submitted.get(key)) !== giniSkuKey(combo.proposedSku)) return { ok: false, code: "approval_mismatch", sentToGini: 0 };
  }
  await ensureIdentityIndexes();
  const doc = await Product.findById(productId).select("ibsherId itemCode createdBy").lean();
  for (const combo of row.combinations) {
    await GiniVariantIdentity.updateOne(
      { productId: row.productId, sourceVariantId: combo.sourceVariantId, sourceSizeId: combo.sourceSizeId || "" },
      {
        $set: {
          ibsherId: String(doc?.ibsherId || ""),
          vendorId: String(doc?.createdBy?._id || ""),
          parentSku: row.parentSku,
          parentSkuKey: giniSkuKey(row.parentSku),
          proposedSku: combo.proposedSku,
          proposedSkuKey: giniSkuKey(combo.proposedSku),
          approvedSku: combo.proposedSku,
          approvedSkuKey: giniSkuKey(combo.proposedSku),
          attributeId: combo.attributeId,
          attributeName: combo.attributeName,
          attributeValue: combo.color,
          approvedAt: new Date(),
          approvalNote: "Administrator approved the proposed SKU. Nothing was sent to GINI.",
          status: "approved",
        },
      },
      { upsert: true }
    );
  }
  clearVariantCatalogCache();
  return { ok: true, code: "approved_for_future_sync", sentToGini: 0, canSend: false };
}

export async function approveParentOwner() {
  return {
    ok: false,
    code: "owner_approval_disabled",
    saved: false,
    sentToGini: 0,
    canSend: false,
    writes: [],
    overwritesOwner: false,
    message: "Owner approval is disabled. The ownership review is read-only and does not save, overwrite, or transfer an owner.",
  };
}

export function variantPreviewPayload(row) {
  return {
    parent: buildVariantParentPreview({
      text: { name: row.name, description: "" },
      sku: row.parentSku,
      price: row.combinations[0]?.price,
      category: { id: row.categoryId },
      subcategory: { id: row.subcategoryId },
      imageUrls: [],
    }),
    variants: buildReusableVariantFields(
      (row.combinations || []).map((combo) => ({
        sku: combo.proposedSku,
        price: combo.price,
        stock: combo.stock,
        attributeId: combo.attributeId,
        value: combo.color,
      }))
    ),
    canSend: false,
  };
}

function parentPath(sku) {
  return `/api/v2.0/third-party/products/${encodeURIComponent(sku)}`;
}

export async function runPreparedVariantStageA({
  sku,
  approved = false,
  writesEnabled = false,
  env = process.env,
  perform,
  operation,
  form = null,
} = {}) {
  const calls = [];
  if (writesEnabled !== true || !giniVariantSyncWritesEnabled(env)) {
    return { ok: false, sent: false, code: "variant_sync_writes_disabled", writeMethods: [], calls };
  }
  if (approved !== true) return { ok: false, sent: false, code: "approval_required", writeMethods: [], calls };
  const prior = operation ? await operation.read() : null;
  if (prior && ["parent_uncertain", "parent_in_progress"].includes(prior.status)) {
    const looked = await perform({ method: "GET", path: parentPath(sku) });
    calls.push("GET");
    if (looked?.status === 200 && giniSkuKey(looked.json?.data?.sku) === giniSkuKey(sku)) {
      await operation.update({ status: "parent_verified", lastCode: "parent_already_exists", giniProductId: String(looked.json.data.id || "") });
      return { ok: true, sent: false, code: "parent_already_exists", writeMethods: [], calls };
    }
    return { ok: false, sent: false, code: "parent_create_uncertain", writeMethods: [], calls };
  }
  const request = async (method, path, extra = {}) => {
    const verb = String(method || "").toUpperCase();
    if (verb !== "GET" && verb !== "POST") throw new Error("method_blocked");
    calls.push(verb);
    return perform({ method: verb, path, ...extra });
  };
  const current = await request("GET", parentPath(sku));
  if (current?.status !== 200 && current?.status !== 404) {
    if (operation) await operation.update({ status: "parent_uncertain", lastCode: "parent_lookup_uncertain" });
    return { ok: false, sent: false, code: "parent_lookup_uncertain", writeMethods: [], calls };
  }
  if (current?.status === 200 && giniSkuKey(current.json?.data?.sku) === giniSkuKey(sku)) {
    if (operation) await operation.update({ status: "parent_verified", lastCode: "parent_already_exists", giniProductId: String(current.json.data.id || "") });
    return { ok: true, sent: false, code: "parent_already_exists", writeMethods: [], calls };
  }
  if (operation) await operation.update({ status: "parent_in_progress", lastCode: "parent_in_progress" });
  let created;
  try {
    created = await request("POST", "/api/v2.0/third-party/products", form ? { form } : {});
  } catch {
    if (operation) await operation.update({ status: "parent_uncertain", lastCode: "parent_create_uncertain" });
    return { ok: false, sent: true, code: "parent_create_uncertain", writeMethods: calls.filter((method) => method !== "GET"), calls };
  }
  if (created?.status !== 200 && created?.status !== 201) {
    if (operation) await operation.update({ status: "parent_uncertain", lastCode: "parent_create_uncertain" });
    return { ok: false, sent: true, code: "parent_create_uncertain", writeMethods: ["POST"], calls };
  }
  const again = await request("GET", parentPath(sku));
  if (again?.status !== 200) {
    if (operation) await operation.update({ status: "parent_uncertain", lastCode: "parent_create_uncertain" });
    return { ok: false, sent: true, code: "parent_create_uncertain", writeMethods: ["POST"], calls };
  }
  if (operation) await operation.update({ status: "parent_verified", lastCode: "parent_verified", giniProductId: String(again.json?.data?.id || "") });
  return { ok: true, sent: true, code: "parent_verified", writeMethods: ["POST"], calls };
}

export async function runPreparedVariantStageB({
  sku,
  approvedRows = [],
  approved = false,
  writesEnabled = false,
  env = process.env,
  perform,
  operation,
  form = null,
} = {}) {
  const calls = [];
  if (writesEnabled !== true || !giniVariantSyncWritesEnabled(env)) {
    return { ok: false, sent: false, code: "variant_sync_writes_disabled", writeMethods: [], calls };
  }
  if (approved !== true) return { ok: false, sent: false, code: "approval_required", writeMethods: [], calls };
  const request = async (method, path, extra = {}) => {
    const verb = String(method || "").toUpperCase();
    if (verb !== "GET" && verb !== "PUT") throw new Error("method_blocked");
    calls.push(verb);
    return perform({ method: verb, path, ...extra });
  };
  const parent = await request("GET", parentPath(sku));
  if (parent?.status !== 200 || giniSkuKey(parent.json?.data?.sku) !== giniSkuKey(sku)) {
    if (operation) await operation.update({ status: "parent_uncertain", lastCode: "parent_missing_before_variants" });
    return { ok: false, sent: false, code: "parent_missing_before_variants", writeMethods: [], calls };
  }
  const listed = await request("GET", `${parentPath(sku)}/variants`);
  const rows = Array.isArray(listed?.json?.data) ? listed.json.data : null;
  if (!rows) {
    if (operation) await operation.update({ status: "variants_uncertain", lastCode: "variants_unread" });
    return { ok: false, sent: false, code: "variants_unread", writeMethods: [], calls };
  }
  const same = rows.length === approvedRows.length && approvedRows.every((expected) => rows.some((row) => giniSkuKey(row.sku) === giniSkuKey(expected.sku) && Number(row.quantity) === Number(expected.stock) && explicitRemoteAttributeId(row) === String(expected.attributeId)));
  if (rows.length && !same) {
    return { ok: false, sent: false, code: "remote_variants_not_replaced", writeMethods: [], calls };
  }
  const prior = operation ? await operation.read() : null;
  if (!same && prior && ["variants_uncertain", "variants_in_progress"].includes(prior.status)) {
    return { ok: false, sent: false, code: "variants_uncertain", writeMethods: [], calls };
  }
  if (same && rows.length) {
    const quantity = Number(parent.json.data.quantity);
    const hidden = parent.json.data.is_visible === 0 || parent.json.data.is_visible === false;
    if (!hidden || quantity !== approvedRows.reduce((sum, row) => sum + Number(row.stock), 0)) {
      return { ok: false, sent: false, code: "parent_quantity_mismatch", writeMethods: [], calls };
    }
    if (operation) await operation.update({ status: "variants_verified", lastCode: "variants_verified", parentQuantity: quantity, parentVisibility: "hidden" });
    return { ok: true, sent: false, code: "variants_verified", writeMethods: [], calls };
  }
  if (Number(parent.json.data.quantity) !== 0 || !(parent.json.data.is_visible === 0 || parent.json.data.is_visible === false)) {
    return { ok: false, sent: false, code: "parent_quantity_mismatch", writeMethods: [], calls };
  }
  if (operation) await operation.update({ status: "variants_in_progress", lastCode: "variants_in_progress" });
  try {
    const saved = await request("PUT", `${parentPath(sku)}/variants`, form ? { form } : {});
    if (saved?.status !== 200 && saved?.status !== 201) throw new Error("upload");
  } catch {
    if (operation) await operation.update({ status: "variants_uncertain", lastCode: "variants_unverified" });
    return { ok: false, sent: true, code: "variants_uncertain", writeMethods: ["PUT"], calls };
  }
  const verified = await request("GET", `${parentPath(sku)}/variants`);
  const verifiedRows = Array.isArray(verified?.json?.data) ? verified.json.data : null;
  const matched = verifiedRows && approvedRows.every((expected) => verifiedRows.some((row) => giniSkuKey(row.sku) === giniSkuKey(expected.sku) && explicitRemoteAttributeId(row) === String(expected.attributeId)));
  if (!matched) {
    if (operation) await operation.update({ status: "variants_uncertain", lastCode: "variants_unverified" });
    return { ok: false, sent: true, code: "variants_uncertain", writeMethods: ["PUT"], calls };
  }
  if (operation) await operation.update({ status: "variants_verified", lastCode: "variants_verified" });
  return { ok: true, sent: true, code: "variants_verified", writeMethods: ["PUT"], calls };
}

export function variantSyncUsesSimpleSendState() {
  return false;
}

export { giniCatalogText };
