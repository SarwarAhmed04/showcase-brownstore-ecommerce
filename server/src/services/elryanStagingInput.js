import { Product } from "../models/Product.js";
import { ElryanStagingDimensionCheck } from "../models/ElryanStagingDimensionCheck.js";
import { ElryanStagingProductOverride } from "../models/ElryanStagingProductOverride.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  assessElryanDimensionConfirmation,
  normalizeElryanStagingAttributes,
} from "../utils/elryanStagingGate.js";

function inputError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

async function loadSku(productId, sku) {
  const doc = await Product.findById(productId).lean();
  if (!doc) throw inputError("Product not found", "product_not_found");
  const resolved = toResolvedProduct(doc);
  const actual = String(resolved?.sku || "");
  const requested = String(sku || actual).trim();
  if (!actual || requested !== actual) {
    throw inputError("SKU does not match this BrownStore product.", "sku_mismatch");
  }
  return { doc, sku: actual };
}

export async function saveElryanStagingProductOverride({
  environment,
  productId,
  sku,
  attributes,
  confirm,
} = {}) {
  if (confirm !== true) {
    throw inputError("Saving a Staging override requires confirm=true.", "confirm_required");
  }
  if (environment !== "staging") {
    throw inputError("Product overrides can be stored for Staging only.", "staging_only");
  }
  const normalized = normalizeElryanStagingAttributes(attributes);
  if (!normalized.ok) {
    throw inputError("Each override attribute needs a code and a positive integer value id.", normalized.code);
  }
  const loaded = await loadSku(productId, sku);
  const saved = await ElryanStagingProductOverride.findOneAndUpdate(
    { environment: "staging", productId: String(loaded.doc._id) },
    {
      $set: {
        sku: loaded.sku,
        attributes: normalized.attributes,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return {
    ok: true,
    environment: "staging",
    productId: String(loaded.doc._id),
    sku: saved.sku,
    attributes: saved.attributes || {},
  };
}

export async function confirmElryanStagingDimensions({
  environment,
  productId,
  sku,
  unit,
  width,
  height,
  depth,
  axesConfirmed,
  confirm,
} = {}) {
  if (confirm !== true) {
    throw inputError("Dimension confirmation requires confirm=true.", "confirm_required");
  }
  if (environment !== "staging") {
    throw inputError("Dimension confirmation is Staging only.", "staging_only");
  }
  const candidate = {
    environment: "staging",
    unit,
    width,
    height,
    depth,
    axesConfirmed: axesConfirmed === true,
  };
  const assessed = assessElryanDimensionConfirmation(candidate);
  if (!assessed.confirmed) {
    throw inputError(
      "Dimension confirmation needs an explicit unit and explicit width, height, and depth. Nothing was assumed.",
      "dimensions_unverified"
    );
  }
  const loaded = await loadSku(productId, sku);
  const saved = await ElryanStagingDimensionCheck.findOneAndUpdate(
    { environment: "staging", productId: String(loaded.doc._id) },
    {
      $set: {
        sku: loaded.sku,
        unit: assessed.unit,
        width: assessed.width,
        height: assessed.height,
        depth: assessed.depth,
        axesConfirmed: true,
        confirmedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return {
    ok: true,
    environment: "staging",
    productId: String(loaded.doc._id),
    sku: saved.sku,
    unit: saved.unit,
    width: saved.width,
    height: saved.height,
    depth: saved.depth,
    axesConfirmed: true,
  };
}
