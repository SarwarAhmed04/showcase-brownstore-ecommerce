import crypto from "crypto";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniSkuCreateAttempt } from "../models/GiniSkuCreateAttempt.js";
import { GiniSyncOneAudit } from "../models/GiniSyncOneAudit.js";
import { GiniSyncOnePreview } from "../models/GiniSyncOnePreview.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { blockerMessage, buildGiniPlanFromParts, mappingFromTree } from "../utils/giniSyncEvaluate.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  GINI_IMAGE_MAX_BYTES,
  GINI_PRODUCTS_PATH,
  giniSkuKey,
  isAllowedMediaUrl,
  normalizeGiniItemCode,
  sniffImage,
} from "../utils/giniSyncOnePlan.js";
import { fetchGiniCategoryTree, performGiniRequest, sanitizeGiniText } from "./giniConnection.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";
import { isGiniHistoricalHoldSku } from "../utils/giniHistoricalHold.js";
import { giniSyncOneWritesEnabled } from "../utils/giniSkuCreateGates.js";
import { attemptIndexesEnforced } from "../utils/giniSkuCreateIndexes.js";

const PREVIEW_TTL_MS = 20 * 60 * 1000;

let mediaFetchImpl = globalThis.fetch.bind(globalThis);

export function setGiniMediaFetch(fn) {
  mediaFetchImpl = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

function safeMessage(value, max = 400) {
  return sanitizeGiniText(value, [], max)
    .replace(/x-signature\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/x-api-key\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, max);
}

function createFailureCode(response) {
  if (response?.edgeBlocked) return "gini_edge_blocked";
  if (response?.status === 403 && response.json != null) return "gini_access_forbidden";
  return "gini_create_failed";
}

async function loadProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  return Product.findById(productId).lean();
}

async function ownersForSku(skuKey) {
  if (!skuKey) return [];
  const owners = [];
  const cursor = Product.find({ itemCode: { $type: "string", $ne: "" } }).select("_id itemCode").lean().cursor();
  for await (const doc of cursor) {
    if (giniSkuKey(doc.itemCode) === skuKey) owners.push(String(doc._id));
  }
  return owners;
}

async function readLiveMapping(product) {
  const context = await loadEligibilityContext("gini");
  const saved = taxonomyValuesForProduct(product, context);
  let live;
  try {
    live = await fetchGiniCategoryTree();
  } catch {
    return { blockers: ["categories_unavailable"], category: null, subcategory: null };
  }
  if (live.connectionRequired) {
    return { blockers: ["connection_required"], category: null, subcategory: null };
  }
  return mappingFromTree(saved, live.categories);
}

export async function buildGiniSyncPlan(productId) {
  const doc = await loadProduct(productId);
  if (!doc) {
    const error = new Error("Product not found");
    error.status = 404;
    error.code = "product_not_found";
    throw error;
  }
  const resolved = toResolvedProduct(doc);
  const rules = await Commission.find({ partner: "gini", isActive: { $ne: false } }).lean();
  const priced = partnerPricePreview(doc, rules);
  const sku = normalizeGiniItemCode(doc.itemCode);
  const duplicateProductIds = sku ? await ownersForSku(giniSkuKey(sku)) : [];
  const mapping = await readLiveMapping(doc);
  let existing = null;
  if (sku && !mapping.blockers.includes("connection_required") && !mapping.blockers.includes("categories_unavailable")) {
    try {
      existing = await findExistingGiniProduct(sku);
    } catch {
      existing = { error: true };
    }
  }
  return buildGiniPlanFromParts({ doc, resolved, priced, duplicateProductIds, mapping, existing });
}

function publicPreview(plan, previewToken = "") {
  return {
    productId: plan.productId,
    sku: plan.sku,
    action: plan.action,
    canSend: plan.canSend,
    giniMode: plan.giniMode,
    brownStoreVariantsCollapsed: plan.brownStoreVariantsCollapsed,
    variantCount: plan.variantCount,
    brownStorePrice: plan.brownStorePrice,
    commissionRate: plan.commissionRate,
    giniPrice: plan.giniPrice,
    priceReview: Boolean(plan.priceReview),
    priceReviewReason: plan.priceReviewReason || "",
    quantity: plan.quantity,
    category: plan.category,
    subcategory: plan.subcategory,
    imageCount: plan.imageCount,
    payloadPreview: plan.payloadPreview,
    warnings: plan.warnings,
    blockers: plan.blockers,
    blockerMessages: plan.blockerMessages,
    duplicateProductIds: plan.duplicateProductIds,
    existingGiniProductId: plan.existingGiniProductId,
    previewToken: previewToken || "",
  };
}

export async function previewGiniSyncOne({ productId } = {}) {
  const plan = await buildGiniSyncPlan(productId);
  let previewToken = "";
  if (plan.action === "CREATE") {
    previewToken = crypto.randomBytes(24).toString("base64url");
    await GiniSyncOnePreview.create({
      token: previewToken,
      productId: plan.productId,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
    });
  }
  return publicPreview(plan, previewToken);
}

export async function downloadGiniProductImage(url, index) {
  if (!isAllowedMediaUrl(url)) {
    const error = new Error(blockerMessage("invalid_image"));
    error.code = "invalid_image";
    throw error;
  }
  const response = await mediaFetchImpl(url, { method: "GET", redirect: "manual" });
  const status = Number(response?.status) || 0;
  const contentType = response?.headers?.get?.("content-type") || "";
  if (status !== 200) {
    const error = new Error(blockerMessage("invalid_image"));
    error.code = "invalid_image";
    throw error;
  }
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > GINI_IMAGE_MAX_BYTES) {
    const error = new Error(blockerMessage("invalid_image"));
    error.code = "invalid_image";
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sniffed = sniffImage(bytes, contentType);
  if (!sniffed) {
    const error = new Error(blockerMessage("invalid_image"));
    error.code = "invalid_image";
    throw error;
  }
  return {
    blob: new Blob([bytes], { type: sniffed.mime }),
    filename: `image-${index + 1}.${sniffed.extension}`,
  };
}

function formValue(value) {
  return value == null ? "" : String(value);
}

function appendPayload(form, payload, files) {
  form.append("name", formValue(payload.name));
  form.append("description", formValue(payload.description));
  form.append("sku", formValue(payload.sku));
  form.append("price", formValue(payload.price));
  form.append("quantity", formValue(payload.quantity));
  form.append("security_stock", formValue(payload.security_stock));
  form.append("category_id", formValue(payload.category_id));
  form.append("subcategory_id", formValue(payload.subcategory_id));
  form.append("is_visible", formValue(payload.is_visible));
  for (const file of files) form.append("images[]", file.blob, file.filename);
}

export function buildGiniCreateForm(payload, files) {
  const form = new FormData();
  appendPayload(form, payload, files);
  return form;
}

async function recordAudit(fields) {
  await GiniSyncOneAudit.create({
    partner: "gini",
    productId: String(fields.productId || ""),
    sku: String(fields.sku || ""),
    action: String(fields.action || ""),
    success: Boolean(fields.success),
    httpStatus: Number(fields.httpStatus) || 0,
    giniProductId: String(fields.giniProductId || ""),
    errorCode: String(fields.errorCode || "").slice(0, 80),
    errorMessage: safeMessage(fields.errorMessage || ""),
    responseContentType: String(fields.responseContentType || "")
      .replace(/[\r\n]/g, "")
      .trim()
      .slice(0, 120),
    requestId: String(fields.requestId || "")
      .replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 64),
    edgeBlocked: Boolean(fields.edgeBlocked),
    responseSnippet: safeMessage(fields.responseSnippet || ""),
  });
}

function blockedResult(plan, code) {
  return {
    ok: false,
    action: plan?.action || "BLOCKED",
    httpStatus: 0,
    productId: plan?.productId || "",
    sku: plan?.sku || "",
    giniProductId: plan?.existingGiniProductId || "",
    message: blockerMessage(code),
    code,
    blockers: plan?.blockers || [code],
    blockerMessages: (plan?.blockers || [code]).map(blockerMessage),
  };
}

export async function sendGiniSyncOne({ productId, confirm = false, previewToken = "" } = {}) {
  if (confirm !== true) return blockedResult(null, "confirm_required");
  if (!giniSyncOneWritesEnabled()) return blockedResult(null, "sync_one_writes_disabled");
  const token = String(previewToken || "").trim();
  const id = String(productId || "").trim();
  if (!token || !id) return blockedResult(null, "preview_required");
  const preview = await GiniSyncOnePreview.findOne({ token }).lean();
  if (!preview) return blockedResult(null, "preview_required");
  if (preview.productId !== id) return blockedResult(null, "preview_mismatch");
  if (preview.consumedAt) return blockedResult(null, "preview_required");
  if (new Date(preview.expiresAt).getTime() <= Date.now()) return blockedResult(null, "preview_expired");

  const plan = await buildGiniSyncPlan(id);
  if (isGiniHistoricalHoldSku(plan.sku)) return blockedResult(plan, "historical_sku_hold");
  if (plan.action !== "CREATE") {
    const code = plan.blockers.includes("existing_gini_product")
      ? "existing_gini_product_requires_update_flow"
      : plan.blockers[0] || "blocked";
    return blockedResult(plan, code);
  }
  if (!(await attemptIndexesEnforced(GiniSkuCreateAttempt.collection))) {
    return blockedResult(plan, "sku_create_indexes_unavailable");
  }

  let files = [];
  try {
    files = [];
    for (let index = 0; index < plan.payloadPreview.images.length; index += 1) {
      files.push(await downloadGiniProductImage(plan.payloadPreview.images[index].url, index));
    }
  } catch (err) {
    return blockedResult({ ...plan, blockers: ["invalid_image"] }, err.code || "invalid_image");
  }

  const claimed = await GiniSyncOnePreview.findOneAndUpdate(
    { token, productId: id, consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } }
  );
  if (!claimed) return blockedResult(plan, "preview_required");

  const form = buildGiniCreateForm(plan.payloadPreview, files);
  let response;
  try {
    response = await performGiniRequest({
      method: "POST",
      path: GINI_PRODUCTS_PATH,
      form,
    });
  } catch (err) {
    let recovered = null;
    try {
      recovered = await findExistingGiniProduct(plan.sku);
    } catch {
      recovered = { error: true };
    }
    if (recovered?.exists) {
      await recordAudit({
        productId: plan.productId,
        sku: plan.sku,
        action: "CREATE",
        success: true,
        httpStatus: 0,
        giniProductId: recovered.giniProductId,
        errorCode: "",
        errorMessage: "",
      });
      return {
        ok: true,
        action: "CREATE",
        httpStatus: 0,
        productId: plan.productId,
        sku: plan.sku,
        giniProductId: recovered.giniProductId,
        message: "The create response was not received, but this SKU now exists on GINI. No second create was sent.",
        code: "create_recovered_by_sku",
        blockers: [],
      };
    }
    const message = safeMessage(err?.message || "GINI create failed before a response was received.");
    await recordAudit({
      productId: plan.productId,
      sku: plan.sku,
      action: "CREATE",
      success: false,
      httpStatus: 0,
      errorCode: "create_uncertain",
      errorMessage: message,
    });
    return {
      ok: false,
      action: "CREATE",
      httpStatus: 0,
      productId: plan.productId,
      sku: plan.sku,
      giniProductId: "",
      message,
      code: "create_uncertain",
      blockers: [],
    };
  }

  const created = response.json?.data || {};
  const ok = response.status === 200 || response.status === 201;
  if (ok) {
    const giniProductId = String(created.id ?? "");
    await recordAudit({
      productId: plan.productId,
      sku: plan.sku,
      action: "CREATE",
      success: true,
      httpStatus: response.status,
      giniProductId,
      errorCode: "",
      errorMessage: "",
    });
    return {
      ok: true,
      action: "CREATE",
      httpStatus: response.status,
      productId: plan.productId,
      sku: created.sku ? String(created.sku) : plan.sku,
      giniProductId,
      message: "GINI product created.",
      code: "",
      blockers: [],
    };
  }
  const code = createFailureCode(response);
  const message = safeMessage(response.safeErrorMessage || "GINI did not create the product.");
  await recordAudit({
    productId: plan.productId,
    sku: plan.sku,
    action: "CREATE",
    success: false,
    httpStatus: response.status,
    giniProductId: "",
    errorCode: code,
    errorMessage: message,
    responseContentType: response.contentType,
    requestId: response.requestId,
    edgeBlocked: response.edgeBlocked,
    responseSnippet: response.safeBodySnippet,
  });
  return {
    ok: false,
    action: "CREATE",
    httpStatus: response.status,
    productId: plan.productId,
    sku: plan.sku,
    giniProductId: "",
    message,
    code,
    requestId: String(response.requestId || ""),
    edgeBlocked: Boolean(response.edgeBlocked),
    blockers: [],
  };
}

export async function searchGiniSyncProducts(q = "", limit = 20) {
  const query = String(q || "").trim();
  const size = Math.min(Math.max(Number(limit) || 20, 1), 20);
  if (!query) return { products: [] };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const rows = await Product.find({
    $or: [{ itemCode: pattern }, { "name.en": pattern }, { "name.ar": pattern }, { "name.ku": pattern }],
  })
    .select("name itemCode price")
    .sort({ itemCode: 1 })
    .limit(size)
    .lean();
  return {
    products: rows.map((row) => ({
      id: String(row._id),
      name: row.name || {},
      itemCode: row.itemCode || "",
      price: Number(row.price) || 0,
    })),
  };
}
