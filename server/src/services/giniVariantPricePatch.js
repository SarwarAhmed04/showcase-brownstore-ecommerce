import { Commission } from "../models/Commission.js";
import { Product } from "../models/Product.js";
import { GiniVariantChangedOperation } from "../models/GiniVariantChangedOperation.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { GiniVariantPricePatch } from "../models/GiniVariantPricePatch.js";
import { getGiniConnectionPublic, performGiniJsonRequest, performGiniRequest } from "./giniConnection.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { variationCombinations } from "../utils/giniVariantCatalog.js";
import { quoteVariantGiniPrice } from "../utils/giniVariantPricing.js";
import {
  EI8888_PRICE_PILOT,
  KE20_PRICE_PILOT,
  KE20_REQUIRED_HOST,
  ei8888PricePatchApi,
  ke20PricePatchApi,
} from "../utils/giniVariantPricePatchPlan.js";

function readOnly(perform) {
  return async (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "GET") throw new Error("price_patch_write_blocked");
    return perform(request);
  };
}

function hostName(baseUrl) {
  try {
    return new URL(String(baseUrl || "")).hostname;
  } catch {
    return "";
  }
}

function journalView(doc) {
  if (!doc) return { status: "idle" };
  return { status: doc.status, stage: doc.stage, lastCode: doc.lastCode || "" };
}

function createRunner(pilot, api) {
  function parentPath() {
    return `/api/v2.0/third-party/products/${encodeURIComponent(pilot.parentSku)}`;
  }

  async function readRemote(performGet) {
    const parentResponse = await performGet({ method: "GET", path: parentPath() });
    const variantResponse = await performGet({ method: "GET", path: `${parentPath()}/variants` });
    return { parent: api.readParent(parentResponse), variants: api.readVariants(variantResponse) };
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
      parentSku: pilot.parentSku,
      ...fields,
      canSend: false,
      retry: false,
      batchEnabled: false,
      liveSend: false,
    };
  }

  function mongoJournal() {
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
                parentSku: pilot.parentSku,
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

  async function preview(deps = {}) {
    const writesEnabled = api.writesEnabled(deps.env || process.env);
    const stageRequests = Object.fromEntries(api.stageOrder.map((stage) => [stage, api.request(stage)]));
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
    const owner = deps.owner === undefined ? await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(pilot.parentSku) }).lean() : deps.owner;
    const identities = deps.identities === undefined
      ? await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(pilot.parentSku) }).lean()
      : deps.identities;
    const approvals = deps.approvals === undefined
      ? await GiniVariantChangedOperation.find({ parentSku: pilot.parentSku, status: "approved" }).lean()
      : deps.approvals;
    const journal = deps.operation || mongoJournal();
    const saved = {};
    for (const stage of api.stageOrder) {
      saved[stage] = await journal.read(api.operationKey(stage)).catch(() => null);
    }
    const statuses = Object.fromEntries(api.stageOrder.map((stage) => [stage, saved[stage]?.status]));
    const nextStage = api.nextStage(statuses);
    const baseline = nextStage ? api.assessState(remote.parent, remote.variants, nextStage, "before") : { ok: true, blockers: [] };
    let commissionSnapshot = deps.commissionSnapshot;
    if (api.requiresCommission && commissionSnapshot === undefined && deps.skipDatabase !== true) {
      commissionSnapshot = await resolvePricePilotCommissionSnapshot({
        pilot,
        stageOrder: api.stageOrder,
        productId: owner?.productId,
        identities,
      });
    }
    const ownership = api.resolveIdentity({ owner, identities });
    const approval = api.assessApproval(approvals, ownership);
    const commission = api.requiresCommission ? api.assessCommission(commissionSnapshot) : null;
    const locked = nextStage ? api.journalBlocks(saved[nextStage]?.status) : true;
    const request = nextStage ? stageRequests[nextStage] : stageRequests[api.stageOrder[0]];
    const stages = {};
    for (const stage of api.stageOrder) {
      stages[stage] = { rawBody: stageRequests[stage].rawBody, operation: journalView(saved[stage]) };
    }
    return publicResult({
      writesEnabled,
      host: host || "",
      hostMatches: host === KE20_REQUIRED_HOST,
      nextStage,
      request: { method: request.method, path: request.path, rawBody: request.rawBody },
      stages,
      baseline,
      ownership,
      approval,
      ...(commission ? { commission } : {}),
      readyForConfirmation: Boolean(nextStage) && writesEnabled && host === KE20_REQUIRED_HOST && baseline.ok && ownership.ok && approval.ok && (commission ? commission.ok : true) && !locked && request.ok,
    });
  }

  async function run({
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
    commissionSnapshot = undefined,
  } = {}) {
    const selected = api.stageName(stage);
    const writesEnabled = api.writesEnabled(env);
    const request = api.request(selected || api.stageOrder[0]);
    const closed = (code, extra = {}) => publicResult({ code, writesEnabled, stage: selected, request: selected ? { method: request.method, path: request.path, rawBody: request.rawBody } : null, ...extra });
    if (!selected) return closed("stage_required", { request: null });
    if (!writesEnabled) return closed(api.disabledCode);
    if (confirm !== true) return closed("confirmation_required");
    if (host !== KE20_REQUIRED_HOST) return closed("host_not_merchant");
    if (!request.ok) return closed(request.code || "request_shape_rejected");
    if (!operation) return closed("journal_required");
    const ownership = api.resolveIdentity({ owner, identities });
    const approval = api.assessApproval(approvals, ownership);
    if (!approval.ok || !ownership.ok) return closed("approval_blocked", { blockers: [...approval.blockers, ...ownership.blockers] });
    if (api.requiresCommission) {
      const commission = api.assessCommission(commissionSnapshot);
      if (!commission.ok) return closed("commission_blocked", { blockers: commission.blockers, commission });
    }
    const ownKey = api.operationKey(selected);
    const current = await operation.read(ownKey);
    if (current?.status === "in_progress") return closed("restart_no_retry", { operation: journalView(current) });
    if (current?.status === "uncertain" || current?.status === "rejected") return closed("patch_not_retried", { operation: journalView(current) });
    if (current?.status === "verified") return closed("already_verified", { operation: journalView(current) });
    const selectedIndex = api.stageOrder.indexOf(selected);
    if (selectedIndex > 0) {
      const previous = api.stageOrder[selectedIndex - 1];
      const previousJournal = await operation.read(api.operationKey(previous));
      if (previousJournal?.status !== "verified" || previousJournal.rawBody !== pilot[previous].rawBody) return closed("stage_not_ready");
    }
    let seen = remote;
    if (!seen) {
      try {
        seen = await readRemote(readOnly(performGet));
      } catch {
        return closed("baseline_unread");
      }
    }
    const compared = api.assessState(seen.parent, seen.variants, selected, "before");
    if (!compared.ok) {
      await operation.save(ownKey, {
        parentSku: pilot.parentSku,
        variantId: pilot[selected].id,
        variantSku: pilot[selected].sku,
        stage: selected,
        status: "baseline_blocked",
        rawBody: "",
        lastCode: "baseline_blocked",
        httpStatus: 0,
      });
      return closed("baseline_blocked", { blockers: compared.blockers });
    }
    const claimed = await operation.claim(ownKey, {
      variantId: pilot[selected].id,
      variantSku: pilot[selected].sku,
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
    const verified = api.assessState(after.parent, after.variants, selected, "after");
    if (!verified.ok) {
      await operation.save(ownKey, { status: "uncertain", rawBody: request.rawBody, lastCode: "verification_failed", httpStatus: status });
      return publicResult({ patchAttempted: true, code: "verification_failed", blockers: verified.blockers, writesEnabled, stage: selected, request });
    }
    await operation.save(ownKey, { status: "verified", rawBody: request.rawBody, lastCode: "verified", httpStatus: status, verifiedAt: new Date() });
    const following = api.stageOrder[selectedIndex + 1] || "";
    return publicResult({
      ok: true,
      patchAttempted: true,
      verified: true,
      code: "verified",
      writesEnabled,
      stage: selected,
      request,
      nextStage: following,
    });
  }

  async function runAuthorized({ stage = "", confirm = false } = {}) {
    if (!api.writesEnabled(process.env)) {
      return run({ stage, confirm, env: process.env });
    }
    const connection = await getGiniConnectionPublic();
    const owner = await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(pilot.parentSku) }).lean();
    const identities = await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(pilot.parentSku) }).lean();
    const approvals = await GiniVariantChangedOperation.find({ parentSku: pilot.parentSku }).lean();
    const commissionSnapshot = api.requiresCommission
      ? await resolvePricePilotCommissionSnapshot({ pilot, stageOrder: api.stageOrder, productId: owner?.productId, identities })
      : undefined;
    return run({
      stage,
      confirm,
      host: hostName(connection.baseUrl),
      owner,
      identities,
      approvals,
      operation: mongoJournal(),
      commissionSnapshot,
    });
  }

  return { preview, run, runAuthorized, mongoJournal };
}

export async function resolvePricePilotCommissionSnapshot({
  pilot,
  stageOrder,
  productId = "",
  identities = [],
  product = undefined,
  rules = undefined,
} = {}) {
  const doc = product !== undefined ? product : await Product.findById(productId).lean();
  const commissionRules = rules !== undefined ? rules : await Commission.find({ partner: "gini", isActive: { $ne: false } }).lean();
  if (!doc || !productId) return null;
  const combos = variationCombinations(doc);
  const quotes = [];
  for (const stage of stageOrder || []) {
    const rowSpec = pilot[stage];
    const identity = (identities || []).find((row) => String(row?.confirmedGiniVariantId || "") === rowSpec.id && giniSkuKey(row?.approvedSku) === giniSkuKey(rowSpec.sku));
    if (!identity) return null;
    const combo = combos.find((row) => String(row.sourceVariantId) === String(identity.sourceVariantId) && String(row.sourceSizeId) === String(identity.sourceSizeId));
    if (!combo || combo.ownPrice == null) return null;
    quotes.push(quoteVariantGiniPrice({
      product: doc,
      rules: commissionRules,
      ownPrice: combo.ownPrice,
      parentStorePrice: doc.price,
      parentPriceReview: doc.priceReview === true,
    }));
  }
  if (!quotes.length || quotes.length !== (stageOrder || []).length) return null;
  const first = quotes[0];
  const agreed = quotes.every((row) => row.rate === first.rate && row.basePrice === first.basePrice && row.giniPrice === first.giniPrice);
  if (!agreed) return { percentage: first.rate, basePrice: first.basePrice, giniPrice: null, scope: first.commission?.scope || "" };
  return {
    percentage: first.rate,
    basePrice: first.basePrice,
    giniPrice: first.giniPrice,
    scope: first.commission?.scope || "",
  };
}

const ke20Runner = createRunner(KE20_PRICE_PILOT, ke20PricePatchApi);
const ei8888Runner = createRunner(EI8888_PRICE_PILOT, ei8888PricePatchApi);

export const mongoKe20PriceJournal = ke20Runner.mongoJournal;
export const previewKe20PricePatch = ke20Runner.preview;
export const runKe20PricePatch = ke20Runner.run;
export const runAuthorizedKe20PricePatch = ke20Runner.runAuthorized;

export const mongoEi8888PriceJournal = ei8888Runner.mongoJournal;
export const previewEi8888PricePatch = ei8888Runner.preview;
export const runEi8888PricePatch = ei8888Runner.run;
export const runAuthorizedEi8888PricePatch = ei8888Runner.runAuthorized;
