import { GiniVariantChangedOperation } from "../models/GiniVariantChangedOperation.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { GiniVariantPricePatch } from "../models/GiniVariantPricePatch.js";
import { getGiniConnectionPublic, performGiniJsonRequest, performGiniRequest } from "./giniConnection.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import {
  KE20_PRICE_PILOT,
  KE20_REQUIRED_HOST,
  assessKe20PriceApproval,
  assessKe20PriceOwnership,
  assessKe20PriceState,
  ke20PriceJournalBlocks,
  ke20PriceNextStage,
  ke20PriceOperationKey,
  ke20PricePatchWritesEnabled,
  ke20PriceRequest,
  ke20PriceStage,
  readKe20PriceParent,
  readKe20PriceVariants,
} from "../utils/giniVariantPricePatchPlan.js";

function parentPath() {
  return `/api/v2.0/third-party/products/${encodeURIComponent(KE20_PRICE_PILOT.parentSku)}`;
}

function readOnly(perform) {
  return async (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "GET") throw new Error("price_patch_write_blocked");
    return perform(request);
  };
}

async function readRemote(performGet) {
  const parentResponse = await performGet({ method: "GET", path: parentPath() });
  const variantResponse = await performGet({ method: "GET", path: `${parentPath()}/variants` });
  return { parent: readKe20PriceParent(parentResponse), variants: readKe20PriceVariants(variantResponse) };
}

function hostName(baseUrl) {
  try {
    return new URL(String(baseUrl || "")).hostname;
  } catch {
    return "";
  }
}

function publicResult(fields) {
  return {
    ok: false,
    canSend: false,
    sent: false,
    verified: false,
    retry: false,
    batchEnabled: false,
    liveSend: false,
    parentSku: KE20_PRICE_PILOT.parentSku,
    ...fields,
    canSend: false,
    retry: false,
    batchEnabled: false,
    liveSend: false,
  };
}

function journalView(doc) {
  if (!doc) return { status: "idle" };
  return { status: doc.status, stage: doc.stage, lastCode: doc.lastCode || "" };
}

export function mongoKe20PriceJournal() {
  return {
    async read(operationKey) {
      return GiniVariantPricePatch.findOne({ operationKey }).lean();
    },
    async claim(operationKey, fields) {
      try {
        const doc = await GiniVariantPricePatch.findOneAndUpdate(
          { operationKey, status: { $nin: ["in_progress", "uncertain", "verified", "rejected"] } },
          {
            $set: {
              operationKey,
              parentSku: KE20_PRICE_PILOT.parentSku,
              variantId: fields.variantId,
              variantSku: fields.variantSku,
              stage: fields.stage,
              status: "in_progress",
              rawBody: fields.rawBody,
              lastCode: "in_progress",
              httpStatus: 0,
              verifiedAt: null,
            },
          },
          { upsert: true, new: true }
        ).lean();
        return { claimed: doc?.status === "in_progress", doc };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const doc = await GiniVariantPricePatch.findOne({ operationKey }).lean();
        return { claimed: false, doc };
      }
    },
    async save(operationKey, patch) {
      await GiniVariantPricePatch.updateOne({ operationKey }, { $set: patch });
      return GiniVariantPricePatch.findOne({ operationKey }).lean();
    },
  };
}

export async function previewKe20PricePatch(deps = {}) {
  const writesEnabled = ke20PricePatchWritesEnabled(deps.env || process.env);
  const blueRequest = ke20PriceRequest("blue");
  const blackRequest = ke20PriceRequest("black");
  let host = deps.host;
  if (!host && deps.skipConnection !== true) {
    try {
      const connection = await getGiniConnectionPublic();
      host = hostName(connection.baseUrl);
    } catch {
      host = "";
    }
  }
  let remote = deps.remote;
  if (!remote) {
    try {
      remote = await readRemote(readOnly(deps.performGet || performGiniRequest));
    } catch {
      remote = { parent: { state: "uncertain" }, variants: null };
    }
  }
  const owner = deps.owner === undefined ? await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(KE20_PRICE_PILOT.parentSku) }).lean() : deps.owner;
  const identities = deps.identities === undefined
    ? await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(KE20_PRICE_PILOT.parentSku) }).lean()
    : deps.identities;
  const approvals = deps.approvals === undefined
    ? await GiniVariantChangedOperation.find({ parentSku: KE20_PRICE_PILOT.parentSku, status: "approved" }).lean()
    : deps.approvals;
  const journal = deps.operation || mongoKe20PriceJournal();
  const blue = await journal.read(ke20PriceOperationKey("blue")).catch(() => null);
  const black = await journal.read(ke20PriceOperationKey("black")).catch(() => null);
  const nextStage = ke20PriceNextStage(blue?.status, black?.status);
  const baseline = nextStage ? assessKe20PriceState(remote.parent, remote.variants, nextStage, "before") : { ok: true, blockers: [] };
  const ownership = assessKe20PriceOwnership({ owner, identities });
  const approval = assessKe20PriceApproval(approvals, ownership);
  const locked = nextStage ? ke20PriceJournalBlocks(nextStage === "blue" ? blue?.status : black?.status) : true;
  const request = nextStage ? ke20PriceRequest(nextStage) : blueRequest;
  return publicResult({
    writesEnabled,
    host: host || "",
    hostMatches: host === KE20_REQUIRED_HOST,
    nextStage,
    request: { method: request.method, path: request.path, rawBody: request.rawBody },
    stages: {
      blue: { rawBody: blueRequest.rawBody, operation: journalView(blue) },
      black: { rawBody: blackRequest.rawBody, operation: journalView(black) },
    },
    baseline,
    ownership,
    approval,
    readyForConfirmation: Boolean(nextStage) && writesEnabled && host === KE20_REQUIRED_HOST && baseline.ok && ownership.ok && approval.ok && !locked && request.ok,
  });
}

export async function runKe20PricePatch({
  stage = "",
  confirm = false,
  env = process.env,
  performGet = performGiniRequest,
  performJson = performGiniJsonRequest,
  operation = null,
  owner = null,
  identities = null,
  approvals = [],
  host = "",
  remote = null,
} = {}) {
  const selected = ke20PriceStage(stage);
  const writesEnabled = ke20PricePatchWritesEnabled(env);
  const request = ke20PriceRequest(selected || "blue");
  const closed = (code, extra = {}) => publicResult({ code, writesEnabled, stage: selected, request: selected ? { method: request.method, path: request.path, rawBody: request.rawBody } : null, ...extra });
  if (!selected) return closed("stage_required", { request: null });
  if (!writesEnabled) return closed("ke20_price_patch_disabled");
  if (confirm !== true) return closed("confirmation_required");
  if (host !== KE20_REQUIRED_HOST) return closed("host_not_merchant");
  if (!request.ok) return closed(request.code || "request_shape_rejected");
  if (!operation) return closed("journal_required");
  const ownership = assessKe20PriceOwnership({ owner, identities });
  const approval = assessKe20PriceApproval(approvals, ownership);
  if (!approval.ok || !ownership.ok) return closed("approval_blocked", { blockers: [...approval.blockers, ...ownership.blockers] });
  const ownKey = ke20PriceOperationKey(selected);
  const current = await operation.read(ownKey);
  if (current?.status === "in_progress") return closed("restart_no_retry", { operation: journalView(current) });
  if (current?.status === "uncertain" || current?.status === "rejected") return closed("patch_not_retried", { operation: journalView(current) });
  if (current?.status === "verified") return closed("already_verified", { operation: journalView(current) });
  if (selected === "black") {
    const blue = await operation.read(ke20PriceOperationKey("blue"));
    if (blue?.status !== "verified" || blue.rawBody !== KE20_PRICE_PILOT.blue.rawBody) return closed("stage_not_ready");
  }
  let seen = remote;
  if (!seen) {
    try {
      seen = await readRemote(readOnly(performGet));
    } catch {
      return closed("baseline_unread");
    }
  }
  const compared = assessKe20PriceState(seen.parent, seen.variants, selected, "before");
  if (!compared.ok) {
    await operation.save(ownKey, {
      parentSku: KE20_PRICE_PILOT.parentSku,
      variantId: KE20_PRICE_PILOT[selected].id,
      variantSku: KE20_PRICE_PILOT[selected].sku,
      stage: selected,
      status: "baseline_blocked",
      rawBody: "",
      lastCode: "baseline_blocked",
      httpStatus: 0,
    });
    return closed("baseline_blocked", { blockers: compared.blockers });
  }
  const claimed = await operation.claim(ownKey, {
    variantId: KE20_PRICE_PILOT[selected].id,
    variantSku: KE20_PRICE_PILOT[selected].sku,
    stage: selected,
    rawBody: request.rawBody,
  });
  if (!claimed?.claimed) return closed("concurrent_claim_lost");
  let response;
  try {
    response = await performJson({ method: "PATCH", path: request.path, rawBody: request.rawBody });
  } catch (err) {
    await operation.save(ownKey, { status: "uncertain", rawBody: request.rawBody, lastCode: err?.code || "patch_uncertain", httpStatus: Number(err?.status) || 0 });
    return publicResult({ patchAttempted: true, code: "patch_uncertain", writesEnabled, stage: selected, request });
  }
  const status = Number(response?.status) || 0;
  if (status !== 200 && status !== 201) {
    const uncertain = status === 0 || status >= 500;
    await operation.save(ownKey, {
      status: uncertain ? "uncertain" : "rejected",
      rawBody: request.rawBody,
      lastCode: uncertain ? "patch_uncertain" : "patch_rejected",
      httpStatus: status,
    });
    return publicResult({
      patchAttempted: true,
      code: uncertain ? "patch_uncertain" : "patch_rejected",
      httpStatus: status,
      writesEnabled,
      stage: selected,
      request,
    });
  }
  let after;
  try {
    after = await readRemote(readOnly(performGet));
  } catch {
    await operation.save(ownKey, { status: "uncertain", rawBody: request.rawBody, lastCode: "verification_unread", httpStatus: status });
    return publicResult({ patchAttempted: true, code: "verification_unread", writesEnabled, stage: selected, request });
  }
  const verified = assessKe20PriceState(after.parent, after.variants, selected, "after");
  if (!verified.ok) {
    await operation.save(ownKey, { status: "uncertain", rawBody: request.rawBody, lastCode: "verification_failed", httpStatus: status });
    return publicResult({ patchAttempted: true, code: "verification_failed", blockers: verified.blockers, writesEnabled, stage: selected, request });
  }
  await operation.save(ownKey, { status: "verified", rawBody: request.rawBody, lastCode: "verified", httpStatus: status, verifiedAt: new Date() });
  return publicResult({
    ok: true,
    patchAttempted: true,
    verified: true,
    code: "verified",
    writesEnabled,
    stage: selected,
    request,
    nextStage: selected === "blue" ? "black" : "",
  });
}

export async function runAuthorizedKe20PricePatch({ stage = "", confirm = false } = {}) {
  if (!ke20PricePatchWritesEnabled(process.env)) {
    return runKe20PricePatch({ stage, confirm, env: process.env });
  }
  const connection = await getGiniConnectionPublic();
  const owner = await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(KE20_PRICE_PILOT.parentSku) }).lean();
  const identities = await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(KE20_PRICE_PILOT.parentSku) }).lean();
  const approvals = await GiniVariantChangedOperation.find({ parentSku: KE20_PRICE_PILOT.parentSku }).lean();
  return runKe20PricePatch({
    stage,
    confirm,
    host: hostName(connection.baseUrl),
    owner,
    identities,
    approvals,
    operation: mongoKe20PriceJournal(),
  });
}
