import { Commission } from "../models/Commission.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { GiniUnifiedSyncItem } from "../models/GiniUnifiedSyncItem.js";
import { GiniUnifiedSyncJob } from "../models/GiniUnifiedSyncJob.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { Product } from "../models/Product.js";
import { publicMediaUrl } from "../utils/commissionExcel.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility, productScopeIds } from "../utils/platformEligibility.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import { blockerMessage, buildGiniPlanFromParts, giniPayloadHash, mappingFromTree } from "../utils/giniSyncEvaluate.js";
import { GINI_PRODUCTS_PATH, giniCatalogText, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import { loadProtectedVariantSkuKeys } from "../utils/giniVariantGuard.js";
import { classifyVariantProduct } from "../utils/giniVariantCatalog.js";
import { buildReusableVariantFields, buildVariantParentPreview } from "../utils/giniVariantPayload.js";
import { buildSingleVariantStockPatch } from "../utils/giniVariantUpdateContract.js";
import { giniPartialUpdateBody, giniProductUpdatePath } from "../utils/giniProductUpdateContract.js";
import {
  GINI_UNIFIED_LIMITATIONS,
  giniUnifiedSyncWritesEnabled,
  planUnifiedProduct,
  selectSellableFlow,
} from "../utils/giniUnifiedSyncPlan.js";
import { performGiniJsonRequest, performGiniRequest, fetchGiniCategoryTree } from "./giniConnection.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";
import { runPreparedVariantStageA, runPreparedVariantStageB } from "./giniVariantSync.js";

const DONE = new Set(["verified", "unchanged", "blocked", "failed"]);
let activeJobId = "";
let previewRunner = "";
let previewDeps = null;
let previewRun = 0;
let scanGeneration = 0;

export class GiniUnifiedSyncError extends Error {
  constructor(message, { status = 409, code = "gini_unified_sync" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export { giniUnifiedSyncWritesEnabled, GINI_UNIFIED_LIMITATIONS };

function parentPath(sku) {
  return `${GINI_PRODUCTS_PATH}/${encodeURIComponent(normalizeGiniItemCode(sku))}`;
}

async function livePerform(request) {
  const method = String(request?.method || "GET").toUpperCase();
  if (request?.rawBody) return performGiniJsonRequest({ method, path: request.path, rawBody: request.rawBody });
  return performGiniRequest({ method, path: request.path, form: request.form || null });
}

function visibilityOf(value) {
  if (value === 0 || value === false || value === "0" || value === "false") return "hidden";
  if (value === 1 || value === true || value === "1" || value === "true") return "visible";
  return "unverified";
}

function readParent(response, expectedSku) {
  if (!response || response.error) return { state: "uncertain", status: Number(response?.status) || 0, variants: null };
  if (response.status === 404) return { state: "absent", status: 404, variants: null };
  if (response.status !== 200) return { state: "uncertain", status: Number(response.status) || 0, variants: null };
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.sku) {
    return { state: "uncertain", status: 200, variants: null };
  }
  if (giniSkuKey(data.sku) !== giniSkuKey(expectedSku)) {
    return { state: "uncertain", status: 200, sku: String(data.sku), variants: null };
  }
  const price = Number(data.price);
  const quantity = Number(data.quantity);
  return {
    state: "present",
    status: 200,
    id: data.id == null ? "" : String(data.id),
    sku: String(data.sku),
    price: Number.isFinite(price) ? price : null,
    quantity: Number.isFinite(quantity) ? quantity : null,
    visibility: visibilityOf(data.is_visible ?? data.isVisible),
    variants: null,
  };
}

function readVariantRows(response) {
  if (!response || response.error || response.status !== 200) return null;
  const body = response.json;
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!rows) return null;
  return rows.map((row) => ({
    id: row?.id == null ? "" : String(row.id),
    sku: String(row?.sku || ""),
    price: Number(row?.price),
    quantity: Number(row?.quantity ?? row?.stock),
    attributeId: String(row?.attributes?.[0]?.attribute_id || row?.attribute_id || ""),
  }));
}

async function readRemote(perform, sku, withVariants) {
  let parent;
  try {
    parent = readParent(await perform({ method: "GET", path: parentPath(sku) }), sku);
  } catch {
    return { state: "uncertain", status: 0, variants: null };
  }
  if (!withVariants || parent.state !== "present") return parent;
  try {
    const variants = readVariantRows(await perform({ method: "GET", path: `${parentPath(sku)}/variants` }));
    if (!variants) return { ...parent, state: "uncertain", variants: null };
    return { ...parent, variants };
  } catch {
    return { ...parent, state: "uncertain", variants: null };
  }
}

function operationFor(item) {
  return {
    async read() {
      return { status: item.operationStatus || "idle" };
    },
    async update(patch) {
      item.operationStatus = patch.status || item.operationStatus;
      if (patch.status) item.stage = patch.status;
      if (patch.giniProductId) item.giniProductId = String(patch.giniProductId);
      await item.save();
      return { status: item.operationStatus };
    },
  };
}

async function loadContext(deps) {
  const [rules, eligibility, protectedKeys, categories] = await Promise.all([
    deps.rules || Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    deps.eligibility || loadEligibilityContext("gini"),
    deps.protectedKeys || loadProtectedVariantSkuKeys(),
    deps.categories || fetchGiniCategoryTree().then((tree) => tree.categories || []),
  ]);
  const products = deps.products || await Product.find().sort({ _id: 1 }).lean();
  const owners = new Map();
  for (const doc of products) {
    const key = giniSkuKey(doc.itemCode);
    if (!key) continue;
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(String(doc._id));
  }
  const identities = deps.identities || await GiniVariantIdentity.find({}).lean();
  const parentOwners = deps.parentOwners || await GiniVariantParentOwner.find({}).lean();
  return { rules, eligibility, protectedKeys, categories, products, owners, identities, parentOwners };
}

function eligibilityBlockers(resolved, eligibility) {
  const blockers = [];
  if (resolved?.isActive === false) blockers.push("product_inactive");
  for (const reason of eligibility?.reasons || []) {
    if (reason.code && reason.code !== "taxonomy_config_missing") blockers.push(reason.code);
  }
  return blockers;
}

function identitiesFor(context, productId) {
  return context.identities.filter((row) => String(row.productId) === String(productId));
}

function ownerFor(context, sku, productId) {
  return context.parentOwners.find((row) => giniSkuKey(row.parentSku || row.skuKey) === giniSkuKey(sku) && String(row.productId) === String(productId))
    || context.parentOwners.find((row) => giniSkuKey(row.parentSku || row.skuKey) === giniSkuKey(sku))
    || null;
}

function assessOne(doc, context, remote) {
  const selected = selectSellableFlow(doc);
  const resolved = toResolvedProduct(doc);
  const priced = partnerPricePreview(doc, context.rules);
  const skuKey = giniSkuKey(doc.itemCode);
  const duplicateIds = skuKey ? context.owners.get(skuKey) || [] : [];
  const collectionId = productScopeIds(doc).collection || "";
  const mapping = mappingFromTree(taxonomyValuesForProduct(doc, context.eligibility), context.categories);
  const eligibility = evaluatePlatformEligibility(doc, context.eligibility);
  if (selected.flow === "variant") {
    const classified = classifyVariantProduct({
      doc,
      giniPrice: priced?.priceReview ? null : priced?.price,
      mappingOk: !(mapping.blockers || []).length,
      categoryId: mapping.category?.id == null ? "" : String(mapping.category.id),
      subcategoryId: mapping.subcategory?.id == null ? "" : String(mapping.subcategory.id),
      ownerIds: duplicateIds,
      canonicalOwnerId: duplicateIds.length === 1 ? duplicateIds[0] : "",
      identities: identitiesFor(context, doc._id),
      colorContract: context.colorContract || null,
      remoteParent: null,
    });
    const blockers = [...classified.blockers, ...eligibilityBlockers(resolved, eligibility)];
    return planUnifiedProduct({
      doc,
      flow: "variant",
      blockers,
      remote,
      combinations: classified.combinations,
      identities: identitiesFor(context, doc._id),
      owner: ownerFor(context, classified.parentSku, doc._id),
      price: priced?.price ?? null,
      quantity: classified.combinations.reduce((sum, row) => sum + Number(row.stock || 0), 0),
    });
  }
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced,
    duplicateProductIds: duplicateIds,
    mapping,
    existing: null,
    protectedVariantSku: context.protectedKeys.has(skuKey),
  });
  const blockers = (plan.blockers || []).filter((code) => code !== "existing_gini_product");
  if (selected.flow !== "simple") blockers.push(...selected.reasons);
  blockers.push(...eligibilityBlockers(resolved, eligibility));
  return {
    ...planUnifiedProduct({
      doc,
      flow: selected.flow === "simple" ? "simple" : "blocked",
      blockers,
      remote,
      price: plan.giniPrice,
      quantity: plan.quantity,
    }),
    payloadPreview: plan.payloadPreview,
  };
}

async function colorContract(perform, deps) {
  if (deps.colorContract) return deps.colorContract;
  if (deps.skipAttribute === true) return null;
  try {
    const response = await perform({ method: "GET", path: "/api/v2.0/third-party/attributes/3696" });
    const body = response?.json?.data || response?.json;
    const values = Array.isArray(body?.values) ? body.values.map((row) => String(row?.value || row?.name || row || "")) : [];
    if (String(body?.id || "") !== "3696" || !values.length) return null;
    return { attributeId: "3696", name: String(body?.name || "Color"), values };
  } catch {
    return null;
  }
}

function countsOf(items) {
  return {
    create: items.filter((row) => row.action === "CREATE").length,
    update: items.filter((row) => row.action === "UPDATE").length,
    unchanged: items.filter((row) => row.action === "UNCHANGED").length,
    blocked: items.filter((row) => row.action === "BLOCKED").length,
  };
}

function publicJob(job, items = []) {
  return {
    id: String(job._id),
    status: job.status,
    mode: job.mode,
    workflow: "sync_new_and_changed",
    writesEnabled: job.writesEnabled === true,
    productionWritesEnabled: false,
    limitations: GINI_UNIFIED_LIMITATIONS,
    create: job.create,
    update: job.update,
    unchanged: job.unchanged,
    blocked: job.blocked,
    scanned: Number(job.scanned) || 0,
    total: Number(job.total) || 0,
    created: job.created,
    updated: job.updated,
    uncertain: job.uncertain,
    failed: job.failed,
    lastError: job.lastError || "",
    errorCode: job.errorCode || "",
    blockedRows: items.filter((row) => row.action === "BLOCKED").slice(0, 20).map((row) => ({
      sku: row.sku,
      productId: row.productId,
      flow: row.flow,
      reasons: row.reasons,
      messages: row.messages,
    })),
    rows: items.map((row) => ({
      sku: row.sku,
      productId: row.productId,
      flow: row.flow,
      action: row.action,
      stage: row.stage,
      reasons: row.reasons,
      messages: row.messages,
      visibility: row.visibility,
      giniProductId: row.giniProductId,
    })),
  };
}

function previewPayload(job, items, deps) {
  return {
    job: publicJob(job, items),
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniUnifiedSyncWritesEnabled(deps?.env || process.env),
    productionWritesEnabled: false,
    message: job.status === "scanning"
      ? "Preview started. Nothing is created, updated, or published."
      : "Preview only. Nothing was created, updated, or published.",
  };
}

function scanError(err) {
  const errorCode = String(err?.code || "preview_failed").replace(/[^a-z0-9_]/gi, "").slice(0, 80) || "preview_failed";
  const lastError = String(err?.message || "Unified preview failed.").replace(/\s+/g, " ").slice(0, 300);
  return { errorCode, lastError };
}

function itemFromPlan(jobId, plan) {
  return {
    jobId,
    productId: plan.productId,
    sku: plan.sku,
    skuKey: plan.skuKey,
    flow: plan.flow === "variant" || plan.flow === "simple" ? plan.flow : "blocked",
    action: plan.action,
    reasons: plan.reasons,
    messages: plan.messages?.length ? plan.messages : plan.reasons.map(blockerMessage),
    stage: plan.action === "BLOCKED" ? "blocked" : plan.action === "UNCHANGED" ? "unchanged" : "pending",
    fingerprint: plan.fingerprint,
    giniProductId: plan.giniProductId || "",
    visibility: plan.visibility || "",
    price: plan.price,
    quantity: plan.quantity,
    children: plan.children || [],
    retryable: plan.retryable === true,
  };
}

function launchPreview(jobId, deps) {
  const id = String(jobId);
  if (deps) previewDeps = deps;
  if (previewRunner === id) return false;
  if (previewRunner) return false;
  const run = ++previewRun;
  previewRunner = id;
  const generation = scanGeneration;
  const scheduled = (previewDeps && previewDeps.schedule) || ((task) => setImmediate(task));
  scheduled(() => {
    void scanPreview(id, previewDeps || {}, generation).finally(() => {
      if (previewRun === run) previewRunner = "";
    });
  });
  return true;
}

async function scanPreview(jobId, deps, generation) {
  const current = () => generation === scanGeneration;
  try {
    if (!current()) return;
    const perform = deps.perform || livePerform;
    const reading = async (request) => {
      if (String(request?.method || "GET").toUpperCase() !== "GET") {
        throw new GiniUnifiedSyncError("Preview only reads GINI.", { code: "preview_write_blocked" });
      }
      return perform(request);
    };
    const context = await loadContext(deps);
    if (!current()) return;
    context.colorContract = deps.colorContract || await colorContract(reading, deps);
    const products = context.products || [];
    await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "scanning" }, { $set: { total: products.length } });
    const saved = new Set((await GiniUnifiedSyncItem.find({ jobId }).select("productId action").lean()).map((row) => row.productId));
    if (saved.size) {
      const existing = await GiniUnifiedSyncItem.find({ jobId }).select("action").lean();
      await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "scanning" }, {
        $set: { ...countsOf(existing), scanned: existing.length },
      });
    }
    for (const doc of products) {
      if (!current()) return;
      const state = await GiniUnifiedSyncJob.findById(jobId).select("status").lean();
      if (state?.status !== "scanning") return;
      const productId = String(doc._id);
      if (saved.has(productId)) continue;
      const flow = selectSellableFlow(doc);
      const remote = await readRemote(reading, normalizeGiniItemCode(doc.itemCode), flow.flow === "variant");
      const plan = assessOne(doc, context, remote);
      try {
        await GiniUnifiedSyncItem.create(itemFromPlan(jobId, plan));
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
      saved.add(productId);
      const counts = countsOf(await GiniUnifiedSyncItem.find({ jobId }).select("action").lean());
      await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "scanning" }, {
        $set: { ...counts, scanned: saved.size, cursorProductId: productId },
      });
      if (deps.afterProduct) await deps.afterProduct({ productId, scanned: saved.size });
    }
    if (!current()) return;
    const items = await GiniUnifiedSyncItem.find({ jobId }).select("action").lean();
    await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "scanning" }, {
      $set: { status: "preview", ...countsOf(items), scanned: items.length, total: products.length, lastError: "", errorCode: "" },
    });
  } catch (err) {
    if (!current()) return;
    const failure = scanError(err);
    await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "scanning" }, {
      $set: { status: "failed", ...failure },
    });
  }
}

export async function getGiniUnifiedSyncStatus(deps) {
  const scanning = await GiniUnifiedSyncJob.findOne({ partner: "gini", mode: "preview", status: "scanning" }).sort({ createdAt: -1 });
  if (scanning) launchPreview(scanning._id, deps);
  const selected = scanning || await GiniUnifiedSyncJob.findOne({ partner: "gini" }).sort({ createdAt: -1 });
  if (!selected) {
    return { job: null, writesEnabled: giniUnifiedSyncWritesEnabled(), productionWritesEnabled: false, limitations: GINI_UNIFIED_LIMITATIONS };
  }
  const job = await GiniUnifiedSyncJob.findById(selected._id);
  const items = await GiniUnifiedSyncItem.find({ jobId: job._id }).sort({ sku: 1 }).lean();
  return {
    job: publicJob(job, items),
    dryRun: job.mode !== "sync",
    sentToGini: job.mode === "preview" ? 0 : Number(job.created || 0) + Number(job.updated || 0),
    writesEnabled: giniUnifiedSyncWritesEnabled(),
    productionWritesEnabled: false,
    limitations: GINI_UNIFIED_LIMITATIONS,
  };
}

export async function previewGiniUnifiedSync(deps = {}) {
  const active = await GiniUnifiedSyncJob.findOne({ partner: "gini", mode: "preview", status: "scanning" }).sort({ createdAt: -1 });
  if (active) {
    launchPreview(active._id, deps);
    const job = await GiniUnifiedSyncJob.findById(active._id);
    const items = await GiniUnifiedSyncItem.find({ jobId: active._id }).sort({ sku: 1 }).lean();
    return previewPayload(job, items, deps);
  }
  const total = Array.isArray(deps.products) ? deps.products.length : await Product.countDocuments();
  const job = await GiniUnifiedSyncJob.create({
    partner: "gini",
    status: "scanning",
    mode: "preview",
    total,
    scanned: 0,
    writesEnabled: false,
    productionWritesEnabled: false,
    limitations: [...GINI_UNIFIED_LIMITATIONS],
  });
  launchPreview(job._id, deps);
  return previewPayload(job, [], deps);
}

async function stillRunning(jobId) {
  const job = await GiniUnifiedSyncJob.findById(jobId).select("status").lean();
  return job?.status === "running";
}

async function imageFiles(images, deps) {
  const urls = (images || []).map((image) => (typeof image === "string" ? image : image?.url)).filter(Boolean);
  if (!urls.length) return [];
  if (deps.loadImages) return deps.loadImages(urls);
  const files = [];
  for (let index = 0; index < urls.length; index += 1) files.push(await downloadGiniProductImage(urls[index], index));
  return files;
}

async function rememberSimple(item, payload) {
  const hash = payload ? giniPayloadHash(payload) : item.fingerprint || "";
  await GiniSyncSendState.updateOne(
    { partner: "gini", productId: item.productId },
    {
      $set: {
        sku: item.sku,
        skuKey: item.skuKey,
        giniProductId: item.giniProductId,
        originalGiniProductId: item.giniProductId,
        payloadHash: hash,
        createPayloadHash: hash,
        jobId: String(item.jobId),
        confirmedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function rememberVariant(doc, item, remote) {
  await GiniVariantParentOwner.updateOne(
    { skuKey: item.skuKey },
    {
      $set: {
        parentSku: item.sku,
        productId: item.productId,
        vendorId: String(doc?.createdBy?._id || ""),
        giniProductId: item.giniProductId || remote.id || "",
        parentQuantity: remote.quantity,
        visibility: remote.visibility,
        verifiedAt: new Date(),
        status: "verified_remote",
        approvalNote: "Recorded after a GET confirmed this parent. Visibility was not changed.",
      },
    },
    { upsert: true }
  );
  for (const child of item.children || []) {
    const combo = (doc.variants || []).flatMap((variant) => (variant.sizes || []).map((size) => ({ variant, size }))).find((row) => {
      const color = row.variant?.color?.en || row.variant?.color;
      return giniSkuKey(`${item.sku}-${color}`) === giniSkuKey(child.sku) || giniSkuKey(child.sku).endsWith(giniSkuKey(color));
    });
    if (!combo) continue;
    await GiniVariantIdentity.updateOne(
      { productId: item.productId, sourceVariantId: String(combo.variant._id), sourceSizeId: String(combo.size._id || "") },
      {
        $set: {
          parentSku: item.sku,
          parentSkuKey: item.skuKey,
          proposedSku: child.sku,
          proposedSkuKey: giniSkuKey(child.sku),
          approvedSku: child.sku,
          approvedSkuKey: giniSkuKey(child.sku),
          confirmedGiniVariantId: String(child.variantId || ""),
          status: "verified",
          lastVerifiedPrice: child.price,
          lastVerifiedQuantity: child.quantity,
          lastVerifiedAt: new Date(),
          approvalNote: "Confirmed by a GET of the approved child SKU.",
        },
      },
      { upsert: true }
    );
  }
}

function intendedSimple(remote, item, { hidden = false } = {}) {
  const matched = remote?.state === "present"
    && giniSkuKey(remote.sku) === item.skuKey
    && Number(remote.price) === Number(item.price)
    && Number(remote.quantity) === Number(item.quantity);
  if (!matched) return false;
  if (hidden && remote.visibility !== "hidden") return false;
  return true;
}

function hiddenCreatePayload(payload) {
  return { ...(payload || {}), is_visible: 0 };
}

async function runSimpleCreate(item, plan, perform) {
  if (item.stage === "write_uncertain" || item.stage === "write_in_progress") {
    const remote = await readRemote(perform, item.sku, false);
    if (remote.state === "uncertain") return item;
    if (intendedSimple(remote, item, { hidden: true })) {
      item.stage = "verified";
      item.giniProductId = remote.id || item.giniProductId;
      item.action = "CREATE";
      await item.save();
      await rememberSimple(item, plan.payloadPreview);
      return item;
    }
    if (remote.state === "present") {
      item.stage = "blocked";
      item.action = "BLOCKED";
      item.reasons = ["existing_gini_product"];
      item.errorCode = "existing_gini_product";
      await item.save();
      return item;
    }
    item.stage = "pending";
  }
  const current = await readRemote(perform, item.sku, false);
  if (current.state === "present") {
    item.stage = "blocked";
    item.action = "BLOCKED";
    item.reasons = ["existing_gini_product"];
    item.errorCode = "existing_gini_product";
    await item.save();
    return item;
  }
  if (current.state !== "absent") {
    item.stage = "lookup_uncertain";
    item.retryable = true;
    item.reasons = ["lookup_uncertain"];
    await item.save();
    return item;
  }
  const hiddenPayload = hiddenCreatePayload(plan.payloadPreview);
  let files = [];
  try {
    files = await imageFiles(hiddenPayload?.images || [], { loadImages: perform.loadImages });
  } catch {
    item.stage = "failed";
    item.errorCode = "invalid_image";
    item.reasons = ["invalid_image"];
    item.messages = [blockerMessage("invalid_image")];
    await item.save();
    return item;
  }
  item.stage = "write_in_progress";
  await item.save();
  let response;
  try {
    response = await perform({ method: "POST", path: GINI_PRODUCTS_PATH, form: buildGiniCreateForm(hiddenPayload, files) });
  } catch {
    item.stage = "write_uncertain";
    item.retryable = true;
    item.errorCode = "create_uncertain";
    await item.save();
    return item;
  }
  const confirmed = await readRemote(perform, item.sku, false);
  if ((response?.status === 200 || response?.status === 201) && intendedSimple(confirmed, item, { hidden: true })) {
    item.stage = "verified";
    item.visibility = "hidden";
    item.giniProductId = confirmed.id || "";
    item.httpStatus = response.status;
    await item.save();
    await rememberSimple(item, hiddenPayload);
    return item;
  }
  item.stage = "write_uncertain";
  item.retryable = true;
  item.httpStatus = Number(response?.status) || 0;
  item.errorCode = "create_uncertain";
  await item.save();
  return item;
}

async function runSimpleUpdate(item, perform) {
  const remote = await readRemote(perform, item.sku, false);
  if (remote.state !== "present") {
    item.stage = remote.state === "absent" ? "blocked" : "write_uncertain";
    item.reasons = remote.state === "absent" ? ["lookup_uncertain"] : ["lookup_uncertain"];
    item.retryable = remote.state !== "absent";
    await item.save();
    return item;
  }
  if (item.visibility && remote.visibility !== item.visibility) {
    item.stage = "blocked";
    item.action = "BLOCKED";
    item.reasons = ["visibility_changed"];
    await item.save();
    return item;
  }
  if (intendedSimple(remote, item)) {
    item.stage = "verified";
    item.giniProductId = remote.id || item.giniProductId;
    await item.save();
    return item;
  }
  const changes = [];
  if (Number(remote.price) !== Number(item.price)) changes.push({ field: "price", old: remote.price, new: item.price });
  if (Number(remote.quantity) !== Number(item.quantity)) changes.push({ field: "quantity", old: remote.quantity, new: item.quantity });
  const rawBody = giniPartialUpdateBody(changes);
  if (rawBody.includes("is_visible")) throw new GiniUnifiedSyncError("Visibility is not part of this update.", { code: "visibility_write_blocked" });
  item.stage = "write_in_progress";
  await item.save();
  let response;
  try {
    response = await perform({ method: "PUT", path: giniProductUpdatePath(item.sku), rawBody });
  } catch {
    item.stage = "write_uncertain";
    item.retryable = true;
    item.errorCode = "update_uncertain";
    await item.save();
    return item;
  }
  const confirmed = await readRemote(perform, item.sku, false);
  if (response?.status === 200 && intendedSimple(confirmed, item) && confirmed.visibility === remote.visibility) {
    item.stage = "verified";
    item.visibility = confirmed.visibility;
    item.giniProductId = confirmed.id || item.giniProductId;
    item.httpStatus = 200;
    await item.save();
    await rememberSimple(item, null);
    return item;
  }
  item.stage = "write_uncertain";
  item.retryable = true;
  item.errorCode = "update_uncertain";
  await item.save();
  return item;
}

async function variantForm(combinations, files) {
  const preview = buildReusableVariantFields(combinations.map((row) => ({
    sku: row.proposedSku,
    price: row.price,
    stock: row.stock,
    attributeId: row.attributeId,
    value: row.color,
  })));
  const form = new FormData();
  let fileIndex = 0;
  for (const field of preview.fields) {
    if (field.type === "file") {
      const file = files[fileIndex];
      fileIndex += 1;
      form.append(field.key, file.blob, file.filename || `${rowName(field)}.webp`);
    } else form.append(field.key, field.value);
  }
  return form;
}

function rowName(field) {
  return String(field.color || "variant").toLowerCase();
}

async function runVariantCreate(item, doc, plan, perform, env) {
  const operation = operationFor(item);
  if (["parent_uncertain", "parent_in_progress", "variants_uncertain", "variants_in_progress"].includes(item.stage)) {
    const remote = await readRemote(perform, item.sku, true);
    if (remote.state === "uncertain") return item;
    const hiddenParent = remote.state === "present" && remote.visibility === "hidden" && Number(remote.quantity) === 0;
    const variantsReady = hiddenParent && (remote.variants || []).length === 0;
    const matched = remote.state === "present" && (item.children || []).every((child) => (remote.variants || []).some((row) => giniSkuKey(row.sku) === giniSkuKey(child.sku) && Number(row.price) === Number(child.price) && Number(row.quantity) === Number(child.quantity)));
    if (matched && remote.visibility === "hidden") {
      item.stage = "verified";
      item.giniProductId = remote.id || item.giniProductId;
      item.children = (item.children || []).map((child) => ({
        ...child,
        variantId: (remote.variants || []).find((row) => giniSkuKey(row.sku) === giniSkuKey(child.sku))?.id || child.variantId,
      }));
      await item.save();
      await rememberVariant(doc, item, remote);
      return item;
    }
    if (remote.state === "present" && !hiddenParent && !matched) {
      item.stage = "blocked";
      item.action = "BLOCKED";
      item.reasons = ["parent_not_hidden"];
      await item.save();
      return item;
    }
    if ((remote.variants || []).length && !matched) {
      item.stage = "variants_uncertain";
      item.reasons = ["variants_partial"];
      item.retryable = false;
      await item.save();
      return item;
    }
    if (variantsReady) item.stage = "parent_verified";
    else if (remote.state === "absent") item.operationStatus = "idle";
    await item.save();
  }
  const combinations = plan.combinations || [];
  let files = [];
  try {
    files = await imageFiles(combinations.map((row) => row.imageUrl).filter(Boolean), { loadImages: perform.loadImages });
  } catch {
    item.stage = "failed";
    item.errorCode = "invalid_image";
    item.reasons = ["invalid_image"];
    item.messages = [blockerMessage("invalid_image")];
    await item.save();
    return item;
  }
  if (item.stage !== "parent_verified" && item.stage !== "variants_verified") {
    const text = giniCatalogText(doc);
    const parentPayload = buildVariantParentPreview({
      text,
      sku: item.sku,
      price: combinations[0]?.price,
      category: { id: plan.categoryId },
      subcategory: { id: plan.subcategoryId },
      imageUrls: combinations.map((row) => row.imageUrl).filter(Boolean),
    });
    const form = buildGiniCreateForm(parentPayload, files);
    const created = await runPreparedVariantStageA({
      sku: item.sku,
      approved: true,
      writesEnabled: true,
      env,
      perform,
      operation,
      form,
    });
    if (!created.ok) {
      item.errorCode = created.code || "parent_create_uncertain";
      item.stage = item.operationStatus || "parent_uncertain";
      item.retryable = true;
      await item.save();
      return item;
    }
    item.stage = "parent_verified";
    await item.save();
  }
  const form = await variantForm(combinations, files);
  const saved = await runPreparedVariantStageB({
    sku: item.sku,
    approvedRows: combinations.map((row) => ({ sku: row.proposedSku, stock: row.stock, attributeId: row.attributeId })),
    approved: true,
    writesEnabled: true,
    env,
    perform,
    operation,
    form,
  });
  if (!saved.ok) {
    item.errorCode = saved.code || "variants_uncertain";
    item.stage = item.operationStatus || "variants_uncertain";
    item.retryable = saved.code !== "remote_variants_not_replaced";
    await item.save();
    return item;
  }
  const remote = await readRemote(perform, item.sku, true);
  const matched = remote.state === "present"
    && remote.visibility === "hidden"
    && combinations.every((row) => (remote.variants || []).some((child) => giniSkuKey(child.sku) === giniSkuKey(row.proposedSku) && Number(child.price) === Number(row.price) && Number(child.quantity) === Number(row.stock)));
  if (!matched) {
    item.stage = "variants_uncertain";
    item.retryable = true;
    item.errorCode = "variants_unverified";
    await item.save();
    return item;
  }
  item.stage = "verified";
  item.giniProductId = remote.id || item.giniProductId;
  item.visibility = "hidden";
  item.children = combinations.map((row) => {
    const found = (remote.variants || []).find((child) => giniSkuKey(child.sku) === giniSkuKey(row.proposedSku));
    return { sku: row.proposedSku, variantId: found?.id || "", price: row.price, quantity: row.stock, changed: false };
  });
  await item.save();
  await rememberVariant(doc, item, remote);
  return item;
}

async function runVariantUpdate(item, doc, perform) {
  const remote = await readRemote(perform, item.sku, true);
  if (remote.state !== "present") {
    item.stage = "write_uncertain";
    item.retryable = true;
    item.reasons = ["lookup_uncertain"];
    await item.save();
    return item;
  }
  if (item.visibility && remote.visibility !== item.visibility) {
    item.stage = "blocked";
    item.action = "BLOCKED";
    item.reasons = ["visibility_changed"];
    await item.save();
    return item;
  }
  const pending = (item.children || []).filter((child) => {
    const row = (remote.variants || []).find((candidate) => giniSkuKey(candidate.sku) === giniSkuKey(child.sku));
    return row && (Number(row.price) !== Number(child.price) || Number(row.quantity) !== Number(child.quantity));
  });
  if (!pending.length) {
    item.stage = "verified";
    item.giniProductId = remote.id || item.giniProductId;
    await item.save();
    await rememberVariant(doc, item, remote);
    return item;
  }
  item.stage = "write_in_progress";
  await item.save();
  for (const child of pending) {
    const row = (remote.variants || []).find((candidate) => giniSkuKey(candidate.sku) === giniSkuKey(child.sku));
    const patch = buildSingleVariantStockPatch({
      parentSku: item.sku,
      variantId: row?.id || child.variantId,
      price: Number(row?.price) === Number(child.price) ? null : child.price,
      quantity: Number(row?.quantity) === Number(child.quantity) ? null : child.quantity,
    });
    if (!patch.ok || patch.rawBody.includes("is_visible")) {
      item.stage = "blocked";
      item.action = "BLOCKED";
      item.reasons = [patch.code || "visibility_write_blocked"];
      await item.save();
      return item;
    }
    try {
      const response = await perform({ method: "PATCH", path: patch.path, rawBody: patch.rawBody });
      if (response?.status !== 200 && response?.status !== 201) throw new Error("patch");
    } catch {
      item.stage = "write_uncertain";
      item.retryable = true;
      item.errorCode = "update_uncertain";
      await item.save();
      return item;
    }
  }
  const confirmed = await readRemote(perform, item.sku, true);
  const done = confirmed.state === "present"
    && confirmed.visibility === remote.visibility
    && (item.children || []).every((child) => (confirmed.variants || []).some((row) => giniSkuKey(row.sku) === giniSkuKey(child.sku) && Number(row.price) === Number(child.price) && Number(row.quantity) === Number(child.quantity)));
  if (!done) {
    item.stage = "write_uncertain";
    item.retryable = true;
    item.errorCode = "update_uncertain";
    await item.save();
    return item;
  }
  item.stage = "verified";
  item.visibility = confirmed.visibility;
  item.giniProductId = confirmed.id || item.giniProductId;
  await item.save();
  await rememberVariant(doc, item, confirmed);
  return item;
}

async function runJob(jobId, deps) {
  const env = deps.env || process.env;
  const perform = Object.assign(deps.perform || livePerform, { loadImages: deps.loadImages });
  const context = await loadContext(deps);
  context.colorContract = deps.colorContract || await colorContract(perform, deps);
  const items = await GiniUnifiedSyncItem.find({ jobId }).sort({ productId: 1 });
  for (const item of items) {
    if (!(await stillRunning(jobId))) return;
    if (DONE.has(item.stage)) continue;
    const doc = context.products.find((row) => String(row._id) === item.productId) || await Product.findById(item.productId).lean();
    if (!doc) {
      item.stage = "failed";
      item.errorCode = "product_not_found";
      await item.save();
      continue;
    }
    const flow = selectSellableFlow(doc);
    const remote = await readRemote(perform, item.sku, flow.flow === "variant");
    const plan = assessOne(doc, context, remote);
    if (item.fingerprint && plan.fingerprint !== item.fingerprint && !["write_uncertain", "write_in_progress", "parent_uncertain", "parent_in_progress", "variants_uncertain", "variants_in_progress"].includes(item.stage)) {
      item.stage = "blocked";
      item.action = "BLOCKED";
      item.reasons = ["preview_drift"];
      item.errorCode = "preview_drift";
      await item.save();
      continue;
    }
    item.cursor = item.productId;
    await GiniUnifiedSyncJob.updateOne({ _id: jobId }, { $set: { cursorProductId: item.productId } });
    if (item.flow === "simple" && item.action === "CREATE") await runSimpleCreate(item, plan, perform);
    else if (item.flow === "simple" && item.action === "UPDATE") await runSimpleUpdate(item, perform);
    else if (item.flow === "variant" && item.action === "CREATE") {
      plan.combinations = classifyVariantProduct({
        doc,
        giniPrice: plan.price,
        mappingOk: true,
        categoryId: plan.categoryId,
        subcategoryId: plan.subcategoryId,
        ownerIds: [item.productId],
        canonicalOwnerId: item.productId,
        identities: identitiesFor(context, item.productId),
        colorContract: context.colorContract,
      }).combinations;
      const mapping = mappingFromTree(taxonomyValuesForProduct(doc, context.eligibility), context.categories);
      plan.categoryId = mapping.category?.id;
      plan.subcategoryId = mapping.subcategory?.id;
      plan.combinations = plan.combinations.map((row) => ({
        ...row,
        imageUrl: publicMediaUrl((doc.variants || []).find((variant) => String(variant._id) === String(row.sourceVariantId))?.images?.find((image) => image?.url)?.url || ""),
      }));
      await runVariantCreate(item, doc, plan, perform, env);
    } else if (item.flow === "variant" && item.action === "UPDATE") await runVariantUpdate(item, doc, perform);
    if (deps.afterItem) await deps.afterItem(item);
  }
  if (await stillRunning(jobId)) {
    const fresh = await GiniUnifiedSyncItem.find({ jobId }).lean();
    await GiniUnifiedSyncJob.updateOne({ _id: jobId, status: "running" }, {
      $set: {
        status: "completed",
        created: fresh.filter((row) => row.action === "CREATE" && row.stage === "verified").length,
        updated: fresh.filter((row) => row.action === "UPDATE" && row.stage === "verified").length,
        uncertain: fresh.filter((row) => String(row.stage).includes("uncertain")).length,
        failed: fresh.filter((row) => row.stage === "failed" || (row.action === "BLOCKED" && row.stage === "blocked" && row.errorCode)).length,
      },
    });
  }
}

async function openSync(previewJobId, deps) {
  if (!giniUnifiedSyncWritesEnabled(deps.env || process.env)) {
    throw new GiniUnifiedSyncError("GINI unified sync writes are disabled. Production writes stay off.", { code: "unified_writes_disabled" });
  }
  if (activeJobId) throw new GiniUnifiedSyncError("A GINI sync job is already running.", { code: "job_running" });
  const preview = await GiniUnifiedSyncJob.findById(previewJobId);
  if (!preview || preview.mode !== "preview" || preview.status !== "preview") {
    throw new GiniUnifiedSyncError("Finish the Sync New & Changed preview first.", { code: "preview_required" });
  }
  const source = await GiniUnifiedSyncItem.find({ jobId: preview._id }).lean();
  const job = await GiniUnifiedSyncJob.create({
    partner: "gini",
    status: "running",
    mode: "sync",
    previewJobId: String(preview._id),
    create: preview.create,
    update: preview.update,
    unchanged: preview.unchanged,
    blocked: preview.blocked,
    writesEnabled: true,
    productionWritesEnabled: false,
    limitations: [...GINI_UNIFIED_LIMITATIONS],
  });
  if (source.length) {
    await GiniUnifiedSyncItem.insertMany(source.map((row) => ({
      jobId: job._id,
      productId: row.productId,
      sku: row.sku,
      skuKey: row.skuKey,
      flow: row.flow,
      action: row.action,
      reasons: row.reasons,
      messages: row.messages,
      stage: row.stage,
      operationStatus: "idle",
      fingerprint: row.fingerprint,
      giniProductId: row.giniProductId,
      visibility: row.visibility,
      price: row.price,
      quantity: row.quantity,
      children: row.children,
      retryable: row.retryable,
    })));
  }
  return job;
}

export async function startGiniUnifiedSync({ confirm = false, previewJobId } = {}, deps = {}) {
  if (confirm !== true) throw new GiniUnifiedSyncError("Confirm the sync after the preview.", { status: 400, code: "confirm_required" });
  const job = await openSync(previewJobId, deps);
  activeJobId = String(job._id);
  try {
    await runJob(job._id, deps);
  } finally {
    if (activeJobId === String(job._id)) activeJobId = "";
  }
  const fresh = await GiniUnifiedSyncJob.findById(job._id);
  const items = await GiniUnifiedSyncItem.find({ jobId: job._id }).lean();
  return {
    job: publicJob(fresh, items),
    sentToGini: items.filter((row) => row.stage === "verified" && (row.action === "CREATE" || row.action === "UPDATE")).length,
    writesEnabled: giniUnifiedSyncWritesEnabled(deps.env || process.env),
    productionWritesEnabled: false,
  };
}

export async function resumeGiniUnifiedSync({ jobId } = {}, deps = {}) {
  if (!giniUnifiedSyncWritesEnabled(deps.env || process.env)) {
    throw new GiniUnifiedSyncError("GINI unified sync writes are disabled. Production writes stay off.", { code: "unified_writes_disabled" });
  }
  const job = await GiniUnifiedSyncJob.findById(jobId);
  if (!job || job.mode !== "sync" || !["paused", "stopped", "running", "failed", "completed"].includes(job.status)) {
    throw new GiniUnifiedSyncError("There is no paused sync job to resume.", { code: "job_required" });
  }
  if (activeJobId) throw new GiniUnifiedSyncError("A GINI sync job is already running.", { code: "job_running" });
  job.status = "running";
  await job.save();
  activeJobId = String(job._id);
  try {
    await runJob(job._id, deps);
  } finally {
    if (activeJobId === String(job._id)) activeJobId = "";
  }
  const fresh = await GiniUnifiedSyncJob.findById(job._id);
  const items = await GiniUnifiedSyncItem.find({ jobId: job._id }).lean();
  return { job: publicJob(fresh, items), sentToGini: items.filter((row) => row.stage === "verified" && (row.action === "CREATE" || row.action === "UPDATE")).length, productionWritesEnabled: false };
}

export async function pauseGiniUnifiedSync() {
  const job = await GiniUnifiedSyncJob.findOne({ partner: "gini", mode: "sync", status: "running" }).sort({ createdAt: -1 });
  if (!job) throw new GiniUnifiedSyncError("There is no running sync job.", { code: "job_required" });
  job.status = "paused";
  await job.save();
  return { job: publicJob(job, []), productionWritesEnabled: false };
}

export function resetGiniUnifiedSyncForTests() {
  activeJobId = "";
  scanGeneration += 1;
  previewRun += 1;
  previewRunner = "";
  previewDeps = null;
}

/** Drops the in-memory scanner the way an API restart does. The saved job stays scanning. */
export function abandonGiniUnifiedPreviewForTests() {
  scanGeneration += 1;
  previewRun += 1;
  previewRunner = "";
  previewDeps = null;
}
