import crypto from "crypto";
import { MiswagVariationBarcode } from "../models/MiswagVariationBarcode.js";
import { MISWAG_PARTNER } from "./miswag.js";

/** Format previously accepted by Miswag Seller API: BS + 12 digits (14 chars). */
export const GENERATED_MISWAG_BARCODE_RX = /^BS[0-9]{12}$/;
const ALLOCATION_ATTEMPTS = 12;
const PRINTABLE = /[^\x20-\x7E]/g;

export function isGeneratedMiswagBarcode(value) {
  return GENERATED_MISWAG_BARCODE_RX.test(String(value || ""));
}

export function formatMiswagVariationBarcode(suffix) {
  const digits =
    suffix == null
      ? String(crypto.randomInt(0, 1_000_000_000_000)).padStart(12, "0")
      : String(suffix).padStart(12, "0").slice(-12);
  const barcode = `BS${digits}`;
  if (!isGeneratedMiswagBarcode(barcode)) {
    throw new Error("Generated Miswag variation barcode must be BS + 12 digits.");
  }
  return barcode;
}

function printable(value, max = 0) {
  const text = String(value || "").replace(PRINTABLE, "").trim();
  if (!text) return "";
  return max ? text.slice(0, max) : text;
}

/** Same variation external_id scheme used by Sync 1 Product payloads. */
export function barcodeVariationExternalId(variant) {
  const variantId = String(variant?._id || variant?.id || "").trim();
  if (!variantId) return "";
  const externalId = printable(`bs-var-${variantId}`, 100);
  return externalId.startsWith("bs-var-") ? externalId : "";
}

function explicitBarcodeOf(variant) {
  if (!variant || typeof variant !== "object") return "";
  for (const key of ["barcode", "barCode", "ean", "upc", "gtin"]) {
    const text = String(variant[key] ?? "").trim();
    if (!text || text.length > 100 || /[^\x20-\x7E]/.test(text)) continue;
    return text;
  }
  return "";
}

function variantIdOf(variant) {
  return String(variant?._id || variant?.id || "").trim();
}

function isDuplicateKey(err) {
  return err?.code === 11000;
}

function duplicateFields(err) {
  return Object.keys(err?.keyPattern || err?.keyValue || {});
}

async function readAssignment(variationExternalId) {
  return MiswagVariationBarcode.findOne({
    partner: MISWAG_PARTNER,
    variationExternalId,
  }).lean();
}

/**
 * Ensure exactly one stable barcode for a Miswag variation.
 * Prefer existing product barcode; otherwise allocate BS############ once and persist it.
 */
export async function ensureMiswagVariationBarcode({
  ibsherId = "",
  variant = null,
  variantId = "",
  explicitBarcode = "",
} = {}) {
  const id = String(variantId || variantIdOf(variant) || "").trim();
  const variationExternalId = barcodeVariationExternalId({ _id: id });
  if (!id || !variationExternalId) {
    throw new Error("Variation id is required before a Miswag barcode can be saved.");
  }

  const existing = await readAssignment(variationExternalId);
  if (existing?.barcode) {
    return {
      barcode: existing.barcode,
      created: false,
      source: existing.source || "generated",
      variationExternalId,
    };
  }

  const preferred = String(explicitBarcode || explicitBarcodeOf(variant) || "").trim();
  if (preferred) {
    try {
      await MiswagVariationBarcode.create({
        partner: MISWAG_PARTNER,
        variationExternalId,
        variantId: id,
        ibsherId: String(ibsherId || ""),
        barcode: preferred,
        source: "explicit",
      });
      return { barcode: preferred, created: true, source: "explicit", variationExternalId };
    } catch (err) {
      if (isDuplicateKey(err) && duplicateFields(err).includes("variationExternalId")) {
        const saved = await readAssignment(variationExternalId);
        if (saved?.barcode) {
          return {
            barcode: saved.barcode,
            created: false,
            source: saved.source || "explicit",
            variationExternalId,
          };
        }
      }
      throw err;
    }
  }

  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    const barcode = formatMiswagVariationBarcode();
    try {
      await MiswagVariationBarcode.create({
        partner: MISWAG_PARTNER,
        variationExternalId,
        variantId: id,
        ibsherId: String(ibsherId || ""),
        barcode,
        source: "generated",
      });
      return { barcode, created: true, source: "generated", variationExternalId };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      if (duplicateFields(err).includes("variationExternalId")) {
        const saved = await readAssignment(variationExternalId);
        if (saved?.barcode) {
          return {
            barcode: saved.barcode,
            created: false,
            source: saved.source || "generated",
            variationExternalId,
          };
        }
      }
    }
  }
  throw new Error("Could not allocate a unique Miswag variation barcode.");
}

/** Load persisted barcodes for a product's variations (variationExternalId → assignment). */
export async function loadMiswagVariationBarcodes(doc) {
  const ids = [];
  for (const variant of doc?.variants || []) {
    const externalId = barcodeVariationExternalId(variant);
    if (externalId) ids.push(externalId);
  }
  if (!ids.length) return new Map();
  const rows = await MiswagVariationBarcode.find({
    partner: MISWAG_PARTNER,
    variationExternalId: { $in: ids },
  })
    .select("variationExternalId barcode source")
    .lean();
  return new Map(
    rows.map((row) => [
      row.variationExternalId,
      { barcode: row.barcode, source: row.source || "generated" },
    ])
  );
}

/**
 * Ensure every variation on the product has a barcode assignment.
 * Does not create barcodes per size.
 */
export async function ensureProductVariationBarcodes(doc) {
  const assignments = new Map();
  const ibsherId = String(doc?.ibsherId || "").trim();
  for (const variant of doc?.variants || []) {
    const result = await ensureMiswagVariationBarcode({ ibsherId, variant });
    assignments.set(result.variationExternalId, {
      barcode: result.barcode,
      source: result.source,
    });
  }
  return assignments;
}
