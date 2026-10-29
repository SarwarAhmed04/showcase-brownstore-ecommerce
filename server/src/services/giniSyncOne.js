import crypto from "crypto";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniSyncOneAudit } from "../models/GiniSyncOneAudit.js";
import { GiniSyncOnePreview } from "../models/GiniSyncOnePreview.js";
import { Product } from "../models/Product.js";
import { GINI_SAFETY_STOCK } from "../utils/platformExcel/gini.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { productScopeIds } from "../utils/platformEligibility.js";
import { giniMappingStatus } from "../utils/giniCategoryTree.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  GINI_DESCRIPTION_MAX_WORDS,
  GINI_IMAGE_LIMIT,
  GINI_IMAGE_MAX_BYTES,
  GINI_NAME_MAX,
  GINI_PRODUCTS_PATH,
  assessSimpleProduct,
  buildSimplePayloadPreview,
  decideSyncAction,
  giniCatalogText,
  giniSkuKey,
  isAllowedMediaUrl,
  listGiniImageUrls,
  normalizeGiniItemCode,
  sniffImage,
  wordCount,
} from "../utils/giniSyncOnePlan.js";
import { fetchGiniCategoryTree, performGiniRequest, sanitizeGiniText } from "./giniConnection.js";

const PREVIEW_TTL_MS = 20 * 60 * 1000;
const BLOCKER_TEXT = {
  duplicate_brownstore_sku: "More than one BrownStore product uses this SKU.",
  existing_gini_product: "This SKU already exists on GINI. A future action would be UPDATE.",
  missing_sku: "This product has no itemCode SKU.",
  missing_mapping: "This collection has no saved GINI category mapping.",
  invalid_mapping: "The saved GINI category mapping is not in the live category tree.",
  inactive_mapping: "The saved GINI category or subcategory is inactive.",
  missing_brand: "Missing brand.",
  missing_name: "Missing Arabic or English product name.",
  missing_description: "Missing Arabic description.",
  name_too_long: "The GINI product name is longer than 255 characters.",
  description_too_long: "The GINI description is longer than 1000 words.",
  invalid_price: "GINI price must be a positive whole number of IQD.",
  price_needs_review: "The original IBSHER regular price is missing or ambiguous.",
  invalid_quantity: "Quantity must be a whole number of 0 or more.",
  missing_image: "At least one usable image is required.",
  invalid_image: "An image could not be downloaded as a valid GINI image file.",
  gini_variant_mapping_required: "This product has more than a single simple sellable variant.",
  connection_required: "Connect GINI API first.",
  categories_unavailable: "The live GINI category tree could not be read.",
  gini_lookup_failed: "The current GINI product list could not be read.",
  confirm_required: "Send requires an explicit confirmation after Preview.",
  preview_required: "Preview this product again before sending.",
  preview_expired: "This preview expired. Preview the product again.",
  preview_mismatch: "The preview does not match this product.",
  existing_gini_product_requires_update_flow: "This SKU already exists on GINI. Update is not part of this first create flow.",
};

let mediaFetchImpl = globalThis.fetch.bind(globalThis);

export function setGiniMediaFetch(fn) {
  mediaFetchImpl = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

function blockerMessage(code) {
  return BLOCKER_TEXT[code] || code;
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

function integerOrNull(value, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) return null;
  return number;
}

function numericId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return text;
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

function sameSku(item, skuKey) {
  return giniSkuKey(item?.sku) === skuKey;
}

async function findExistingGiniProduct(sku) {
  const skuKey = giniSkuKey(sku);
  const shown = await performGiniRequest({
    method: "GET",
    path: `${GINI_PRODUCTS_PATH}/${encodeURIComponent(sku)}`,
  });
  if (shown.status === 404) return { exists: false };
  if (shown.status === 200 && sameSku(shown.json?.data, skuKey)) {
    return {
      exists: true,
      giniProductId: String(shown.json.data.id ?? ""),
      sku: String(shown.json.data.sku || sku),
    };
  }
  if (shown.status !== 200 && shown.status !== 404) {
    return { error: true, status: shown.status };
  }
  let page = 1;
  let lastPage = 1;
  while (page <= lastPage && page <= 5) {
    const listed = await performGiniRequest({
      method: "GET",
      path: GINI_PRODUCTS_PATH,
      query: `?search=${encodeURIComponent(sku)}&per_page=100&page=${page}`,
    });
    if (listed.status !== 200 || !Array.isArray(listed.json?.data)) {
      return { error: true, status: listed.status };
    }
    const match = listed.json.data.find((item) => sameSku(item, skuKey));
    if (match) {
      return { exists: true, giniProductId: String(match.id ?? ""), sku: String(match.sku || sku) };
    }
    lastPage = Number(listed.json?.meta?.last_page) || 1;
    page += 1;
  }
  return { exists: false };
}

async function readLiveMapping(product) {
  const context = await loadEligibilityContext("gini");
  const saved = taxonomyValuesForProduct(product, context);
  const categoryId = String(saved?.categoryId || "").trim();
  const subcategoryId = String(saved?.subcategoryId || "").trim();
  let live;
  try {
    live = await fetchGiniCategoryTree();
  } catch {
    return { blockers: ["categories_unavailable"], category: null, subcategory: null };
  }
  if (live.connectionRequired) {
    return { blockers: ["connection_required"], category: null, subcategory: null };
  }
  const status = giniMappingStatus(saved, live.categories);
  if (status === "missing") return { blockers: ["missing_mapping"], category: null, subcategory: null };
  if (status === "invalid") {
    return {
      blockers: ["invalid_mapping"],
      category: { id: numericId(categoryId), name: "" },
      subcategory: { id: numericId(subcategoryId), name: "" },
    };
  }
  if (status === "inactive") {
    const category = live.categories.find((item) => String(item.id) === categoryId);
    const subcategory = category?.subcategories?.find((item) => String(item.id) === subcategoryId);
    return {
      blockers: ["inactive_mapping"],
      category: category ? { id: numericId(category.id), name: category.name } : { id: numericId(categoryId), name: "" },
      subcategory: subcategory
        ? { id: numericId(subcategory.id), name: subcategory.name }
        : { id: numericId(subcategoryId), name: "" },
    };
  }
  const category = live.categories.find((item) => String(item.id) === categoryId);
  const subcategory = category.subcategories.find((item) => String(item.id) === subcategoryId);
  return {
    blockers: [],
    category: { id: numericId(category.id), name: category.name },
    subcategory: { id: numericId(subcategory.id), name: subcategory.name },
  };
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
  const text = giniCatalogText(resolved);
  const simple = assessSimpleProduct({ ...resolved, itemCode: doc.itemCode, sellingPrice: priced.storePrice });
  const imageUrls = listGiniImageUrls(resolved);
  const plannedImages = imageUrls.slice(0, GINI_IMAGE_LIMIT);
  const blockers = [];
  let duplicateProductIds = [];
  if (!sku) blockers.push("missing_sku");
  if (sku) {
    duplicateProductIds = await ownersForSku(giniSkuKey(sku));
    if (duplicateProductIds.length !== 1 || !duplicateProductIds.includes(String(doc._id))) {
      blockers.push("duplicate_brownstore_sku");
    }
  }
  blockers.push(...simple.blockers);
  if (!text.brand) blockers.push("missing_brand");
  if (!text.nameAr || !text.nameEn) blockers.push("missing_name");
  if (!text.description) blockers.push("missing_description");
  if (text.name && text.name.length > GINI_NAME_MAX) blockers.push("name_too_long");
  if (text.description && wordCount(text.description) > GINI_DESCRIPTION_MAX_WORDS) blockers.push("description_too_long");
  const giniPrice = priced.priceReview ? null : integerOrNull(priced.price, { min: 1 });
  const quantity = integerOrNull(resolved?.stock, { min: 0 });
  if (priced.priceReview) blockers.push("price_needs_review");
  else if (giniPrice == null) blockers.push("invalid_price");
  if (quantity == null) blockers.push("invalid_quantity");
  if (!plannedImages.length) blockers.push("missing_image");
  if (plannedImages.some((url) => !isAllowedMediaUrl(url))) blockers.push("invalid_image");

  const mapping = await readLiveMapping(doc);
  blockers.push(...mapping.blockers);

  let existing = null;
  if (sku && !blockers.includes("connection_required") && !blockers.includes("categories_unavailable")) {
    try {
      existing = await findExistingGiniProduct(sku);
    } catch {
      existing = { error: true };
    }
    if (existing?.error) blockers.push("gini_lookup_failed");
    else if (existing?.exists) blockers.push("existing_gini_product");
  }

  const decision = decideSyncAction(blockers);
  const warnings = [];
  if (imageUrls.length > GINI_IMAGE_LIMIT) warnings.push("Only the first 10 images will be sent.");
  if (resolved?.outOfStock === true) warnings.push("BrownStore marks this product out of stock.");
  if (simple.simple) {
    warnings.push("GINI mode: SIMPLE_PRODUCT");
    warnings.push("BrownStore variants collapsed: 1");
  }
  if (decision.action === "UPDATE_AVAILABLE") {
    warnings.push("This SKU already exists on GINI. The future action would be UPDATE. Send stays blocked.");
  }
  const category = mapping.category;
  const subcategory = mapping.subcategory;
  const isVisible = resolved?.isActive === false ? 0 : 1;
  const payloadPreview = buildSimplePayloadPreview({
    text,
    sku,
    price: giniPrice,
    quantity,
    securityStock: GINI_SAFETY_STOCK,
    category,
    subcategory,
    isVisible,
    imageUrls: plannedImages,
  });
  return {
    productId: String(doc._id),
    sku,
    action: decision.action,
    canSend: decision.canSend,
    giniMode: simple.giniMode,
    brownStoreVariantsCollapsed: simple.brownStoreVariantsCollapsed,
    variantCount: simple.variantCount,
    brownStorePrice: priced.priceReview ? null : priced.storePrice,
    commissionRate: priced.rate,
    giniPrice: priced.priceReview ? null : giniPrice,
    priceReview: Boolean(priced.priceReview),
    priceReviewReason: priced.priceReviewReason || "",
    quantity,
    category,
    subcategory,
    imageCount: plannedImages.length,
    payloadPreview,
    warnings,
    blockers: decision.blockers,
    blockerMessages: decision.blockers.map(blockerMessage),
    duplicateProductIds: blockers.includes("duplicate_brownstore_sku") ? duplicateProductIds : [],
    existingGiniProductId: existing?.giniProductId || "",
    collectionId: productScopeIds(doc).collection,
  };
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

async function downloadImage(url, index) {
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
  const token = String(previewToken || "").trim();
  const id = String(productId || "").trim();
  if (!token || !id) return blockedResult(null, "preview_required");
  const preview = await GiniSyncOnePreview.findOne({ token }).lean();
  if (!preview) return blockedResult(null, "preview_required");
  if (preview.productId !== id) return blockedResult(null, "preview_mismatch");
  if (preview.consumedAt) return blockedResult(null, "preview_required");
  if (new Date(preview.expiresAt).getTime() <= Date.now()) return blockedResult(null, "preview_expired");

  const plan = await buildGiniSyncPlan(id);
  if (plan.action !== "CREATE") {
    const code = plan.blockers.includes("existing_gini_product")
      ? "existing_gini_product_requires_update_flow"
      : plan.blockers[0] || "blocked";
    return blockedResult(plan, code);
  }

  let files = [];
  try {
    files = [];
    for (let index = 0; index < plan.payloadPreview.images.length; index += 1) {
      files.push(await downloadImage(plan.payloadPreview.images[index].url, index));
    }
  } catch (err) {
    return blockedResult({ ...plan, blockers: ["invalid_image"] }, err.code || "invalid_image");
  }

  const claimed = await GiniSyncOnePreview.findOneAndUpdate(
    { token, productId: id, consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } }
  );
  if (!claimed) return blockedResult(plan, "preview_required");

  const form = new FormData();
  appendPayload(form, plan.payloadPreview, files);
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
