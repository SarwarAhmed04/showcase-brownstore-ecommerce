import crypto from "crypto";
import { MiswagVariationBarcode } from "../models/MiswagVariationBarcode.js";
import { PlatformProductSync } from "../models/PlatformProductSync.js";
import { Product } from "../models/Product.js";
import { MISWAG_PARTNER } from "./miswag.js";
import { explicitVariationBarcode, miswagVariationExternalId } from "./miswagProduct.js";

const GENERATED_BARCODE = /^BS[0-9]{12}$/;
const ALLOCATION_ATTEMPTS = 12;
const BATCH_LIMIT = 500;

// Already accepted by Miswag. Never replace this with a generated BS code.
const LEGACY_VARIATION_BARCODES = new Map([
  ["bs-var-6a61254f074f4d47dca54e27", "HR7778/01-6a61254f074f4d47dca54e27"],
]);

export function isGeneratedMiswagBarcode(value) {
  return GENERATED_BARCODE.test(String(value || ""));
}

export function generateMiswagBarcodeSuffix() {
  return String(crypto.randomInt(0, 1_000_000_000_000)).padStart(12, "0");
}

export function formatMiswagVariationBarcode(suffix = generateMiswagBarcodeSuffix()) {
  const barcode = `BS${suffix}`;
  if (!isGeneratedMiswagBarcode(barcode)) {
    throw new Error("Generated Miswag variation barcode was not 14 characters.");
  }
  return barcode;
}

function variantIdOf(variant) {
  return String(variant?._id || variant?.id || "").trim();
}

function duplicateFields(err) {
  return Object.keys(err?.keyPattern || err?.keyValue || {});
}

function isDuplicateKey(err) {
  return err?.code === 11000;
}

async function readAssignment(variationExternalId) {
  return MiswagVariationBarcode.findOne({
    partner: MISWAG_PARTNER,
    variationExternalId,
  }).lean();
}

async function insertAssignment(fields) {
  const created = await MiswagVariationBarcode.create({
    partner: MISWAG_PARTNER,
    ...fields,
  });
  return created.toObject();
}

export async function ensureMiswagVariationBarcode({ ibsherId = "", variantId = "", explicitBarcode = "" } = {}) {
  const variationExternalId = miswagVariationExternalId({ _id: variantId });
  if (!variationExternalId || !variantId) {
    throw new Error("Variation id is required before a Miswag barcode can be saved.");
  }

  const existing = await readAssignment(variationExternalId);
  if (existing?.barcode) {
    return { barcode: existing.barcode, created: false, source: existing.source, collisions: 0 };
  }

  const legacy = LEGACY_VARIATION_BARCODES.get(variationExternalId) || "";
  const explicit = String(explicitBarcode || "").trim();
  const preferred = legacy || explicit;
  if (preferred) {
    try {
      await insertAssignment({
        variationExternalId,
        variantId,
        ibsherId: String(ibsherId || ""),
        barcode: preferred,
        source: legacy ? "legacy" : "explicit",
      });
      return { barcode: preferred, created: true, source: legacy ? "legacy" : "explicit", collisions: 0 };
    } catch (err) {
      if (isDuplicateKey(err) && duplicateFields(err).includes("variationExternalId")) {
        const saved = await readAssignment(variationExternalId);
        if (saved?.barcode) return { barcode: saved.barcode, created: false, source: saved.source, collisions: 0 };
      }
      throw err;
    }
  }

  let collisions = 0;
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    const barcode = formatMiswagVariationBarcode();
    try {
      await insertAssignment({
        variationExternalId,
        variantId,
        ibsherId: String(ibsherId || ""),
        barcode,
        source: "generated",
      });
      return { barcode, created: true, source: "generated", collisions };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      if (duplicateFields(err).includes("variationExternalId")) {
        const saved = await readAssignment(variationExternalId);
        if (saved?.barcode) return { barcode: saved.barcode, created: false, source: saved.source, collisions };
      }
      collisions += 1;
    }
  }
  throw new Error("Could not allocate a unique Miswag variation barcode.");
}

export async function loadAssignedBarcodes(docs) {
  const ids = [];
  for (const doc of docs || []) {
    for (const variant of doc?.variants || []) {
      const externalId = miswagVariationExternalId(variant);
      if (externalId) ids.push(externalId);
    }
  }
  if (!ids.length) return new Map();
  const rows = await MiswagVariationBarcode.find({
    partner: MISWAG_PARTNER,
    variationExternalId: { $in: ids },
  })
    .select("variationExternalId barcode")
    .lean();
  return new Map(rows.map((row) => [row.variationExternalId, row.barcode]));
}

export async function assignIncomingVariationBarcodes(products, knownByIbsherId = new Map()) {
  const pending = [];
  for (const product of products || []) {
    const ibsherId = String(product?.ibsherId || "").trim();
    if (!ibsherId) continue;
    const known = knownByIbsherId.get(ibsherId) || new Set();
    for (const variant of product.variants || []) {
      const variantId = variantIdOf(variant);
      if (!variantId || known.has(variantId)) continue;
      pending.push({
        ibsherId,
        variantId,
        explicitBarcode: explicitVariationBarcode(variant),
      });
    }
  }

  const summary = { considered: pending.length, assigned: 0, kept: 0, failed: 0, collisions: 0 };
  for (const entry of pending) {
    try {
      const result = await ensureMiswagVariationBarcode(entry);
      summary.collisions += result.collisions || 0;
      if (result.created) summary.assigned += 1;
      else summary.kept += 1;
    } catch (err) {
      summary.failed += 1;
      console.warn(`Miswag barcode assignment failed for ${entry.ibsherId}/${entry.variantId}: ${err.message}`);
    }
  }
  return summary;
}

export async function backfillMiswagVariationBarcodes({ batchSize = 100, afterIbsherId = "" } = {}) {
  const size = Math.min(Math.max(Number(batchSize) || 100, 1), BATCH_LIMIT);
  const cursor = String(afterIbsherId || "");
  const filter = cursor ? { ibsherId: { $gt: cursor } } : {};
  const [products, synced] = await Promise.all([
    Product.find(filter).sort({ ibsherId: 1 }).limit(size).select("ibsherId variants").lean(),
    PlatformProductSync.find({
      partner: MISWAG_PARTNER,
      lastSuccessfulSyncAt: { $ne: null },
    })
      .select("product")
      .lean(),
  ]);
  const syncedProductIds = new Set(synced.map((row) => String(row.product)));
  const fullProducts = syncedProductIds.size
    ? await Product.find({ _id: { $in: [...syncedProductIds] } }).select("ibsherId").lean()
    : [];
  const syncedIbsherIds = new Set(fullProducts.map((doc) => String(doc.ibsherId || "")).filter(Boolean));

  const summary = {
    processedProducts: products.length,
    processedVariations: 0,
    assigned: 0,
    kept: 0,
    skippedSyncedProduct: 0,
    failed: 0,
    collisions: 0,
    nextCursor: products.length ? String(products[products.length - 1].ibsherId || "") : cursor,
    done: products.length < size,
  };

  for (const product of products) {
    if (syncedIbsherIds.has(String(product.ibsherId || ""))) {
      summary.skippedSyncedProduct += 1;
      continue;
    }
    for (const variant of product.variants || []) {
      const variantId = variantIdOf(variant);
      if (!variantId) continue;
      summary.processedVariations += 1;
      try {
        const result = await ensureMiswagVariationBarcode({
          ibsherId: product.ibsherId,
          variantId,
          explicitBarcode: explicitVariationBarcode(variant),
        });
        summary.collisions += result.collisions || 0;
        if (result.created) summary.assigned += 1;
        else summary.kept += 1;
      } catch (err) {
        summary.failed += 1;
        console.warn(`Miswag barcode backfill failed for ${product.ibsherId}/${variantId}: ${err.message}`);
      }
    }
  }

  console.log(
    `Miswag barcode backfill batch: assigned ${summary.assigned}, kept ${summary.kept}, failed ${summary.failed}, next ${summary.done ? "done" : summary.nextCursor}`
  );
  return summary;
}
