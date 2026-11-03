import mongoose from "mongoose";
import { GiniChangedPreviewSnapshot } from "../models/GiniChangedPreviewSnapshot.js";
import { GiniProductUpdateAudit } from "../models/GiniProductUpdateAudit.js";
import { GiniProductUpdateJob } from "../models/GiniProductUpdateJob.js";
import { GiniProductUpdateLock } from "../models/GiniProductUpdateLock.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { Product } from "../models/Product.js";
import { GiniUpdateError } from "./giniProductUpdate.js";
import { downloadGiniProductImage } from "./giniSyncOne.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";
import { isUnresolvedHistoricalGiniSku } from "../utils/giniSyncEvaluate.js";
import { giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import {
  classifyGiniImageReplacement,
  giniChangedPreviewSignature,
  giniImageReplacementIsolation,
  giniImageWritesEnabled,
  giniProductUpdatePath,
  GINI_IMAGE_LIMIT,
} from "../utils/giniProductUpdateContract.js";
import { getGiniConnectionPublic, GINI_SECRET_UNREADABLE_MESSAGE, performGiniRequest } from "./giniConnection.js";
import { rebuildGiniChangedPayload } from "./giniSyncAll.js";
import { confirmedFieldsForSend } from "../utils/giniConfirmedFields.js";

const ACTIVE_CREATE = ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"];
const HOLDING = ["pending_verification", "uncertain", "rate_limited"];

export { giniImageWritesEnabled };

function fail(message, code, status = 409) {
  throw new GiniUpdateError(message, { status, code });
}

function safeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function exactUrl(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url) || /\s/.test(url)) return "";
  return url;
}

function sameImageList(left, right) {
  const first = (left || []).map((url) => String(url));
  const second = (right || []).map((url) => String(url));
  return first.length === second.length && first.every((url, index) => url === second[index]);
}

export function buildGiniImageReplacementForm({ deleteImageUrl, file } = {}) {
  const url = exactUrl(deleteImageUrl);
  if (!url) fail("Choose the exact image URL returned by GINI.", "image_url_required", 400);
  if (!file?.blob) fail("Choose one replacement image file.", "image_file_required", 400);
  const form = new FormData();
  form.append("_method", "PUT");
  form.append("delete_images[]", url);
  form.append("images[]", file.blob, file.filename || "image.jpg");
  return form;
}

async function confirmImageHash(state, audit) {
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

async function acquire(skuKey, jobId) {
  const existing = await GiniProductUpdateLock.findOne({ skuKey });
  if (existing) {
    const other = await GiniProductUpdateJob.findById(existing.jobId);
    if (other && ["running", "paused"].includes(other.status)) {
      fail("A GINI update is already running.", "update_in_progress", 409);
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

async function release(jobId) {
  const fresh = await GiniProductUpdateJob.findById(jobId).select("status").lean();
  if (!fresh || !["running", "paused"].includes(fresh.status)) {
    await GiniProductUpdateLock.deleteOne({ jobId: String(jobId) });
  }
}

async function readLive(sku) {
  let found;
  try {
    found = await findExistingGiniProduct(sku);
  } catch (err) {
    return { state: "uncertain", message: safeText(err?.message) };
  }
  if (found?.failure === "auth") return { state: "auth", message: "GINI rejected the product lookup." };
  if (found?.failure === "rate_limited") return { state: "rate_limited", retryAfter: found.retryAfter };
  if (found?.failure === "edge") return { state: "edge" };
  if (found?.error) return { state: "uncertain" };
  if (found?.exists === false) return { state: "missing" };
  if (!found?.exists || !found.giniProductId) return { state: "uncertain" };
  return {
    state: "found",
    giniProductId: String(found.giniProductId),
    sku: String(found.sku || ""),
    images: Array.isArray(found.images) ? found.images.map((url) => String(url)) : [],
  };
}

function publicResult(job, extras = {}) {
  return {
    ok: Boolean(extras.ok),
    sentToGini: Number(extras.sentToGini) || 0,
    method: "POST",
    signedBody: "",
    formMethod: "PUT",
    sku: extras.sku || job?.sku || "",
    giniProductId: extras.giniProductId || "",
    deleteImageUrl: extras.deleteImageUrl || "",
    httpStatus: Number(extras.httpStatus) || 0,
    code: extras.code || "",
    message: extras.message || "",
    pendingVerification: Boolean(extras.pendingVerification),
    imageWritesEnabled: giniImageWritesEnabled(),
  };
}

async function loadImagePreview(job, deleteImageUrl, replacementImageUrl) {
  if (!mongoose.isValidObjectId(String(job.previewId || ""))) fail("Finish Changed Preview before replacing an image.", "preview_required", 409);
  const snapshot = await GiniChangedPreviewSnapshot.findById(job.previewId).lean();
  if (!snapshot || snapshot.partner !== "gini") fail("Finish Changed Preview before replacing an image.", "preview_required", 409);
  if (!snapshot.expiresAt || new Date(snapshot.expiresAt).getTime() <= Date.now()) {
    fail("This Changed Preview expired. Run it again.", "preview_stale", 409);
  }
  if (!job.previewSignature || job.previewSignature !== snapshot.signature) {
    fail("This Changed Preview does not match the stored preview.", "preview_mismatch", 409);
  }
  if (giniChangedPreviewSignature(snapshot.rows) !== snapshot.signature) {
    fail("The stored Changed Preview is not intact.", "preview_stale", 409);
  }
  const skuKey = giniSkuKey(job.sku);
  const row = (snapshot.rows || []).find((item) => giniSkuKey(item.sku) === skuKey);
  if (!row || row.identityMatched !== true || row.imageSelectionRequired !== true) {
    fail("Choose a product whose image change still needs an operator selection.", "image_selection_required", 409);
  }
  if (!(row.remoteImages || []).includes(deleteImageUrl) || !(row.sourceImages || []).includes(replacementImageUrl)) {
    fail("The selected images are not the pair shown in this Changed Preview.", "image_selection_mismatch", 409);
  }
  const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey, productId: row.productId });
  if (!state?.giniProductId || String(state.payloadHash) !== String(row.savedHash)) {
    fail("The confirmed GINI record changed. Run Changed Preview again.", "payload_hash_mismatch", 409);
  }
  if (String(state.giniProductId) !== String(row.giniProductId)) {
    fail("The saved GINI id does not match this preview.", "confirmed_send_id_mismatch", 409);
  }
  const doc = mongoose.isValidObjectId(row.productId) ? await Product.findById(row.productId).lean() : null;
  if (!doc) fail("The BrownStore product for this SKU was not found.", "not_update_eligible", 409);
  const rebuilt = await rebuildGiniChangedPayload(row.productId);
  if (!rebuilt?.payload || rebuilt.hash !== String(row.currentHash || "")) {
    fail("The BrownStore product changed after Changed Preview. Run it again.", "preview_stale", 409);
  }
  const sourceImages = (rebuilt.payload.images || []).map((image) => (typeof image === "string" ? image : image?.url || "")).filter(Boolean);
  if (!sourceImages.includes(replacementImageUrl) || row.imageSelectionRequired !== true) {
    fail("The selected image no longer matches this Changed Preview. Run it again.", "preview_stale", 409);
  }
  const confirmed = await confirmedFieldsForSend(state);
  const isolation = giniImageReplacementIsolation({
    savedHash: state.payloadHash,
    currentPayload: rebuilt.payload,
    savedPrice: confirmed?.giniPrice,
    savedQuantity: confirmed?.quantity,
    savedImageUrls: null,
  });
  if (isolation.block) {
    fail("Price, quantity, or another unsynced field still differs. Image replacement was not sent, and the confirmed payload hash was kept.", isolation.code || "unrelated_field_unsynced", 409);
  }
  return { row, state, doc, path: giniProductUpdatePath(job.sku), isolation, rebuilt };
}

export async function startGiniImageReplacement({
  confirm = false,
  previewId = "",
  previewSignature = "",
  sku = "",
  deleteImageUrl = "",
  replacementImageUrl = "",
  scope = "",
  skus = null,
  all = false,
} = {}) {
  if (scope || skus || all === true || Array.isArray(deleteImageUrl) || Array.isArray(replacementImageUrl)) {
    fail("Replace one image on one product.", "single_image_required", 400);
  }
  if (confirm !== true) fail("Confirm the one-image replacement after Changed Preview.", "confirm_required", 400);
  if (!giniImageWritesEnabled()) fail("GINI image writes are disabled.", "image_writes_disabled", 409);
  const normalized = normalizeGiniItemCode(sku);
  const target = exactUrl(deleteImageUrl);
  const source = exactUrl(replacementImageUrl);
  if (!normalized || isUnresolvedHistoricalGiniSku(normalized)) {
    fail("This SKU cannot receive an image replacement.", isUnresolvedHistoricalGiniSku(normalized) ? "historical_sku_unresolved" : "invalid_sku", 409);
  }
  if (!target || !source) fail("Select one live GINI image and one BrownStore replacement.", "single_image_required", 400);
  const connection = await getGiniConnectionPublic();
  if (connection.secretUnreadable) fail(GINI_SECRET_UNREADABLE_MESSAGE, "secret_unreadable", 409);
  if (connection.status !== "connected") fail("Connect GINI API first.", "connection_required", 409);
  const activeCreate = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_CREATE } }).select("_id").lean();
  if (activeCreate) fail("A GINI create sync is active. Stop it before replacing an image.", "sync_active", 409);
  const skuKey = giniSkuKey(normalized);
  const holding = await GiniProductUpdateAudit.findOne({
    partner: "gini",
    skuKey,
    requestSent: true,
    status: { $in: HOLDING },
  }).sort({ createdAt: -1 });
  const rateLimitExpired =
    holding?.status === "rate_limited" && holding.retryUntil && new Date(holding.retryUntil).getTime() <= Date.now();
  if (holding && !rateLimitExpired) {
    fail(
      holding.kind === "image_replacement"
        ? "An earlier image upload is still unverified. Reconcile it before sending another file."
        : "Another GINI update for this SKU is still unverified.",
      holding.status === "rate_limited" ? "rate_limited" : holding.kind === "image_replacement" ? "image_pending_verification" : "update_uncertain",
      holding.status === "rate_limited" ? 429 : 409
    );
  }
  const job = await GiniProductUpdateJob.create({
    partner: "gini",
    kind: "image_replacement",
    status: "running",
    sku: normalized,
    skuKey,
    previewId: String(previewId || ""),
    previewSignature: String(previewSignature || ""),
    requestSent: false,
    startedAt: new Date(),
  });
  try {
    await acquire(skuKey, job._id);
    const prepared = await loadImagePreview(job, target, source);
    const live = await readLive(normalized);
    if (live.state === "auth") fail("GINI rejected the product lookup.", "auth_failed", 401);
    if (live.state === "rate_limited") fail("GINI rate limited the product lookup.", "rate_limited", 429);
    if (live.state === "edge") fail("GINI edge blocked the product lookup.", "gini_edge_blocked", 403);
    if (live.state === "missing") fail("The live GINI product was not found. Nothing was uploaded.", "confirmed_send_missing", 409);
    if (live.state !== "found" || live.giniProductId !== String(prepared.state.giniProductId) || giniSkuKey(live.sku) !== skuKey) {
      fail("The live GINI id or SKU does not match the saved product. Nothing was uploaded.", "confirmed_send_id_mismatch", 409);
    }
    if (!sameImageList(live.images, prepared.row.remoteImages)) {
      fail("The live GINI image list changed after Changed Preview. Run it again. Nothing was uploaded.", "remote_image_conflict", 409);
    }
    if (live.images.length > GINI_IMAGE_LIMIT || !live.images.includes(target)) {
      fail("The selected image is not one exact URL on the live product, or the product already has more than 10 images.", live.images.length > GINI_IMAGE_LIMIT ? "image_limit" : "remote_image_missing", 409);
    }
    if (live.images.filter((url) => url === target).length !== 1) {
      fail("That live image URL is ambiguous. Nothing was deleted.", "image_url_ambiguous", 409);
    }
    let file;
    try {
      file = await downloadGiniProductImage(source, 0);
    } catch (err) {
      fail(safeText(err?.message) || "The replacement image could not be downloaded.", err?.code || "invalid_image", 409);
    }
    const form = buildGiniImageReplacementForm({ deleteImageUrl: target, file });
    const claimed = await GiniProductUpdateJob.updateOne(
      { _id: job._id, status: "running", requestSent: false },
      { $set: { requestSent: true, sentToGini: 1, productId: String(prepared.doc._id), giniProductId: prepared.state.giniProductId } }
    );
    if (!claimed.matchedCount) fail("The image replacement was stopped before it was sent.", "stopped", 409);
    const audit = await GiniProductUpdateAudit.create({
      partner: "gini",
      kind: "image_replacement",
      jobId: String(job._id),
      productId: String(prepared.doc._id),
      sku: normalized,
      skuKey,
      giniProductId: String(prepared.state.giniProductId),
      createJobId: String(prepared.state.jobId || ""),
      method: "POST",
      path: prepared.path,
      contentType: "multipart/form-data",
      body: { _method: "PUT", "delete_images[]": target, "images[]": file.filename },
      previousPayloadHash: prepared.state.payloadHash,
      nextPayloadHash: prepared.isolation.confirmHash ? prepared.isolation.nextHash : "",
      previousRemoteImages: live.images,
      deleteImageUrl: target,
      replacementImageUrl: source,
      status: "pending",
      requestSent: true,
    });
    let response;
    try {
      response = await performGiniRequest({ method: "POST", path: prepared.path, form });
    } catch (err) {
      response = { status: err?.name === "AbortError" ? 504 : 502, safeErrorMessage: safeText(err?.message), lost: true };
    }
    const after = await readLive(normalized);
    const outcome = after.state === "found" ? classifyGiniImageReplacement({ previousImages: live.images, deleteUrl: target, liveImages: after.images }) : { state: "uncertain" };
    return finishImageAttempt({ job, audit, prepared, response, outcome, after });
  } catch (err) {
    const fresh = await GiniProductUpdateJob.findById(job._id);
    if (fresh && fresh.status === "running" && !fresh.requestSent) {
      await GiniProductUpdateJob.updateOne(
        { _id: job._id },
        { $set: { status: "failed", finishedAt: new Date(), errorCode: err?.code || "gini_update_error", errorMessage: safeText(err?.message) } }
      );
    }
    throw err;
  } finally {
    await release(job._id);
  }
}

async function finishImageAttempt({ job, audit, prepared, response, outcome, after }) {
  const status = Number(response?.status) || 0;
  const lost = Boolean(response?.lost) || !status || status >= 500;
  const matchedIdentity = status === 200 && after.state === "found" && after.giniProductId === String(prepared.state.giniProductId) && giniSkuKey(after.sku) === prepared.state.skuKey;
  let nextStatus = "uncertain";
  let code = "image_uncertain";
  let ok = false;
  let pendingVerification = false;
  if (status === 401 || (status === 403 && !response?.edgeBlocked)) {
    nextStatus = "auth_failed";
    code = "auth_failed";
  } else if (response?.edgeBlocked) {
    nextStatus = "edge_blocked";
    code = "gini_edge_blocked";
  } else if (status === 429) {
    nextStatus = "rate_limited";
    code = "rate_limited";
  } else if (status === 422) {
    nextStatus = "failed";
    code = "update_rejected";
  } else if (matchedIdentity && outcome.state === "verified" && prepared.isolation.confirmHash) {
    const stored = await confirmImageHash(prepared.state, audit);
    nextStatus = stored ? "reconciled_applied" : "uncertain";
    code = stored ? "" : "hash_not_stored";
    ok = stored;
  } else if (matchedIdentity && outcome.state === "verified") {
    nextStatus = "reconciled_applied";
    code = "image_verified_hash_kept";
    ok = true;
  } else if (outcome.state === "uncertain") {
    nextStatus = "uncertain";
    code = "image_uncertain";
  } else {
    nextStatus = "pending_verification";
    code = "image_pending_verification";
    pendingVerification = true;
  }
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id },
    {
      $set: {
        status: nextStatus,
        httpStatus: status,
        errorCode: code,
        errorMessage: safeText(response?.safeErrorMessage),
        requestId: response?.requestId || "",
        retryAfter: response?.retryAfter ?? null,
        retryUntil: status === 429 && Number(response?.retryAfter) >= 0 ? new Date(Date.now() + Number(response.retryAfter) * 1000) : null,
      },
    }
  );
  await GiniProductUpdateJob.updateOne(
    { _id: job._id },
    { $set: { status: ok ? "completed" : nextStatus, finishedAt: new Date(), httpStatus: status, errorCode: code, errorMessage: safeText(response?.safeErrorMessage) } }
  );
  return publicResult(job, {
    ok,
    sentToGini: 1,
    sku: prepared.state.sku,
    giniProductId: prepared.state.giniProductId,
    deleteImageUrl: audit.deleteImageUrl,
    httpStatus: status,
    code,
    pendingVerification,
    message: ok
      ? prepared.isolation.confirmHash
        ? "The live image list shows the selected image was replaced. No second upload was sent."
        : "The live image list shows the replacement. The confirmed payload hash was kept because price, quantity, and other fields were not updated."
      : "The image upload was not repeated. An unchanged image list does not unlock another upload.",
  });
}

export async function reconcileGiniImageReplacement({ confirm = false, sku = "" } = {}) {
  if (confirm !== true) fail("Confirm the image reconciliation.", "confirm_required", 400);
  const normalized = normalizeGiniItemCode(sku);
  const skuKey = giniSkuKey(normalized);
  if (!skuKey) fail("Choose one SKU to reconcile.", "invalid_sku", 400);
  const audit = await GiniProductUpdateAudit.findOne({
    partner: "gini",
    skuKey,
    kind: "image_replacement",
    requestSent: true,
    status: { $in: ["pending_verification", "uncertain"] },
  }).sort({ createdAt: -1 });
  if (!audit) {
    return publicResult(null, { ok: false, sku: normalized, code: "image_reconcile_not_needed", message: "No unverified image upload is waiting for this SKU." });
  }
  const live = await readLive(normalized);
  if (live.state !== "found" || live.giniProductId !== String(audit.giniProductId) || giniSkuKey(live.sku) !== skuKey) {
    await GiniProductUpdateAudit.updateOne({ _id: audit._id }, { $set: { status: "uncertain", errorCode: "image_uncertain" } });
    return publicResult(null, { ok: false, sentToGini: 0, sku: normalized, code: "image_uncertain", message: "The live product could not be matched. No upload was sent." });
  }
  const outcome = classifyGiniImageReplacement({
    previousImages: audit.previousRemoteImages,
    deleteUrl: audit.deleteImageUrl,
    liveImages: live.images,
  });
  await rememberImageRead(audit, outcome.state);
  if (outcome.state === "verified") {
    const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey, giniProductId: audit.giniProductId });
    const rebuilt = state ? await rebuildGiniChangedPayload(state.productId) : null;
    const confirmed = state ? await confirmedFieldsForSend(state) : null;
    const isolation = rebuilt
      ? giniImageReplacementIsolation({
          savedHash: state.payloadHash,
          currentPayload: rebuilt.payload,
          savedPrice: confirmed?.giniPrice,
          savedQuantity: confirmed?.quantity,
          savedImageUrls: null,
        })
      : { confirmHash: false };
    const stored = isolation.confirmHash && state ? await confirmImageHash(state, { ...audit, nextPayloadHash: isolation.nextHash }) : false;
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "reconciled_applied", errorCode: stored ? "" : "image_verified_hash_kept" } }
    );
    return publicResult(null, {
      ok: true,
      sentToGini: 0,
      sku: normalized,
      giniProductId: audit.giniProductId,
      code: stored ? "" : "image_verified_hash_kept",
      message: stored
        ? "The live image list now confirms the replacement. No second upload was sent."
        : "The live image list now confirms the replacement. The confirmed payload hash was kept.",
    });
  }
  const nextStatus = outcome.state === "uncertain" ? "uncertain" : audit.status === "uncertain" ? "uncertain" : "pending_verification";
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id },
    { $set: { status: nextStatus, errorCode: nextStatus === "uncertain" ? "image_uncertain" : "image_pending_verification" } }
  );
  return publicResult(null, {
    ok: false,
    sentToGini: 0,
    sku: normalized,
    code: nextStatus === "uncertain" ? "image_uncertain" : "image_pending_verification",
    pendingVerification: nextStatus === "pending_verification",
    message: "The original image list does not prove the upload failed. No second upload was sent.",
  });
}

async function rememberImageRead(audit, state) {
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id },
    {
      $set: { lastReconcileState: String(state || "") },
      $inc: { reconcileReads: 1 },
      $push: { reconcileHistory: String(state || "") },
    }
  );
}

export async function resolveGiniImageReplacement({
  confirm = false,
  sku = "",
  resolution = "",
  acknowledgeDelay = false,
} = {}) {
  if (confirm !== true || acknowledgeDelay !== true || resolution !== "not_applied") {
    fail("Confirm that the image list is still unchanged and that this does not upload another file.", "confirm_required", 400);
  }
  const normalized = normalizeGiniItemCode(sku);
  const skuKey = giniSkuKey(normalized);
  if (!skuKey) fail("Choose one SKU to resolve.", "invalid_sku", 400);
  const audit = await GiniProductUpdateAudit.findOne({
    partner: "gini",
    skuKey,
    kind: "image_replacement",
    requestSent: true,
    status: { $in: ["pending_verification", "uncertain"] },
  }).sort({ createdAt: -1 });
  if (!audit) {
    return publicResult(null, { ok: false, sku: normalized, code: "image_reconcile_not_needed", message: "No unverified image upload is waiting for this SKU." });
  }
  const live = await readLive(normalized);
  if (live.state !== "found" || live.giniProductId !== String(audit.giniProductId) || giniSkuKey(live.sku) !== skuKey || !sameImageList(live.images, audit.previousRemoteImages)) {
    await rememberImageRead(audit, "manual_rejected");
    return publicResult(null, {
      ok: false,
      sentToGini: 0,
      sku: normalized,
      code: "image_pending_verification",
      pendingVerification: true,
      message: "The live image list is not the original list, so the upload stays locked.",
    });
  }
  await rememberImageRead(audit, "manual_not_applied");
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id, status: { $in: ["pending_verification", "uncertain"] } },
    { $set: { status: "manually_resolved_not_applied", errorCode: "image_manually_resolved" } }
  );
  return publicResult(null, {
    ok: false,
    sentToGini: 0,
    sku: normalized,
    code: "image_manually_resolved",
    message: "The unchanged image list was recorded by hand. No file was uploaded. A later explicit replacement can be sent once.",
  });
}
