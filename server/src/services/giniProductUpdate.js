import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniChangedPreviewSnapshot } from "../models/GiniChangedPreviewSnapshot.js";
import { GiniProductUpdateAudit } from "../models/GiniProductUpdateAudit.js";
import { GiniProductUpdateJob } from "../models/GiniProductUpdateJob.js";
import { GiniProductUpdateLock } from "../models/GiniProductUpdateLock.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility, productScopeIds } from "../utils/platformEligibility.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import { buildGiniPlanFromParts, isUnresolvedHistoricalGiniSku, mappingFromTree } from "../utils/giniSyncEvaluate.js";
import { giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import { loadProtectedVariantSkuKeys } from "../utils/giniVariantGuard.js";
import { confirmedFieldsForSend } from "../utils/giniConfirmedFields.js";
import {
  explainGiniPriceQuantityChange,
  giniChangedPreviewSignature,
  giniPartialUpdateBody,
  giniProductUpdatePath,
  GINI_PRODUCT_UPDATE_CONTENT_TYPE,
  GINI_PRODUCT_UPDATE_METHOD,
  sameUpdateChanges,
} from "../utils/giniProductUpdateContract.js";
import {
  fetchGiniCategoryTree,
  getGiniConnectionPublic,
  GINI_SECRET_UNREADABLE_MESSAGE,
  GiniConnectionError,
  performGiniJsonRequest,
  performGiniRequest,
} from "./giniConnection.js";

const ACTIVE_CREATE = ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"];
const OPEN_AUDIT = ["pending", "uncertain", "rate_limited"];

let beforeSend = null;

export class GiniUpdateError extends Error {
  constructor(message, { status = 400, code = "gini_update_error" } = {}) {
    super(message);
    this.name = "GiniUpdateError";
    this.status = status;
    this.code = code;
  }
}

export function giniUpdateWritesEnabled() {
  return process.env.GINI_UPDATE_WRITES_ENABLED === "true" && process.env.GINI_ALLOW_LIVE_UPDATE_WRITES === "true";
}

export function setGiniUpdateBeforeSend(fn) {
  beforeSend = typeof fn === "function" ? fn : null;
}

export function resetGiniUpdateForTests() {
  beforeSend = null;
}

function safeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function fail(message, code, status = 409) {
  throw new GiniUpdateError(message, { status, code });
}

function publicJob(job) {
  if (!job) return null;
  const raw = typeof job.toObject === "function" ? job.toObject() : job;
  return {
    id: String(raw._id || ""),
    status: raw.status || "",
    sku: raw.sku || "",
    giniProductId: raw.giniProductId || "",
    requestSent: Boolean(raw.requestSent),
    sentToGini: Number(raw.sentToGini) || 0,
    httpStatus: Number(raw.httpStatus) || 0,
    errorCode: raw.errorCode || "",
    errorMessage: raw.errorMessage || "",
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    pausedAt: raw.pausedAt || null,
  };
}

function resultOf(job, extras = {}) {
  return {
    ok: Boolean(extras.ok),
    sentToGini: Number(extras.sentToGini) || 0,
    method: GINI_PRODUCT_UPDATE_METHOD,
    contentType: GINI_PRODUCT_UPDATE_CONTENT_TYPE,
    endpoint: extras.endpoint || "",
    sku: extras.sku || job?.sku || "",
    changes: extras.changes || [],
    httpStatus: Number(extras.httpStatus) || 0,
    giniProductId: extras.giniProductId || job?.giniProductId || "",
    code: extras.code || "",
    message: extras.message || "",
    reconciled: Boolean(extras.reconciled),
    updateWritesEnabled: true,
    job: publicJob(job),
  };
}

async function ownersForSku(skuKey) {
  const ids = [];
  const cursor = Product.find({ itemCode: { $type: "string", $ne: "" } }).select("_id itemCode").lean().cursor();
  for await (const doc of cursor) {
    if (giniSkuKey(doc.itemCode) === skuKey) ids.push(String(doc._id));
  }
  return ids;
}

async function readLiveProduct(sku) {
  let response;
  try {
    response = await performGiniRequest({ method: "GET", path: giniProductUpdatePath(sku) });
  } catch (err) {
    if (err instanceof GiniConnectionError) throw err;
    return { state: "uncertain", status: 0, message: safeText(err?.message) };
  }
  if (response.edgeBlocked) return { state: "edge", status: response.status, message: response.safeErrorMessage };
  if (response.status === 401 || response.status === 403) {
    return { state: "auth", status: response.status, message: response.safeErrorMessage };
  }
  if (response.status === 429) {
    return { state: "rate_limited", status: 429, retryAfter: response.retryAfter, message: response.safeErrorMessage };
  }
  if (response.status === 404) return { state: "missing", status: 404, message: response.safeErrorMessage };
  const data = response.json?.data;
  if (response.status !== 200 || !data || typeof data !== "object" || Array.isArray(data)) {
    return { state: "uncertain", status: response.status || 0, message: response.safeErrorMessage };
  }
  return {
    state: "found",
    status: 200,
    giniProductId: data.id == null ? "" : String(data.id).trim(),
    sku: data.sku == null ? "" : String(data.sku),
    price: Number(data.price),
    quantity: Number(data.quantity),
    priceKnown: data.price != null && data.price !== "" && Number.isFinite(Number(data.price)),
    quantityKnown: data.quantity != null && data.quantity !== "" && Number.isFinite(Number(data.quantity)),
  };
}

function assertLiveIdentity(live, skuKey, savedId) {
  if (live.state === "auth") fail(live.message || "GINI rejected the update lookup.", "auth_failed", 401);
  if (live.state === "rate_limited") fail(live.message || "GINI rate limited the update lookup.", "rate_limited", 429);
  if (live.state === "edge") fail(live.message || "GINI edge blocked the update lookup.", "gini_edge_blocked", 403);
  if (live.state === "missing") {
    fail("The live GINI product was not found. Nothing was updated.", "confirmed_send_missing", 409);
  }
  if (live.state !== "found" || !live.giniProductId || !giniSkuKey(live.sku)) {
    fail("The live GINI product could not be confirmed. Nothing was updated.", "confirmed_send_unverified", 409);
  }
  if (giniSkuKey(live.sku) !== skuKey) {
    fail("The live GINI SKU does not match the saved SKU. Nothing was updated.", "confirmed_send_sku_mismatch", 409);
  }
  if (live.giniProductId !== String(savedId)) {
    fail("The live GINI id does not match the saved id. Nothing was updated.", "confirmed_send_id_mismatch", 409);
  }
}

function valuesMatch(live, changes, side) {
  if (live.state !== "found") return false;
  for (const change of changes || []) {
    const expected = Number(side === "new" ? change.new : change.old);
    const known = change.field === "price" ? live.priceKnown : live.quantityKnown;
    const actual = change.field === "price" ? live.price : live.quantity;
    if (!known || actual !== expected) return false;
  }
  return true;
}

function responseVerified(response, { skuKey, giniProductId, changes }) {
  if (!response || response.edgeBlocked || response.status !== 200) return false;
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const id = data.id == null ? "" : String(data.id).trim();
  if (!id || id !== String(giniProductId) || giniSkuKey(data.sku) !== skuKey) return false;
  for (const change of changes) {
    const actual = Number(data[change.field]);
    if (!Number.isFinite(actual) || actual !== Number(change.new)) return false;
  }
  return true;
}

async function confirmHash(state, audit) {
  const patch = {
    payloadHash: audit.nextPayloadHash,
    lastUpdateConfirmedAt: new Date(),
    lastUpdateAuditId: String(audit._id),
  };
  if (!state.createPayloadHash) patch.createPayloadHash = audit.previousPayloadHash;
  const updated = await GiniSyncSendState.updateOne(
    {
      _id: state._id,
      payloadHash: audit.previousPayloadHash,
      giniProductId: state.giniProductId,
      skuKey: state.skuKey,
      jobId: state.jobId,
    },
    { $set: patch }
  );
  return updated.matchedCount > 0;
}

async function confirmFieldsOnly(state, audit) {
  const updated = await GiniSyncSendState.updateOne(
    {
      _id: state._id,
      payloadHash: state.payloadHash,
      giniProductId: state.giniProductId,
      skuKey: state.skuKey,
      jobId: state.jobId,
    },
    { $set: { lastUpdateConfirmedAt: new Date(), lastUpdateAuditId: String(audit._id) } }
  );
  return updated.matchedCount > 0;
}

async function storeVerifiedUpdate(state, audit) {
  if (audit.confirmsPayloadHash === false) return confirmFieldsOnly(state, audit);
  return confirmHash(state, audit);
}

async function loadPrepared(job) {
  const sku = normalizeGiniItemCode(job.sku);
  const skuKey = giniSkuKey(sku);
  if (!sku || !skuKey) fail("Choose one SKU to update.", "invalid_sku", 400);
  if (isUnresolvedHistoricalGiniSku(sku)) {
    fail("This historical SKU is unresolved and cannot be updated.", "historical_sku_unresolved", 409);
  }
  if (!mongoose.isValidObjectId(String(job.previewId || ""))) {
    fail("Finish Changed Preview before updating.", "preview_required", 409);
  }
  const snapshot = await GiniChangedPreviewSnapshot.findById(job.previewId).lean();
  if (!snapshot || snapshot.partner !== "gini") fail("Finish Changed Preview before updating.", "preview_required", 409);
  if (!snapshot.expiresAt || new Date(snapshot.expiresAt).getTime() <= Date.now()) {
    fail("This Changed Preview expired. Run it again.", "preview_stale", 409);
  }
  if (!job.previewSignature || job.previewSignature !== snapshot.signature) {
    fail("This Changed Preview does not match the stored preview.", "preview_mismatch", 409);
  }
  if (giniChangedPreviewSignature(snapshot.rows) !== snapshot.signature) {
    fail("The stored Changed Preview is not intact.", "preview_stale", 409);
  }
  const row = (snapshot.rows || []).find((item) => giniSkuKey(item.sku) === skuKey);
  if (!row || row.classification !== "CHANGED" || row.updateEligible !== true || row.identityMatched !== true) {
    fail("This SKU is not an eligible Changed Preview update.", "not_update_eligible", 409);
  }
  if (!sameUpdateChanges(job.expectedChanges, row.updateChanges)) {
    fail("The confirmed field changes do not match this Changed Preview.", "preview_mismatch", 409);
  }

  const connection = await getGiniConnectionPublic();
  if (connection.secretUnreadable) fail(GINI_SECRET_UNREADABLE_MESSAGE, "secret_unreadable", 409);
  if (connection.status !== "connected") fail("Connect GINI API first.", "connection_required", 409);
  const activeCreate = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_CREATE } }).select("_id").lean();
  if (activeCreate) fail("A GINI create sync is active. Stop it before updating a product.", "sync_active", 409);
  const liveTree = await fetchGiniCategoryTree();
  if (liveTree.connectionRequired) fail("Connect GINI API first.", "connection_required", 409);

  const doc = mongoose.isValidObjectId(row.productId) ? await Product.findById(row.productId).lean() : null;
  if (!doc) fail("The BrownStore product for this SKU was not found.", "not_update_eligible", 409);
  const resolved = toResolvedProduct(doc);
  const [rules, eligibility, owners] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    ownersForSku(skuKey),
  ]);
  const decision = evaluatePlatformEligibility(doc, eligibility);
  const reasons = (decision.reasons || []).filter((reason) => reason.code !== "taxonomy_config_missing");
  if (!resolved || resolved.isActive === false || reasons.length) {
    fail("This product is no longer eligible for GINI. Nothing was updated.", "not_update_eligible", 409);
  }
  const collectionId = productScopeIds(doc).collection || "";
  const protectedKeys = await loadProtectedVariantSkuKeys();
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced: partnerPricePreview(doc, rules),
    duplicateProductIds: owners,
    mapping: mappingFromTree(taxonomyValuesForProduct(doc, eligibility), liveTree.categories),
    existing: null,
    protectedVariantSku: protectedKeys.has(skuKey),
  });
  const blockers = (plan.blockers || []).filter((code) => code && code !== "existing_gini_product");
  if (blockers.length || giniSkuKey(plan.sku) !== skuKey) {
    fail("This product is no longer eligible for GINI. Nothing was updated.", "not_update_eligible", 409);
  }
  const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey, productId: String(doc._id) });
  if (!state?.giniProductId || !state.payloadHash) {
    fail("The confirmed GINI send record is missing. Nothing was updated.", "not_update_eligible", 409);
  }
  if (String(state.giniProductId) !== String(row.giniProductId) || giniSkuKey(state.sku) !== skuKey) {
    fail("The saved GINI id and SKU do not match this preview. Nothing was updated.", "confirmed_send_id_mismatch", 409);
  }
  if (String(state.payloadHash) !== String(row.savedHash)) {
    fail("The confirmed payload hash changed after this preview. Run Changed Preview again.", "payload_hash_mismatch", 409);
  }
  const confirmed = await confirmedFieldsForSend(state);
  const explained = explainGiniPriceQuantityChange({
    savedHash: state.payloadHash,
    currentPayload: plan.payloadPreview,
    savedPrice: confirmed?.giniPrice,
    savedQuantity: confirmed?.quantity,
  });
  if (!explained.ok || explained.currentHash !== row.currentHash || !sameUpdateChanges(explained.changes, row.updateChanges)) {
    fail("The BrownStore payload changed after this preview. Run Changed Preview again.", "preview_stale", 409);
  }
  if (!sameUpdateChanges(explained.changes, job.expectedChanges)) {
    fail("The confirmed field changes do not match the current payload.", "preview_mismatch", 409);
  }

  const live = await readLiveProduct(sku);
  assertLiveIdentity(live, skuKey, state.giniProductId);
  const rawBody = giniPartialUpdateBody(explained.changes);
  const parsed = JSON.parse(rawBody);
  if (!Object.keys(parsed).length) fail("There is no supported field to update.", "not_update_eligible", 409);
  return {
    sku,
    skuKey,
    doc,
    state,
    explained,
    rawBody,
    parsed,
    path: giniProductUpdatePath(sku),
    giniProductId: String(state.giniProductId),
  };
}

async function markJob(jobId, patch) {
  await GiniProductUpdateJob.updateOne({ _id: jobId }, { $set: patch });
  return GiniProductUpdateJob.findById(jobId);
}

async function acquire(skuKey, jobId) {
  const existing = await GiniProductUpdateLock.findOne({ skuKey });
  if (existing) {
    const other = await GiniProductUpdateJob.findById(existing.jobId);
    if (other && ["running", "paused"].includes(other.status)) {
      fail(
        other.status === "paused"
          ? "A GINI update is paused. Resume or stop it before starting another."
          : "A GINI update is already running.",
        other.status === "paused" ? "update_paused" : "update_in_progress",
        409
      );
    }
    await GiniProductUpdateLock.deleteOne({ _id: existing._id, jobId: existing.jobId });
  }
  try {
    await GiniProductUpdateLock.create({ skuKey, jobId: String(jobId) });
  } catch (err) {
    if (err?.code === 11000) fail("A GINI update is already running.", "update_in_progress", 409);
    throw err;
  }
}

async function releaseIfIdle(jobId) {
  const fresh = await GiniProductUpdateJob.findById(jobId).select("status").lean();
  if (!fresh || !["running", "paused"].includes(fresh.status)) {
    await GiniProductUpdateLock.deleteOne({ jobId: String(jobId) });
  }
}

async function openAudit(skuKey) {
  return GiniProductUpdateAudit.findOne({ partner: "gini", skuKey, status: { $in: OPEN_AUDIT }, requestSent: true }).sort({
    createdAt: -1,
  });
}

async function settleOpenAudit(audit, live, { allowContinue }) {
  const savedId = String(audit.giniProductId || "");
  const skuKey = audit.skuKey;
  const identityOk =
    live.state === "found" && live.giniProductId === savedId && giniSkuKey(live.sku) === skuKey;
  if (identityOk && valuesMatch(live, audit.changes, "new")) {
    const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey, giniProductId: savedId });
    const stored = state ? await storeVerifiedUpdate(state, audit) : false;
    const fieldOnly = audit.confirmsPayloadHash === false;
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      { $set: { status: stored ? "reconciled_applied" : "uncertain", errorCode: stored ? (fieldOnly ? "fields_confirmed_hash_kept" : "") : "hash_not_stored" } }
    );
    return { done: true, ok: stored, reconciled: true, code: stored ? (fieldOnly ? "fields_confirmed_hash_kept" : "") : "update_uncertain" };
  }
  if (identityOk && valuesMatch(live, audit.changes, "old")) {
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "reconciled_not_applied", errorCode: "update_not_applied" } }
    );
    return allowContinue
      ? { done: false }
      : { done: true, ok: false, reconciled: true, code: "update_not_applied" };
  }
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id },
    { $set: { status: "uncertain", errorCode: "update_uncertain" } }
  );
  return { done: true, ok: false, reconciled: true, code: "update_uncertain" };
}

async function executeUpdate(job) {
  const current = await GiniProductUpdateJob.findById(job._id);
  if (!current || current.status === "stopped") {
    return resultOf(current, { ok: false, code: "stopped", message: "The GINI update was stopped before it was sent." });
  }
  if (current.status === "paused") {
    return resultOf(current, { ok: false, code: "paused", message: "The GINI update is paused. Nothing was sent." });
  }
  const prepared = await loadPrepared(current);
  const imageHold = await GiniProductUpdateAudit.findOne({
    partner: "gini",
    skuKey: prepared.skuKey,
    kind: "image_replacement",
    requestSent: true,
    status: { $in: ["pending_verification", "uncertain", "rate_limited"] },
  }).lean();
  if (imageHold) {
    fail("An image replacement for this SKU is still unverified. Reconcile it before another GINI write.", "image_pending_verification", 409);
  }
  await GiniProductUpdateJob.updateOne(
    { _id: current._id },
    { $set: { productId: String(prepared.doc._id), giniProductId: prepared.giniProductId } }
  );
  if (beforeSend) await beforeSend({ sku: prepared.sku, productId: String(prepared.doc._id) });
  const afterHook = await GiniProductUpdateJob.findById(current._id);
  if (!afterHook || afterHook.status === "stopped") {
    return resultOf(afterHook, {
      ok: false,
      sku: prepared.sku,
      code: "stopped",
      message: "The GINI update was stopped before it was sent.",
    });
  }
  if (afterHook.status === "paused") {
    return resultOf(afterHook, {
      ok: false,
      sku: prepared.sku,
      code: "paused",
      message: "The GINI update is paused. Nothing was sent.",
    });
  }

  const pending = await openAudit(prepared.skuKey);
  if (pending) {
    if (pending.status === "rate_limited" && pending.retryUntil && new Date(pending.retryUntil).getTime() > Date.now()) {
      fail("GINI rate limited this update. Wait for Retry-After before trying again.", "rate_limited", 429);
    }
    const live = await readLiveProduct(prepared.sku);
    if (live.state === "auth") fail(live.message || "GINI rejected the reconciliation lookup.", "auth_failed", 401);
    if (live.state === "rate_limited") fail(live.message || "GINI rate limited the reconciliation lookup.", "rate_limited", 429);
    const settled = await settleOpenAudit(pending, live, { allowContinue: true });
    if (settled.done) {
      const finished = await markJob(current._id, {
        status: settled.ok ? "completed" : "uncertain",
        finishedAt: new Date(),
        errorCode: settled.code || "",
        errorMessage: settled.ok
          ? "The earlier update was confirmed from the live product. No second PUT was sent."
          : "The earlier update is still uncertain. No second PUT was sent.",
      });
      return resultOf(finished, {
        ok: settled.ok,
        sentToGini: 0,
        sku: prepared.sku,
        changes: prepared.explained.changes,
        giniProductId: prepared.giniProductId,
        code: settled.code || "",
        reconciled: true,
        message: settled.ok
          ? "The earlier update was confirmed from the live GINI product. No second PUT was sent."
          : "The earlier update could not be confirmed. No second PUT was sent.",
      });
    }
  }

  const claimed = await GiniProductUpdateJob.updateOne(
    { _id: current._id, status: "running", requestSent: false },
    { $set: { requestSent: true, sentToGini: 1 } }
  );
  if (!claimed.matchedCount) {
    const fresh = await GiniProductUpdateJob.findById(current._id);
    return resultOf(fresh, {
      ok: false,
      sku: prepared.sku,
      code: fresh?.status === "stopped" ? "stopped" : "paused",
      message: "The GINI update was stopped or paused before it was sent.",
    });
  }

  const audit = await GiniProductUpdateAudit.create({
    partner: "gini",
    jobId: String(current._id),
    productId: String(prepared.doc._id),
    sku: prepared.sku,
    skuKey: prepared.skuKey,
    giniProductId: prepared.giniProductId,
    createJobId: prepared.state.jobId || "",
    method: "PUT",
    path: prepared.path,
    contentType: GINI_PRODUCT_UPDATE_CONTENT_TYPE,
    body: prepared.parsed,
    changes: prepared.explained.changes,
    previousPayloadHash: prepared.explained.previousHash,
    nextPayloadHash: prepared.explained.confirmFullHash ? prepared.explained.nextHash : "",
    confirmsPayloadHash: prepared.explained.confirmFullHash === true,
    status: "pending",
    requestSent: true,
  });

  let response = null;
  try {
    response = await performGiniJsonRequest({ method: "PUT", path: prepared.path, rawBody: prepared.rawBody });
  } catch (err) {
    const live = await readLiveProduct(prepared.sku).catch(() => ({ state: "uncertain" }));
    const settled = await settleOpenAudit(audit, live, { allowContinue: false });
    const status = settled.ok ? "completed" : "uncertain";
    const finished = await markJob(current._id, {
      status,
      finishedAt: new Date(),
      httpStatus: 0,
      errorCode: settled.ok ? "" : settled.code || err?.code || "update_timeout",
      errorMessage: safeText(err?.message),
      sentToGini: 1,
    });
    return resultOf(finished, {
      ok: settled.ok,
      sentToGini: 1,
      endpoint: prepared.path,
      sku: prepared.sku,
      changes: prepared.explained.changes,
      giniProductId: prepared.giniProductId,
      code: settled.ok ? "" : settled.code || err?.code || "update_timeout",
      reconciled: true,
      message: settled.ok
        ? "The update response was lost, and the live product matched the sent values. No second PUT was sent."
        : "The update response was lost. It was reconciled and no second PUT was sent.",
    });
  }

  if (
    responseVerified(response, {
      skuKey: prepared.skuKey,
      giniProductId: prepared.giniProductId,
      changes: prepared.explained.changes,
    })
  ) {
    const fieldOnly = prepared.explained.confirmFullHash !== true;
    const stored = await storeVerifiedUpdate(prepared.state, audit);
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      {
        $set: {
          status: stored ? "updated" : "uncertain",
          httpStatus: response.status,
          requestId: response.requestId || "",
          responseGiniProductId: String(response.json?.data?.id || ""),
          responseSku: String(response.json?.data?.sku || ""),
          errorCode: stored ? (fieldOnly ? "fields_confirmed_hash_kept" : "") : "hash_not_stored",
        },
      }
    );
    const finished = await markJob(current._id, {
      status: stored ? "completed" : "uncertain",
      finishedAt: new Date(),
      httpStatus: response.status,
      sentToGini: 1,
      errorCode: stored ? (fieldOnly ? "fields_confirmed_hash_kept" : "") : "hash_not_stored",
      errorMessage: stored ? "" : "GINI accepted the update, but the confirmed hash could not be stored.",
    });
    return resultOf(finished, {
      ok: stored,
      sentToGini: 1,
      endpoint: prepared.path,
      sku: prepared.sku,
      changes: prepared.explained.changes,
      httpStatus: response.status,
      giniProductId: prepared.giniProductId,
      code: stored ? (fieldOnly ? "fields_confirmed_hash_kept" : "") : "hash_not_stored",
      message: stored
        ? fieldOnly
          ? `Updated ${prepared.sku} with one PUT. The confirmed payload hash was kept because another field is still unsynced.`
          : `Updated ${prepared.sku} with one PUT. The new payload hash was stored after the live id matched.`
        : "GINI accepted the update, but the confirmed hash was not stored. No second PUT was sent.",
    });
  }

  if (response.status === 429) {
    const retryUntil =
      Number.isFinite(Number(response.retryAfter)) && Number(response.retryAfter) >= 0
        ? new Date(Date.now() + Number(response.retryAfter) * 1000)
        : null;
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      {
        $set: {
          status: "rate_limited",
          httpStatus: 429,
          errorCode: "rate_limited",
          errorMessage: safeText(response.safeErrorMessage),
          requestId: response.requestId || "",
          retryAfter: response.retryAfter,
          retryUntil,
        },
      }
    );
    const finished = await markJob(current._id, {
      status: "rate_limited",
      finishedAt: new Date(),
      httpStatus: 429,
      sentToGini: 1,
      errorCode: "rate_limited",
      errorMessage: safeText(response.safeErrorMessage) || "GINI rate limited the update.",
    });
    return resultOf(finished, {
      ok: false,
      sentToGini: 1,
      endpoint: prepared.path,
      sku: prepared.sku,
      changes: prepared.explained.changes,
      httpStatus: 429,
      giniProductId: prepared.giniProductId,
      code: "rate_limited",
      message: "GINI rate limited the update. No second PUT was sent.",
    });
  }

  const authFailed = response.status === 401 || (response.status === 403 && !response.edgeBlocked);
  const edge = Boolean(response.edgeBlocked);
  const lost = !response.status || response.status >= 500 || response.status === 200;
  if (!lost) {
    const code = authFailed ? "auth_failed" : edge ? "gini_edge_blocked" : "update_rejected";
    const status = authFailed ? "auth_failed" : edge ? "edge_blocked" : "failed";
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      {
        $set: {
          status,
          httpStatus: response.status,
          errorCode: code,
          errorMessage: safeText(response.safeErrorMessage),
          requestId: response.requestId || "",
        },
      }
    );
    const finished = await markJob(current._id, {
      status,
      finishedAt: new Date(),
      httpStatus: response.status,
      sentToGini: 1,
      errorCode: code,
      errorMessage: safeText(response.safeErrorMessage),
    });
    return resultOf(finished, {
      ok: false,
      sentToGini: 1,
      endpoint: prepared.path,
      sku: prepared.sku,
      changes: prepared.explained.changes,
      httpStatus: response.status,
      giniProductId: prepared.giniProductId,
      code,
      message: safeText(response.safeErrorMessage) || "GINI rejected the update. No second PUT was sent.",
    });
  }

  const live = await readLiveProduct(prepared.sku).catch(() => ({ state: "uncertain" }));
  const settled = await settleOpenAudit(audit, live, { allowContinue: false });
  const finished = await markJob(current._id, {
    status: settled.ok ? "completed" : "uncertain",
    finishedAt: new Date(),
    httpStatus: response.status,
    sentToGini: 1,
    errorCode: settled.ok ? "" : settled.code || "update_uncertain",
    errorMessage: safeText(response.safeErrorMessage),
  });
  return resultOf(finished, {
    ok: settled.ok,
    sentToGini: 1,
    endpoint: prepared.path,
    sku: prepared.sku,
    changes: prepared.explained.changes,
    httpStatus: response.status,
    giniProductId: prepared.giniProductId,
    code: settled.ok ? "" : settled.code || "update_uncertain",
    reconciled: true,
    message: settled.ok
      ? "The live product matched the sent values. No second PUT was sent."
      : "The update was not confirmed. No second PUT was sent.",
  });
}

async function runJob(job) {
  try {
    return await executeUpdate(job);
  } catch (err) {
    const fresh = await GiniProductUpdateJob.findById(job._id);
    if (fresh && fresh.status === "running" && !fresh.requestSent) {
      await markJob(job._id, {
        status: "failed",
        finishedAt: new Date(),
        errorCode: err?.code || "gini_update_error",
        errorMessage: safeText(err?.message),
      });
    }
    throw err;
  } finally {
    await releaseIfIdle(job._id);
  }
}

export async function startGiniChangedSync({
  confirm = false,
  previewId = "",
  previewSignature = "",
  sku = "",
  expectedChanges = null,
  scope = "",
  skus = null,
  all = false,
} = {}) {
  if (scope || skus || all === true) fail("Changed Sync updates one selected SKU.", "single_product_required", 400);
  if (confirm !== true) fail("Confirm the one-product update after Changed Preview.", "confirm_required", 400);
  if (!giniUpdateWritesEnabled()) {
    fail("GINI update writes are disabled.", "update_writes_disabled", 409);
  }
  const normalized = normalizeGiniItemCode(sku);
  if (!normalized) fail("Choose one SKU to update.", "invalid_sku", 400);
  if (isUnresolvedHistoricalGiniSku(normalized)) {
    fail("This historical SKU is unresolved and cannot be updated.", "historical_sku_unresolved", 409);
  }
  if (!Array.isArray(expectedChanges) || !expectedChanges.length) {
    fail("Confirm the exact changed fields before updating.", "confirm_required", 400);
  }
  const skuKey = giniSkuKey(normalized);
  const job = await GiniProductUpdateJob.create({
    partner: "gini",
    status: "running",
    sku: normalized,
    skuKey,
    previewId: String(previewId || ""),
    previewSignature: String(previewSignature || ""),
    expectedChanges,
    requestSent: false,
    startedAt: new Date(),
  });
  try {
    await acquire(skuKey, job._id);
  } catch (err) {
    await markJob(job._id, {
      status: "failed",
      finishedAt: new Date(),
      errorCode: err?.code || "update_in_progress",
      errorMessage: safeText(err?.message),
    });
    throw err;
  }
  return runJob(job);
}

export async function pauseGiniChangedSync() {
  const job = await GiniProductUpdateJob.findOne({
    partner: "gini",
    kind: { $ne: "image_replacement" },
    status: "running",
    requestSent: false,
  }).sort({
    createdAt: -1,
  });
  if (!job) {
    const sent = await GiniProductUpdateJob.findOne({
      partner: "gini",
      kind: { $ne: "image_replacement" },
      status: "running",
      requestSent: true,
    }).sort({
      createdAt: -1,
    });
    if (sent) fail("The PUT was already sent and cannot be paused.", "update_already_sent", 409);
    fail("No running GINI update to pause.", "not_running", 404);
  }
  await GiniProductUpdateJob.updateOne(
    { _id: job._id, status: "running", requestSent: false },
    { $set: { status: "paused", pausedAt: new Date() } }
  );
  const fresh = await GiniProductUpdateJob.findById(job._id);
  return resultOf(fresh, { ok: false, code: "paused", message: "The GINI update is paused. Nothing was sent." });
}

export async function resumeGiniChangedSync() {
  if (!giniUpdateWritesEnabled()) fail("GINI update writes are disabled.", "update_writes_disabled", 409);
  const job = await GiniProductUpdateJob.findOne({
    partner: "gini",
    kind: { $ne: "image_replacement" },
    status: "paused",
    requestSent: false,
  }).sort({
    createdAt: -1,
  });
  if (!job) fail("No paused GINI update to resume.", "not_paused", 404);
  const claimed = await GiniProductUpdateJob.updateOne(
    { _id: job._id, status: "paused", requestSent: false },
    { $set: { status: "running", pausedAt: null } }
  );
  if (!claimed.matchedCount) fail("No paused GINI update to resume.", "not_paused", 404);
  const fresh = await GiniProductUpdateJob.findById(job._id);
  return runJob(fresh);
}

export async function stopGiniChangedSync() {
  const job = await GiniProductUpdateJob.findOne({
    partner: "gini",
    kind: { $ne: "image_replacement" },
    status: { $in: ["running", "paused"] },
    requestSent: false,
  }).sort({ createdAt: -1 });
  if (!job) {
    const sent = await GiniProductUpdateJob.findOne({
      partner: "gini",
      kind: { $ne: "image_replacement" },
      status: { $in: ["running", "paused"] },
      requestSent: true,
    }).sort({ createdAt: -1 });
    if (sent) fail("The PUT was already sent and cannot be stopped.", "update_already_sent", 409);
    fail("No active GINI update to stop.", "not_active", 404);
  }
  await GiniProductUpdateJob.updateOne(
    { _id: job._id, requestSent: false },
    { $set: { status: "stopped", finishedAt: new Date() } }
  );
  await GiniProductUpdateLock.deleteOne({ jobId: String(job._id) });
  const fresh = await GiniProductUpdateJob.findById(job._id);
  return resultOf(fresh, { ok: false, code: "stopped", message: "The GINI update was stopped. Nothing was sent." });
}
