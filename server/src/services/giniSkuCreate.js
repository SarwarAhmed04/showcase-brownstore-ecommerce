import crypto from "crypto";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniSkuCreateAttempt } from "../models/GiniSkuCreateAttempt.js";
import { GiniSkuCreatePreview } from "../models/GiniSkuCreatePreview.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility } from "../utils/platformEligibility.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import { isGiniHistoricalHoldSku } from "../utils/giniHistoricalHold.js";
import { existingGiniWriteGatesEnabled, giniSkuCreateWritesEnabled } from "../utils/giniSkuCreateGates.js";
import { attemptIndexesEnforced, previewIndexesEnforced } from "../utils/giniSkuCreateIndexes.js";
import {
  blockerMessage,
  buildGiniPlanFromParts,
  giniPayloadHash,
  mappingFromTree,
} from "../utils/giniSyncEvaluate.js";
import { GINI_PRODUCTS_PATH, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import { fetchGiniCategoryTree, performGiniRequest, resolveGiniConfig } from "./giniConnection.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const EXPECTED_HOST = "merchant.gini.iq";
const EXPECTED_CLIENT_MASK = "1423...2bee";
export class GiniSkuCreateError extends Error {
  constructor(message, { status = 409, code = "gini_sku_create_blocked" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(code, status = 409) {
  throw new GiniSkuCreateError(blockerMessage(code), { status, code });
}

function maskClientId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length < 8) return "set";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export { existingGiniWriteGatesEnabled, giniSkuCreateWritesEnabled };

export async function giniSkuCreateAttemptIndexesEnforced(collection = GiniSkuCreateAttempt.collection) {
  return attemptIndexesEnforced(collection);
}

export async function giniSkuCreatePreviewIndexesEnforced(collection = GiniSkuCreatePreview.collection) {
  return previewIndexesEnforced(collection);
}

export function assessGiniMerchantIdentity(config) {
  let host = "";
  try {
    host = new URL(String(config?.baseUrl || "")).hostname;
  } catch {
    host = "";
  }
  const clientMask = maskClientId(config?.clientId);
  const matches =
    host === EXPECTED_HOST &&
    clientMask === EXPECTED_CLIENT_MASK &&
    config?.hasSecret === true &&
    config?.secretUnreadable !== true &&
    !config?.baseUrlError;
  return { host, clientMask, matches, reason: matches ? "" : "merchant_not_confirmed" };
}

function remoteDecision(found) {
  if (found?.exists === true && found.giniProductId && giniSkuKey(found.sku)) {
    return { ok: false, code: "existing_gini_product", giniProductId: String(found.giniProductId) };
  }
  if (found?.exists === false && !found.error) return { ok: true, code: "verified_missing", giniProductId: "" };
  const failure = found?.failure || "";
  if (failure === "incomplete") return { ok: false, code: "search_pagination_incomplete", giniProductId: "" };
  if (failure === "duplicate") return { ok: false, code: "duplicate_remote_sku", giniProductId: "" };
  if (failure === "rate_limited") return { ok: false, code: "rate_limited", giniProductId: "" };
  if (failure === "auth") return { ok: false, code: "gini_access_forbidden", giniProductId: "" };
  if (failure === "edge") return { ok: false, code: "gini_edge_blocked", giniProductId: "" };
  return { ok: false, code: "gini_lookup_failed", giniProductId: "" };
}

function createdIdentity(response, skuKey) {
  if (response?.status !== 200 && response?.status !== 201) return "";
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const id = data.id == null ? "" : String(data.id).trim();
  if (!id) return "";
  if (data.sku != null && String(data.sku).trim() && giniSkuKey(data.sku) !== skuKey) return "";
  return id;
}

async function loadProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  return Product.findById(productId).lean();
}

async function ownersForSku(skuKey) {
  if (!skuKey) return [];
  const owners = [];
  const cursor = Product.find({ itemCode: { $type: "string", $ne: "" } }).select("_id itemCode").lean().cursor();
  try {
    for await (const doc of cursor) {
      if (giniSkuKey(doc.itemCode) === skuKey) owners.push(String(doc._id));
    }
  } finally {
    await cursor.close();
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
  if (live.connectionRequired) return { blockers: ["connection_required"], category: null, subcategory: null };
  return mappingFromTree(saved, live.categories);
}

async function requireMerchant() {
  const config = await resolveGiniConfig();
  if (config.secretUnreadable) fail("secret_unreadable", 409);
  if (!config.baseUrl || !config.clientId || !config.hasSecret) fail("connection_required", 409);
  const merchant = assessGiniMerchantIdentity(config);
  if (!merchant.matches) fail("merchant_not_confirmed", 409);
  return merchant;
}

function blockedPreview(productId, sku, code, extra = {}) {
  return {
    ok: false,
    readOnly: true,
    canCreate: false,
    productCount: 1,
    productId: String(productId || ""),
    sku: String(sku || ""),
    previewToken: "",
    expiresAt: null,
    code,
    message: blockerMessage(code),
    blockers: [code],
    writesEnabled: false,
    existingWriteGatesEnabled: existingGiniWriteGatesEnabled(),
    sentToGini: 0,
    merchant: extra.merchant || null,
    remote: extra.remote || null,
    payloadPreview: extra.payloadPreview || null,
  };
}

async function inspectCandidate(productId, requestedSku) {
  const doc = await loadProduct(productId);
  if (!doc) fail("product_not_found", 404);
  const sku = normalizeGiniItemCode(doc.itemCode);
  const productIdText = String(doc._id);
  if (!sku || normalizeGiniItemCode(requestedSku) !== sku || String(productId) !== productIdText) {
    fail("sku_identity_conflict", 409);
  }
  const skuKey = giniSkuKey(sku);
  if (isGiniHistoricalHoldSku(sku)) {
    return { held: true, doc, sku, skuKey, productId: productIdText };
  }
  const merchant = await requireMerchant();
  const resolved = toResolvedProduct(doc);
  const rules = await Commission.find({ partner: "gini", isActive: { $ne: false } }).lean();
  const priced = partnerPricePreview(doc, rules);
  const owners = await ownersForSku(skuKey);
  const mapping = await readLiveMapping(doc);
  const eligibility = evaluatePlatformEligibility(doc, await loadEligibilityContext("gini"));
  const found = await findExistingGiniProduct(sku);
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced,
    duplicateProductIds: owners,
    mapping,
    existing: found,
  });
  const remote = remoteDecision(found);
  const inactive =
    resolved?.isActive === false ||
    (eligibility.reasons || []).some((reason) => reason.code !== "taxonomy_config_missing");
  return {
    held: false,
    doc,
    sku,
    skuKey,
    productId: productIdText,
    merchant,
    plan,
    remote,
    inactive,
    payloadHash: giniPayloadHash(plan.payloadPreview),
  };
}

function readyToCreate(inspection) {
  return (
    inspection.held !== true &&
    inspection.inactive !== true &&
    inspection.remote?.ok === true &&
    inspection.plan?.action === "CREATE" &&
    inspection.plan?.lookupState === "absent" &&
    Array.isArray(inspection.plan?.blockers) &&
    inspection.plan.blockers.length === 0 &&
    Boolean(inspection.payloadHash)
  );
}

export async function previewGiniSkuCreate({ sku, productId } = {}) {
  const inspection = await inspectCandidate(productId, sku);
  if (inspection.held) return blockedPreview(inspection.productId, inspection.sku, "historical_sku_hold");
  if (!readyToCreate(inspection)) {
    const code = inspection.inactive
      ? "product_inactive"
      : inspection.remote?.ok
        ? inspection.plan?.blockers?.[0] || "gini_lookup_failed"
        : inspection.remote?.code || "gini_lookup_failed";
    return blockedPreview(inspection.productId, inspection.sku, code, {
      merchant: inspection.merchant,
      remote: { code: inspection.remote?.code || "", giniProductId: inspection.remote?.giniProductId || "" },
      payloadPreview: inspection.plan?.payloadPreview || null,
    });
  }
  if (!(await giniSkuCreatePreviewIndexesEnforced())) fail("sku_create_preview_indexes_unavailable", 409);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await GiniSkuCreatePreview.create({
    token,
    productId: inspection.productId,
    sku: inspection.sku,
    skuKey: inspection.skuKey,
    payloadHash: inspection.payloadHash,
    merchantHost: inspection.merchant.host,
    clientMask: inspection.merchant.clientMask,
    productCount: 1,
    expiresAt,
  });
  return {
    ok: true,
    readOnly: true,
    canCreate: true,
    productCount: 1,
    productId: inspection.productId,
    sku: inspection.sku,
    previewToken: token,
    expiresAt,
    code: "",
    message: "Read-only preview for exactly one product. No GINI product was created.",
    blockers: [],
    writesEnabled: giniSkuCreateWritesEnabled(),
    existingWriteGatesEnabled: existingGiniWriteGatesEnabled(),
    sentToGini: 0,
    merchant: inspection.merchant,
    remote: { code: "verified_missing", giniProductId: "" },
    payloadPreview: inspection.plan.payloadPreview,
    giniPrice: inspection.plan.giniPrice,
    quantity: inspection.plan.quantity,
  };
}

async function markUncertain(attempt, code, httpStatus = 0, giniProductId = "") {
  await GiniSkuCreateAttempt.updateOne(
    { _id: attempt._id, status: "in_progress" },
    { $set: { status: "uncertain", errorCode: code, httpStatus: Number(httpStatus) || 0, giniProductId: String(giniProductId || "") } }
  );
  fail(code, 409);
}

export async function sendGiniSkuCreate({ sku, productId, confirm = false, previewToken = "", expectedCount } = {}) {
  if (confirm !== true) fail("confirm_required", 400);
  if (expectedCount !== 1) fail("expected_count_required", 400);
  if (!giniSkuCreateWritesEnabled()) fail("sku_create_writes_disabled", 409);
  if (existingGiniWriteGatesEnabled()) fail("existing_write_gates_must_stay_off", 409);
  if (!(await giniSkuCreateAttemptIndexesEnforced())) fail("sku_create_indexes_unavailable", 409);
  if (!(await giniSkuCreatePreviewIndexesEnforced())) fail("sku_create_preview_indexes_unavailable", 409);

  const inspection = await inspectCandidate(productId, sku);
  if (inspection.held) fail("historical_sku_hold", 409);
  if (!readyToCreate(inspection)) {
    fail(inspection.inactive ? "product_inactive" : inspection.remote?.code || inspection.plan?.blockers?.[0] || "gini_lookup_failed", 409);
  }
  const priorSend = await GiniSyncSendState.findOne({
    partner: "gini",
    $or: [{ skuKey: inspection.skuKey }, { productId: inspection.productId }],
  }).lean();
  if (priorSend?.giniProductId) fail("confirmed_send_exists", 409);
  const priorAttempt = await GiniSkuCreateAttempt.findOne({
    $or: [{ skuKey: inspection.skuKey }, { productId: inspection.productId }],
  }).lean();
  if (priorAttempt?.status === "confirmed") fail("confirmed_send_exists", 409);
  if (priorAttempt?.status === "uncertain") fail("sku_create_uncertain", 409);
  if (priorAttempt?.status === "in_progress") fail("sku_create_in_progress", 409);

  const token = String(previewToken || "").trim();
  const preview = await GiniSkuCreatePreview.findOne({ token }).lean();
  if (!preview || preview.consumedAt) fail("preview_required", 409);
  if (new Date(preview.expiresAt).getTime() <= Date.now()) fail("preview_expired", 409);
  if (preview.productCount !== 1 || preview.productId !== inspection.productId || preview.sku !== inspection.sku) {
    fail("preview_mismatch", 409);
  }
  if (preview.payloadHash !== inspection.payloadHash) fail("stale_preview", 409);
  if (preview.merchantHost !== inspection.merchant.host || preview.clientMask !== inspection.merchant.clientMask) {
    fail("merchant_not_confirmed", 409);
  }

  const images = inspection.plan.payloadPreview?.images || [];
  const files = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      files.push(await downloadGiniProductImage(images[index].url, index));
    }
  } catch (err) {
    fail(err?.code || "invalid_image", 409);
  }

  if (!giniSkuCreateWritesEnabled()) fail("sku_create_writes_disabled", 409);
  if (existingGiniWriteGatesEnabled()) fail("existing_write_gates_must_stay_off", 409);
  const merchantNow = await requireMerchant();
  if (merchantNow.host !== preview.merchantHost || merchantNow.clientMask !== preview.clientMask) fail("merchant_not_confirmed", 409);
  const immediate = remoteDecision(await findExistingGiniProduct(inspection.sku));
  if (!immediate.ok) fail(immediate.code, 409);

  if (!(await giniSkuCreatePreviewIndexesEnforced())) fail("sku_create_preview_indexes_unavailable", 409);
  const claimed = await GiniSkuCreatePreview.findOneAndUpdate(
    {
      token,
      productId: inspection.productId,
      sku: inspection.sku,
      productCount: 1,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!claimed) fail("preview_required", 409);
  if (!(await giniSkuCreateAttemptIndexesEnforced())) fail("sku_create_indexes_unavailable", 409);

  let attempt;
  try {
    attempt = await GiniSkuCreateAttempt.create({
      skuKey: inspection.skuKey,
      productId: inspection.productId,
      sku: inspection.sku,
      status: "in_progress",
      previewToken: token,
      payloadHash: inspection.payloadHash,
    });
  } catch (err) {
    if (err?.code === 11000) fail("sku_create_in_progress", 409);
    throw err;
  }

  let response;
  try {
    response = await performGiniRequest({
      method: "POST",
      path: GINI_PRODUCTS_PATH,
      form: buildGiniCreateForm(inspection.plan.payloadPreview, files),
    });
  } catch {
    await markUncertain(attempt, "sku_create_uncertain", 0);
  }

  const createdId = createdIdentity(response, inspection.skuKey);
  if (!createdId) {
    await markUncertain(attempt, response?.status ? "gini_create_failed" : "sku_create_uncertain", response?.status || 0);
  }

  let live;
  try {
    live = await findExistingGiniProduct(inspection.sku);
  } catch {
    live = { error: true };
  }
  const liveMatches =
    live?.exists === true && String(live.giniProductId) === createdId && giniSkuKey(live.sku) === inspection.skuKey;
  if (!liveMatches) await markUncertain(attempt, "sku_create_uncertain", response.status, createdId);

  try {
    await GiniSyncSendState.create({
      partner: "gini",
      productId: inspection.productId,
      sku: inspection.sku,
      skuKey: inspection.skuKey,
      giniProductId: createdId,
      originalGiniProductId: createdId,
      payloadHash: inspection.payloadHash,
      createPayloadHash: inspection.payloadHash,
      jobId: String(attempt._id),
      confirmedAt: new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) await markUncertain(attempt, "confirmed_send_exists", response.status, createdId);
    throw err;
  }
  await GiniSkuCreateAttempt.updateOne(
    { _id: attempt._id },
    { $set: { status: "confirmed", giniProductId: createdId, httpStatus: response.status, errorCode: "" } }
  );
  return {
    ok: true,
    sentToGini: 1,
    productCount: 1,
    productId: inspection.productId,
    sku: inspection.sku,
    giniProductId: createdId,
    httpStatus: response.status,
    code: "",
    message: "GINI product created and confirmed by a matching live read.",
  };
}
