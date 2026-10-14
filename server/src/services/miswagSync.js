import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { PlatformCategoryMapping } from "../models/PlatformCategoryMapping.js";
import { PlatformProduct } from "../models/PlatformProduct.js";
import { PlatformProductSync } from "../models/PlatformProductSync.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { normalizeBrandName, resolveMiswagBrands } from "./miswagBrands.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  MiswagError,
  MISWAG_PARTNER,
  createOrUpdateItem,
  getItem,
  getItemVariation,
  getJob,
  listItemVariations,
  publishItems,
  updatePrice,
  updateSizeStock,
} from "./miswag.js";
import { ensureMiswagVariationBarcode, loadAssignedBarcodes } from "./miswagBarcodes.js";
import {
  buildMiswagPayload,
  fingerprintPayload,
  mediaPublicOrigin,
  miswagItemExternalId,
  planDelta,
  publishContentIssues,
} from "./miswagProduct.js";

const BATCH_SIZE = 15;
const CONCURRENCY = 2;
const PUBLISH_LIMIT = 50;
const PUBLISH_OK = new Set(["pending", "under_review", "already_published"]);

function emptyProgress() {
  return {
    attempted: 0,
    created: 0,
    updated: 0,
    processing: 0,
    failed: 0,
    skippedUnmapped: 0,
    skippedInvalid: 0,
    skippedUnchanged: 0,
    aborted: "",
  };
}

function collectionIdOf(doc) {
  const value = doc?.collectionName;
  if (!value || typeof value !== "object") return "";
  return String(value._id || value.id || "").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bump(progress, outcome) {
  progress.attempted += 1;
  if (outcome === "created") progress.created += 1;
  else if (outcome === "updated") progress.updated += 1;
  else if (outcome === "processing") progress.processing += 1;
  else if (outcome === "failed") progress.failed += 1;
  else if (outcome === "skippedUnmapped") progress.skippedUnmapped += 1;
  else if (outcome === "skippedInvalid") progress.skippedInvalid += 1;
  else if (outcome === "unchanged") progress.skippedUnchanged += 1;
}

async function mapPool(items, limit, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  }
  const workers = Math.min(limit, items.length);
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => run()));
}

async function loadRules() {
  return Commission.find({ partner: MISWAG_PARTNER, isActive: { $ne: false } }).lean();
}

async function loadBatchContext(docs, rules) {
  const ids = docs.map((doc) => doc._id);
  const collectionIds = [...new Set(docs.map(collectionIdOf).filter(Boolean))];
  const [overrides, mappings, syncs, brandMatches, assignedBarcodes] = await Promise.all([
    PlatformProduct.find({ partner: MISWAG_PARTNER, product: { $in: ids } }).lean(),
    PlatformCategoryMapping.find({
      partner: MISWAG_PARTNER,
      brownCollectionId: { $in: collectionIds },
    }).lean(),
    PlatformProductSync.find({ partner: MISWAG_PARTNER, product: { $in: ids } }).lean(),
    resolveMiswagBrands(docs.map((doc) => doc?.brand)),
    loadAssignedBarcodes(docs),
  ]);
  return {
    rules,
    origin: mediaPublicOrigin(),
    overrides: new Map(overrides.map((doc) => [String(doc.product), doc.overrides || {}])),
    mappings: new Map(mappings.map((doc) => [doc.brownCollectionId, doc])),
    syncs: new Map(syncs.map((doc) => [String(doc.product), doc])),
    brandMatches,
    assignedBarcodes,
  };
}

function brandNameOf(doc) {
  const brand = doc?.brand;
  if (!brand) return "";
  if (typeof brand.name === "string") return brand.name;
  return brand.name?.en || brand.name?.ar || brand.name?.ku || "";
}

function variationRows(data) {
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.variations)) return data.variations;
  return [];
}

async function loadPreservedBarcodes(externalIds) {
  const found = new Map();
  await mapPool([...new Set(externalIds.filter(Boolean))], CONCURRENCY, async (externalId) => {
    try {
      const response = await listItemVariations(externalId);
      const barcodes = new Map();
      for (const row of variationRows(response.data)) {
        const id = String(row?.id || row?.external_id || "").trim();
        const barcode = String(row?.barcode || "").trim();
        if (id && barcode) barcodes.set(id, barcode);
      }
      found.set(externalId, barcodes);
    } catch (err) {
      if (err.status === 404) found.set(externalId, new Map());
      else found.set(externalId, err instanceof Error ? err : new Error("Miswag barcode lookup failed."));
    }
  });
  return found;
}

async function attachPreservedBarcodes(docs, context, always) {
  const ids = docs.map((doc) => {
    const sync = context.syncs.get(String(doc._id));
    if (always || sync?.externalId) return miswagItemExternalId(doc);
    return "";
  }).filter(Boolean);
  context.preservedBarcodes = await loadPreservedBarcodes(ids);
}

function builtFor(doc, context) {
  const key = normalizeBrandName(brandNameOf(doc));
  const externalId = miswagItemExternalId(doc);
  const preserved = context.preservedBarcodes?.get(externalId);
  const lookupFailed = preserved instanceof Error;
  const built = buildMiswagPayload(doc, {
    rules: context.rules,
    platformOverrides: context.overrides.get(String(doc._id)) || null,
    mapping: context.mappings.get(collectionIdOf(doc)) || null,
    brandMatch: context.brandMatches?.get(key) || null,
    origin: context.origin,
    preservedBarcodes: preserved instanceof Map ? preserved : null,
    assignedBarcodes: context.assignedBarcodes || null,
    clearSizeBarcodes: preserved instanceof Map && preserved.size > 0,
  });
  if (lookupFailed) {
    built.errors = [...new Set([...built.errors, "miswag_barcode_lookup_failed"])];
    built.ok = false;
  }
  return built;
}

async function saveSync(productId, fields) {
  return PlatformProductSync.findOneAndUpdate(
    { partner: MISWAG_PARTNER, product: productId },
    {
      $set: fields,
      $setOnInsert: { partner: MISWAG_PARTNER, product: productId },
    },
    { upsert: true, new: true }
  ).lean();
}

function skipOutcome(errors) {
  if (errors.includes("unmapped_collection") || errors.includes("needs_review")) return "skippedUnmapped";
  return "skippedInvalid";
}

async function pushStock(payload) {
  for (const variation of payload.variations || []) {
    for (const size of variation.sizes || []) {
      await updateSizeStock(payload.external_id, variation.external_id, size.external_id, size.quantity);
    }
  }
}

async function applyRemote(doc, built, sync, action) {
  const hash = fingerprintPayload(built.payload);
  const now = new Date();
  if (action === "unchanged") return { outcome: "unchanged" };
  if ((action === "price" || action === "stock" || action === "price_and_stock") && !sync?.lastSuccessfulSyncAt) {
    const err = new MiswagError("Create the Miswag product before sending a price or stock update.", { status: 409 });
    throw err;
  }

  await saveSync(doc._id, {
    status: "processing",
    externalId: built.externalId,
    lastError: "",
    lastSyncedAt: now,
  });

  try {
    if (action === "price" || action === "price_and_stock") {
      await updatePrice(built.externalId, built.payload.price);
    }
    if (action === "stock" || action === "price_and_stock") {
      await pushStock(built.payload);
    }
    if (action === "full") {
      const response = await createOrUpdateItem(built.payload);
      if (response.status === 202) {
        await saveSync(doc._id, {
          status: "processing",
          externalId: built.externalId,
          payloadHash: hash,
          asyncJobId: response.data?.job_id || "",
          asyncJobStatus: response.data?.status || "pending",
          lastSyncedAt: new Date(),
          lastError: "",
        });
        return { outcome: "processing", response };
      }
      await saveSync(doc._id, {
        status: "synced",
        externalId: built.externalId,
        externalProductId: String(response.data?.item_id || response.data?.id || sync?.externalProductId || ""),
        payloadHash: hash,
        asyncJobId: "",
        asyncJobStatus: "",
        lastSyncedAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        lastSyncedPrice: built.platformPrice,
        priceSyncError: "",
        lastError: "",
      });
      return { outcome: response.status === 201 ? "created" : "updated", response };
    }

    await saveSync(doc._id, {
      status: "synced",
      externalId: built.externalId,
      payloadHash: hash,
      lastSyncedAt: new Date(),
      lastSuccessfulSyncAt: sync?.lastSuccessfulSyncAt || new Date(),
      ...((action === "price" || action === "price_and_stock")
        ? { lastSyncedPrice: built.platformPrice, priceSyncError: "" }
        : {}),
      lastError: "",
    });
    return { outcome: "updated" };
  } catch (err) {
    await saveSync(doc._id, {
      status: "failed",
      externalId: built.externalId,
      lastSyncedAt: new Date(),
      lastError: err.message || "Miswag sync failed.",
    });
    throw err;
  }
}

async function syncDocument(doc, context, mode) {
  const built = builtFor(doc, context);
  const sync = context.syncs.get(String(doc._id));
  if (!built.ok) {
    await saveSync(doc._id, {
      status: "skipped",
      externalId: built.externalId && built.externalId !== "bs-" ? built.externalId : sync?.externalId || "",
      lastSyncedAt: new Date(),
      lastError: built.errors.join("; "),
    });
    return { outcome: skipOutcome(built.errors), built };
  }

  if (mode === "delta" && sync?.status === "processing" && sync.asyncJobId) {
    return { outcome: "processing", built };
  }

  const hash = fingerprintPayload(built.payload);
  let action = mode;
  if (mode === "delta") {
    action = planDelta(sync?.payloadHash, hash, Boolean(sync?.lastSuccessfulSyncAt));
  }
  const result = await applyRemote(doc, built, sync, action);
  return { ...result, built };
}

async function findProduct(productId) {
  if (!mongoose.Types.ObjectId.isValid(String(productId || ""))) {
    const err = new Error("Product was not found.");
    err.status = 404;
    throw err;
  }
  const doc = await Product.findById(productId);
  if (!doc) {
    const err = new Error("Product was not found.");
    err.status = 404;
    throw err;
  }
  return doc;
}

export async function previewProduct(productId) {
  const doc = await findProduct(productId);
  const context = await loadBatchContext([doc], await loadRules());
  await attachPreservedBarcodes([doc], context, true);
  const built = builtFor(doc, context);
  return {
    product: built.product,
    platformPrice: built.platformPrice,
    pricing: built.pricing,
    categoryMapping: built.mapping,
    brand: built.brand,
    payload: built.payload,
    errors: built.errors,
    warnings: built.warnings,
  };
}

/**
 * Link an already-existing Miswag item into PlatformProductSync bookkeeping.
 * Read-only against Miswag (get item / variations). Never bulk-creates or publishes.
 */
export async function adoptExistingMiswagProduct(productId, { externalId = "", confirm = false } = {}) {
  const expectedExternalId = String(externalId || "").trim();
  if (!expectedExternalId) {
    throw new MiswagError("externalId is required to adopt an existing Miswag item.", { status: 400 });
  }
  if (confirm !== true) {
    throw new MiswagError("Set confirm=true to adopt an existing Miswag item into local sync bookkeeping.", {
      status: 400,
    });
  }

  const doc = await findProduct(productId);
  const resolved = toResolvedProduct(doc);
  const computedExternalId = miswagItemExternalId(resolved);
  if (computedExternalId !== expectedExternalId) {
    throw new MiswagError(
      `BrownStore external id ${computedExternalId || "(empty)"} does not match ${expectedExternalId}.`,
      { status: 409 }
    );
  }

  const [existingByProduct, existingByExternal] = await Promise.all([
    PlatformProductSync.findOne({ partner: MISWAG_PARTNER, product: doc._id }).lean(),
    PlatformProductSync.findOne({ partner: MISWAG_PARTNER, externalId: expectedExternalId }).lean(),
  ]);
  if (existingByExternal && String(existingByExternal.product) !== String(doc._id)) {
    throw new MiswagError("That Miswag external_id is already linked to a different BrownStore product.", {
      status: 409,
    });
  }
  if (existingByProduct?.externalId && existingByProduct.externalId !== expectedExternalId) {
    throw new MiswagError("This BrownStore product is already linked to a different Miswag external_id.", {
      status: 409,
    });
  }

  const itemRes = await getItem(expectedExternalId);
  const item = itemRes?.data?.item;
  if (!item) {
    throw new MiswagError("Miswag item was not found for that external_id.", { status: 404 });
  }

  const remoteCode = String(item.item_code || "").trim();
  const localCode = String(resolved.itemCode || resolved.sku || doc.itemCode || doc.sku || "").trim();
  if (remoteCode && localCode && remoteCode !== localCode) {
    throw new MiswagError(`Miswag item_code ${remoteCode} does not match BrownStore ${localCode}.`, {
      status: 409,
    });
  }

  const remotePrice = Math.round(Number(item.price));
  if (!Number.isFinite(remotePrice) || remotePrice < 0) {
    throw new MiswagError("Miswag item price is missing or invalid.", { status: 502 });
  }

  const varsRes = await listItemVariations(expectedExternalId);
  const variations = Array.isArray(varsRes?.data?.variations) ? varsRes.data.variations : [];
  const variationSummaries = [];
  for (const variation of variations) {
    const variationExternalId = String(variation.id || variation.external_id || "").trim();
    let sizes = Array.isArray(variation.sizes) ? variation.sizes : [];
    if (!sizes.length && variationExternalId) {
      try {
        const detail = await getItemVariation(expectedExternalId, variationExternalId);
        sizes = Array.isArray(detail?.data?.variation?.sizes) ? detail.data.variation.sizes : [];
      } catch {
        sizes = [];
      }
    }
    variationSummaries.push({
      externalId: variationExternalId,
      barcode: String(variation.barcode || "").trim(),
      sizes: sizes.map((size) => ({
        externalId: String(size.id || size.external_id || "").trim(),
        quantity: Number(size.quantity) || 0,
        barcode: size.barcode == null ? null : String(size.barcode),
      })),
    });
  }

  const now = new Date();
  const beforeStatus = existingByProduct?.status || null;
  const sync = await saveSync(doc._id, {
    status: "synced",
    externalId: expectedExternalId,
    externalProductId: String(item.id || expectedExternalId),
    lastSyncedPrice: remotePrice,
    lastSuccessfulSyncAt: existingByProduct?.lastSuccessfulSyncAt || now,
    lastSyncedAt: now,
    lastError: "",
    priceSyncError: "",
    asyncJobId: "",
    asyncJobStatus: "",
  });

  const barcodeState = [];
  for (const variant of resolved.variants || doc.variants || []) {
    const variantId = String(variant?._id || variant?.id || "").trim();
    if (!variantId) continue;
    try {
      const assigned = await ensureMiswagVariationBarcode({
        ibsherId: doc.ibsherId || "",
        variantId,
        explicitBarcode: "",
      });
      barcodeState.push({
        variantId,
        barcode: assigned.barcode,
        created: assigned.created,
        source: assigned.source,
      });
    } catch (err) {
      barcodeState.push({
        variantId,
        error: err.message || "barcode bookkeeping skipped",
      });
    }
  }

  return {
    adopted: true,
    created: !existingByProduct,
    updated: Boolean(existingByProduct),
    beforeStatus,
    product: {
      id: String(doc._id),
      ibsherId: doc.ibsherId || "",
      itemCode: localCode,
      name: resolved.name || doc.name,
    },
    sync,
    remote: {
      externalId: expectedExternalId,
      itemId: String(item.id || ""),
      itemCode: remoteCode,
      price: remotePrice,
      currency: item.currency || "IQD",
      active: item.active === true,
      brand: item.brand || null,
      category: item.category || null,
      variations: variationSummaries,
    },
    barcodeState,
  };
}

export async function syncProduct(productId, mode = "full") {
  const doc = await findProduct(productId);
  const rules = await loadRules();
  const context = await loadBatchContext([doc], rules);
  await attachPreservedBarcodes([doc], context, true);
  try {
    const result = await syncDocument(doc, context, mode);
    return {
      outcome: result.outcome,
      errors: result.built?.errors || [],
      warnings: result.built?.warnings || [],
      payload: result.built?.payload || null,
      platformPrice: result.built?.platformPrice || 0,
    };
  } catch (err) {
    if (err instanceof MiswagError || err.status) throw err;
    throw err;
  }
}

async function sendableCollectionIds() {
  const rows = await PlatformCategoryMapping.find({
    partner: MISWAG_PARTNER,
    status: { $in: ["auto_mapped", "verified"] },
    externalCategoryId: { $ne: "" },
  })
    .select("brownCollectionId")
    .lean();
  return rows.map((row) => row.brownCollectionId).filter(Boolean);
}

async function catalogBuckets(sendable) {
  const rows = await Product.aggregate([
    { $match: { isActive: { $ne: false } } },
    {
      $group: {
        _id: { $toString: { $ifNull: ["$collectionName._id", ""] } },
        n: { $sum: 1 },
      },
    },
  ]);
  const allowed = new Set(sendable);
  let eligible = 0;
  let unmapped = 0;
  let withoutCollection = 0;
  for (const row of rows) {
    const count = Number(row.n) || 0;
    if (!row._id) withoutCollection += count;
    else if (allowed.has(row._id)) eligible += count;
    else unmapped += count;
  }
  return { eligible, unmapped, withoutCollection };
}

export async function syncSummary() {
  const sendable = await sendableCollectionIds();
  const buckets = await catalogBuckets(sendable);
  const grouped = await PlatformProductSync.aggregate([
    { $match: { partner: MISWAG_PARTNER } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const counts = { pending: 0, synced: 0, failed: 0, skipped: 0, processing: 0 };
  for (const row of grouped) counts[row._id] = row.n;
  const latest = await PlatformProductSync.findOne({
    partner: MISWAG_PARTNER,
    lastSuccessfulSyncAt: { $ne: null },
  })
    .sort({ lastSuccessfulSyncAt: -1 })
    .select("lastSuccessfulSyncAt")
    .lean();
  return {
    eligible: buckets.eligible,
    unmapped: buckets.unmapped,
    withoutCollection: buckets.withoutCollection,
    ...counts,
    lastSuccessfulSyncAt: latest?.lastSuccessfulSyncAt || null,
  };
}

function productQuery(q) {
  const term = String(q || "").trim();
  if (!term) return {};
  const rx = new RegExp(escapeRegex(term), "i");
  return {
    $or: [{ "name.ku": rx }, { "name.en": rx }, { "name.ar": rx }, { itemCode: rx }, { "overrides.sku": rx }],
  };
}

export async function listSyncProducts({ q = "", status = "", page = 1, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const wanted = String(status || "").trim();
  const text = productQuery(q);
  let docs = [];
  let total = 0;

  if (["pending", "synced", "failed", "skipped", "processing"].includes(wanted)) {
    const filter = { partner: MISWAG_PARTNER, status: wanted };
    total = await PlatformProductSync.countDocuments(filter);
    const syncs = await PlatformProductSync.find(filter)
      .sort({ updatedAt: -1 })
      .skip((current - 1) * size)
      .limit(size)
      .lean();
    const products = await Product.find({ _id: { $in: syncs.map((item) => item.product) }, ...text }).lean();
    const byId = new Map(products.map((doc) => [String(doc._id), doc]));
    docs = syncs.map((item) => byId.get(String(item.product))).filter(Boolean);
  } else {
    const sendable = await sendableCollectionIds();
    const filter = { ...text };
    if (wanted === "eligible") {
      filter.$expr = {
        $in: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, sendable],
      };
    } else if (wanted === "unmapped") {
      filter.$expr = {
        $not: [{ $in: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, sendable] }],
      };
    }
    total = await Product.countDocuments(filter);
    docs = await Product.find(filter)
      .sort({ updatedAt: -1 })
      .skip((current - 1) * size)
      .limit(size)
      .lean();
  }

  const rules = await loadRules();
  const context = await loadBatchContext(docs, rules);
  await attachPreservedBarcodes(docs, context, false);
  const sendable = new Set(await sendableCollectionIds());
  const products = docs.map((doc) => {
    const built = builtFor(doc, context);
    const sync = context.syncs.get(String(doc._id));
    const collectionId = collectionIdOf(doc);
    return {
      id: String(doc._id),
      name: doc.name || {},
      sku: doc.itemCode || doc.overrides?.sku || "",
      platformPrice: built.platformPrice,
      collectionId,
      mappingStatus: built.mapping?.status || "unmapped",
      eligible: sendable.has(collectionId) && built.ok,
      syncStatus: sync?.status || "pending",
      lastError: sync?.lastError || (built.ok ? "" : built.errors.join("; ")),
      lastSuccessfulSyncAt: sync?.lastSuccessfulSyncAt || null,
      asyncJobId: sync?.asyncJobId || "",
      asyncJobStatus: sync?.asyncJobStatus || "",
      externalId: sync?.externalId || built.externalId || "",
      publishedAt: sync?.publishedAt || null,
      publishError: sync?.publishError || "",
    };
  });

  return {
    products,
    pagination: {
      page: current,
      limit: size,
      total,
      pages: Math.max(1, Math.ceil(total / size)),
    },
  };
}

async function syncDocs(docs, mode, progress, rules) {
  for (let index = 0; index < docs.length; index += BATCH_SIZE) {
    if (progress.aborted) break;
    const batch = docs.slice(index, index + BATCH_SIZE);
    const context = await loadBatchContext(batch, rules);
    await attachPreservedBarcodes(batch, context, false);
    await mapPool(batch, CONCURRENCY, async (doc) => {
      if (progress.aborted) return;
      try {
        const result = await syncDocument(doc, context, mode);
        bump(progress, result.outcome);
      } catch (err) {
        bump(progress, "failed");
        if (err.status === 401 || err.status === 403 || err.status === 429) progress.aborted = err.message;
      }
    });
  }
  return progress;
}

export async function syncProductIds(productIds, mode = "delta") {
  const ids = [...new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) {
    const err = new Error("Choose at least one product.");
    err.status = 400;
    throw err;
  }
  if (ids.length > 100) {
    const err = new Error("Select up to 100 products, or use Sync all eligible.");
    err.status = 400;
    throw err;
  }
  const docs = await Product.find({ _id: { $in: ids.filter((id) => mongoose.Types.ObjectId.isValid(id)) } });
  const progress = emptyProgress();
  await syncDocs(docs, mode, progress, await loadRules());
  return progress;
}

export async function syncAllEligible() {
  const sendable = await sendableCollectionIds();
  const buckets = await catalogBuckets(sendable);
  const progress = emptyProgress();
  progress.skippedUnmapped = buckets.unmapped;
  if (!sendable.length) return progress;

  await refreshProcessingJobs();
  const rules = await loadRules();
  const cursor = Product.find({
    isActive: { $ne: false },
    $expr: {
      $in: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, sendable],
    },
  })
    .sort({ _id: 1 })
    .cursor();

  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      await syncDocs(batch, "delta", progress, rules);
      batch = [];
      if (progress.aborted) break;
    }
  }
  if (batch.length && !progress.aborted) await syncDocs(batch, "delta", progress, rules);
  return progress;
}

export async function retryFailed(limit = 25) {
  const size = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await PlatformProductSync.find({ partner: MISWAG_PARTNER, status: "failed" })
    .sort({ updatedAt: 1 })
    .limit(size)
    .select("product")
    .lean();
  if (!rows.length) return emptyProgress();
  return syncProductIds(rows.map((row) => row.product), "delta");
}

async function refreshProcessingJobs() {
  const rows = await PlatformProductSync.find({
    partner: MISWAG_PARTNER,
    status: "processing",
    asyncJobId: { $ne: "" },
  })
    .limit(20)
    .select("asyncJobId")
    .lean();
  for (const row of rows) {
    try {
      await pollJob(row.asyncJobId);
    } catch (err) {
      console.warn("Miswag job poll skipped:", err.message);
    }
  }
}

export async function pollJob(jobId) {
  const response = await getJob(jobId);
  const data = response.data || {};
  const status = String(data.status || "");
  const update = { asyncJobStatus: status, lastSyncedAt: new Date() };
  if (status === "completed") {
    update.status = "synced";
    update.lastSuccessfulSyncAt = new Date();
    update.lastError = "";
    if (data.result?.item_id) update.externalProductId = String(data.result.item_id);
  } else if (status === "failed") {
    update.status = "failed";
    update.lastError = data.error || "Miswag job failed.";
    update.payloadHash = "";
  } else {
    update.status = "processing";
  }
  await PlatformProductSync.updateMany(
    { partner: MISWAG_PARTNER, asyncJobId: String(jobId) },
    { $set: update }
  );
  return data;
}

async function recordPublish(results) {
  for (const row of results) {
    const errors = Array.isArray(row.errors) ? row.errors.filter(Boolean) : [];
    const update = PUBLISH_OK.has(row.status)
      ? { publishedAt: new Date(), publishError: "" }
      : { publishError: errors.join("; ") || row.status || "invalid" };
    await PlatformProductSync.updateOne(
      { partner: MISWAG_PARTNER, externalId: row.id },
      { $set: update }
    );
  }
}

async function partitionPublishable(syncRows, rules) {
  if (!syncRows.length) return { ready: [], notReady: [] };
  const docs = await Product.find({ _id: { $in: syncRows.map((row) => row.product) } });
  const context = await loadBatchContext(docs, rules);
  await attachPreservedBarcodes(docs, context, false);
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const ready = [];
  const notReady = [];
  for (const row of syncRows) {
    const doc = byId.get(String(row.product));
    const issues = doc
      ? publishContentIssues(builtFor(doc, context))
      : ["missing_product"];
    if (issues.length) {
      notReady.push({
        id: row.externalId || String(row.product),
        productId: String(row.product),
        status: "not_ready",
        errors: issues,
      });
    } else {
      ready.push(row);
    }
  }
  return { ready, notReady };
}

async function syncedRowsForPublish(rows) {
  const ready = [];
  const stillProcessing = [];
  for (const row of rows) {
    if (row.status === "synced") {
      ready.push(row);
      continue;
    }
    if (row.status !== "processing" || !row.asyncJobId) continue;
    try {
      await pollJob(row.asyncJobId);
    } catch {
      stillProcessing.push(row);
      continue;
    }
    const fresh = await PlatformProductSync.findById(row._id).lean();
    if (fresh?.status === "synced") ready.push(fresh);
    else stillProcessing.push(fresh || row);
  }
  return { ready, stillProcessing };
}

export async function publishExternalIds(externalIds) {
  const ids = [...new Set(externalIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const results = [];
  for (let index = 0; index < ids.length; index += PUBLISH_LIMIT) {
    const chunk = ids.slice(index, index + PUBLISH_LIMIT);
    const response = await publishItems(chunk);
    const rows = Array.isArray(response.data?.results) ? response.data.results : [];
    results.push(...rows);
    await recordPublish(rows);
  }
  return { results };
}

export async function publishProductIds(productIds) {
  const ids = [...new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) {
    const err = new Error("Choose at least one product.");
    err.status = 400;
    throw err;
  }
  if (ids.length > 200) {
    const err = new Error("Publish up to 200 products at a time.");
    err.status = 400;
    throw err;
  }
  const syncs = await PlatformProductSync.find({
    partner: MISWAG_PARTNER,
    product: { $in: ids.filter((id) => mongoose.Types.ObjectId.isValid(id)) },
    externalId: { $ne: "" },
    status: { $in: ["synced", "processing"] },
  })
    .select("externalId product status asyncJobId")
    .lean();
  const { ready: syncedRows, stillProcessing } = await syncedRowsForPublish(syncs);
  const { ready, notReady } = await partitionPublishable(syncedRows, await loadRules());
  const published = ready.length
    ? await publishExternalIds(ready.map((row) => row.externalId))
    : { results: [] };
  return {
    ...published,
    notReady,
    skippedProcessing: stillProcessing.length,
    skippedNotSynced: Math.max(0, ids.length - syncedRows.length - stillProcessing.length),
  };
}

export async function publishReady() {
  const total = await PlatformProductSync.countDocuments({
    partner: MISWAG_PARTNER,
    status: "synced",
    externalId: { $ne: "" },
    $or: [{ publishedAt: null }, { publishedAt: { $exists: false } }],
  });
  const rules = await loadRules();
  const cursor = PlatformProductSync.find({
    partner: MISWAG_PARTNER,
    status: "synced",
    externalId: { $ne: "" },
    $or: [{ publishedAt: null }, { publishedAt: { $exists: false } }],
  })
    .sort({ lastSuccessfulSyncAt: 1 })
    .select("externalId product status")
    .cursor();
  const ready = [];
  const notReady = [];
  let batch = [];
  try {
    for await (const row of cursor) {
      batch.push(row);
      if (batch.length < 20) continue;
      const part = await partitionPublishable(batch, rules);
      ready.push(...part.ready);
      notReady.push(...part.notReady);
      batch = [];
      if (ready.length >= PUBLISH_LIMIT) break;
    }
    if (batch.length && ready.length < PUBLISH_LIMIT) {
      const part = await partitionPublishable(batch, rules);
      ready.push(...part.ready);
      notReady.push(...part.notReady);
    }
  } finally {
    await cursor.close();
  }
  const selected = ready.slice(0, PUBLISH_LIMIT);
  if (!selected.length) return { results: [], notReady, remaining: total };
  const published = await publishExternalIds(selected.map((row) => row.externalId));
  return { ...published, notReady, remaining: Math.max(0, total - selected.length) };
}

function syncedPriceFilter(productIds) {
  const filter = {
    partner: MISWAG_PARTNER,
    externalId: { $ne: "" },
    lastSuccessfulSyncAt: { $ne: null },
  };
  if (productIds) filter.product = { $in: productIds };
  return filter;
}

async function patchSyncedPrice(row, rules) {
  const doc = await Product.findById(row.product);
  if (!doc) return "unchanged";
  const price = Math.round(Number(partnerPricePreview(doc, rules).price));
  if (!Number.isFinite(price) || price < 0) return "failed";
  if (row.lastSyncedPrice != null && Number(row.lastSyncedPrice) === price) return "unchanged";
  await updatePrice(row.externalId, price);
  await PlatformProductSync.updateOne(
    { _id: row._id },
    { $set: { lastSyncedPrice: price, priceSyncError: "", lastSyncedAt: new Date() } }
  );
  return "updated";
}

export async function syncMiswagPrices(productIds) {
  const ids = productIds
    ? [...new Set(productIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : null;
  if (ids && !ids.length) return { checked: 0, updated: 0, unchanged: 0, failed: 0 };
  const rows = await PlatformProductSync.find(syncedPriceFilter(ids))
    .select("product externalId lastSyncedPrice")
    .lean();
  const rules = await loadRules();
  const result = { checked: rows.length, updated: 0, unchanged: 0, failed: 0 };
  await mapPool(rows, CONCURRENCY, async (row) => {
    try {
      const outcome = await patchSyncedPrice(row, rules);
      result[outcome] += 1;
    } catch (err) {
      result.failed += 1;
      await PlatformProductSync.updateOne(
        { _id: row._id },
        { $set: { priceSyncError: err.message || "Miswag price sync failed.", lastSyncedAt: new Date() } }
      ).catch(() => {});
    }
  });
  return result;
}

export function scheduleMiswagPriceSync(productIds) {
  syncMiswagPrices(productIds).catch((err) => {
    console.error("Miswag price sync failed:", err.message);
  });
}

export function scheduleMiswagPriceReconciliation() {
  syncMiswagPrices().catch((err) => {
    console.error("Miswag price reconciliation failed:", err.message);
  });
}
