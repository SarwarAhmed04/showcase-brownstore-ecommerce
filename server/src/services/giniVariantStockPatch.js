import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { GiniVariantStockPatch } from "../models/GiniVariantStockPatch.js";
import { getGiniConnectionPublic, performGiniJsonRequest, performGiniRequest } from "./giniConnection.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { KE20_STOCK_PILOT } from "../utils/giniVariantUpdateContract.js";
import {
  KE20_REQUIRED_HOST,
  assessKe20Applied,
  assessKe20Baseline,
  assessKe20Ownership,
  assessKe20Restored,
  giniVariantStockPatchWritesEnabled,
  ke20ApplyRequest,
  ke20IntentionalDifference,
  ke20RestorePlan,
  ke20RestoreRequest,
  readKe20Parent,
  variantRows,
} from "../utils/giniVariantStockPatchPlan.js";

const OPERATION_KEY = "ke20-black-164307";

function parentPath() {
  return `/api/v2.0/third-party/products/${encodeURIComponent(KE20_STOCK_PILOT.parentSku)}`;
}

function readOnly(perform) {
  return async (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "GET") throw new Error("stock_patch_write_blocked");
    return perform(request);
  };
}

async function readRemote(performGet) {
  const parentResponse = await performGet({ method: "GET", path: parentPath() });
  const variantResponse = await performGet({ method: "GET", path: `${parentPath()}/variants` });
  return { parent: readKe20Parent(parentResponse), variants: variantRows(variantResponse) };
}

function mongoOperation() {
  return {
    async read() {
      return GiniVariantStockPatch.findOne({ operationKey: OPERATION_KEY }).lean();
    },
    async save(patch) {
      await GiniVariantStockPatch.updateOne(
        { operationKey: OPERATION_KEY },
        { $set: { operationKey: OPERATION_KEY, parentSku: KE20_STOCK_PILOT.parentSku, variantId: KE20_STOCK_PILOT.variantId, ...patch } },
        { upsert: true }
      );
      return GiniVariantStockPatch.findOne({ operationKey: OPERATION_KEY }).lean();
    },
  };
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
    canSend: false,
    sent: false,
    verified: false,
    retry: false,
    intentionalDifference: ke20IntentionalDifference(),
    restorePlan: ke20RestorePlan(),
    ...fields,
    canSend: false,
  };
}

export async function previewKe20StockPatch(deps = {}) {
  const performGet = readOnly(deps.performGet || performGiniRequest);
  const writesEnabled = giniVariantStockPatchWritesEnabled(deps.env || process.env);
  const request = ke20ApplyRequest();
  let host = deps.host;
  if (!host && deps.skipConnection !== true) {
    try {
      const connection = await getGiniConnectionPublic();
      host = hostName(connection.baseUrl);
    } catch {
      host = "";
    }
  }
  let remote = { parent: { state: "uncertain" }, variants: null };
  if (deps.remote) remote = deps.remote;
  else {
    try {
      remote = await readRemote(performGet);
    } catch {
      remote = { parent: { state: "uncertain" }, variants: null };
    }
  }
  const owner = deps.owner === undefined ? await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(KE20_STOCK_PILOT.parentSku) }).lean() : deps.owner;
  const identities = deps.identities === undefined
    ? await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(KE20_STOCK_PILOT.parentSku) }).lean()
    : deps.identities;
  const operation = deps.operation ? await deps.operation.read() : await mongoOperation().read().catch(() => null);
  const baseline = assessKe20Baseline(remote.parent, remote.variants);
  const ownership = assessKe20Ownership({ owner, identities });
  const locked = operation && ["in_progress", "uncertain", "rejected"].includes(operation.status);
  return publicResult({
    writesEnabled,
    host: host || "",
    hostMatches: host === KE20_REQUIRED_HOST,
    request: { method: request.method, path: request.path, rawBody: request.rawBody },
    baseline,
    ownership,
    operation: operation ? { status: operation.status, direction: operation.direction, lastCode: operation.lastCode } : { status: "idle" },
    readyForConfirmation: writesEnabled && host === KE20_REQUIRED_HOST && baseline.ok && ownership.ok && !locked && request.ok,
    brownStoreStock: KE20_STOCK_PILOT.currentQuantity,
    giniProposedStock: KE20_STOCK_PILOT.proposedQuantity,
  });
}

export async function runKe20StockPatch({
  direction = "apply",
  confirm = false,
  env = process.env,
  performGet = performGiniRequest,
  performJson = performGiniJsonRequest,
  operation = null,
  owner = null,
  identities = null,
  host = "",
  remote = null,
} = {}) {
  const writesEnabled = giniVariantStockPatchWritesEnabled(env);
  const request = direction === "restore" ? ke20RestoreRequest() : ke20ApplyRequest();
  const store = operation;
  const closed = (code, extra = {}) => publicResult({ ok: false, code, writesEnabled, request, ...extra });
  if (!writesEnabled) return closed("variant_stock_patch_disabled");
  if (confirm !== true) return closed("confirmation_required");
  if (host !== KE20_REQUIRED_HOST) return closed("host_not_merchant");
  if (!request.ok) return closed(request.code);
  const current = store ? await store.read() : null;
  if (current && ["in_progress", "uncertain", "rejected"].includes(current.status)) return closed("patch_not_retried", { operation: current });
  if (direction === "apply" && current?.status === "verified" && current.direction === "apply") return closed("already_applied");
  if (direction === "restore" && !(current?.status === "verified" && current.direction === "apply")) return closed("restore_not_ready");
  let seen = remote;
  if (!seen) {
    try {
      seen = await readRemote(readOnly(performGet));
    } catch {
      return closed("baseline_unread");
    }
  }
  const compared = direction === "restore" ? assessKe20Applied(seen.parent, seen.variants) : assessKe20Baseline(seen.parent, seen.variants);
  const ownership = assessKe20Ownership({ owner, identities });
  if (!compared.ok || !ownership.ok) {
    if (store) await store.save({ status: "baseline_blocked", direction, lastCode: "baseline_blocked", rawBody: "" });
    return closed("baseline_blocked", { blockers: [...compared.blockers, ...ownership.blockers] });
  }
  if (store) await store.save({ status: "in_progress", direction, rawBody: request.rawBody, lastCode: "in_progress", httpStatus: 0 });
  let response;
  try {
    response = await performJson({ method: "PATCH", path: request.path, rawBody: request.rawBody });
  } catch (err) {
    if (store) await store.save({ status: "uncertain", direction, rawBody: request.rawBody, lastCode: err?.code || "patch_uncertain", httpStatus: Number(err?.status) || 0 });
    return publicResult({ ok: false, patchAttempted: true, code: "patch_uncertain", writesEnabled, request });
  }
  const status = Number(response?.status) || 0;
  if (status !== 200 && status !== 201) {
    const uncertain = status === 0 || status >= 500;
    if (store) await store.save({ status: uncertain ? "uncertain" : "rejected", direction, rawBody: request.rawBody, lastCode: uncertain ? "patch_uncertain" : "patch_rejected", httpStatus: status });
    return publicResult({ ok: false, patchAttempted: true, code: uncertain ? "patch_uncertain" : "patch_rejected", httpStatus: status, writesEnabled, request });
  }
  let after;
  try {
    after = await readRemote(readOnly(performGet));
  } catch {
    if (store) await store.save({ status: "uncertain", direction, rawBody: request.rawBody, lastCode: "verification_unread", httpStatus: status });
    return publicResult({ ok: false, patchAttempted: true, code: "verification_unread", writesEnabled, request });
  }
  const verified = direction === "restore" ? assessKe20Restored(after.parent, after.variants) : assessKe20Applied(after.parent, after.variants);
  if (!verified.ok) {
    if (store) await store.save({ status: "uncertain", direction, rawBody: request.rawBody, lastCode: "verification_failed", httpStatus: status });
    return publicResult({ ok: false, patchAttempted: true, verified: false, code: "verification_failed", blockers: verified.blockers, writesEnabled, request });
  }
  if (store) await store.save({ status: "verified", direction, rawBody: request.rawBody, lastCode: "verified", httpStatus: status, verifiedAt: new Date() });
  return publicResult({ ok: true, patchAttempted: true, verified: true, code: "verified", writesEnabled, request });
}

export async function runAuthorizedKe20StockPatch({ direction = "apply", confirm = false } = {}) {
  const connection = await getGiniConnectionPublic();
  const owner = await GiniVariantParentOwner.findOne({ skuKey: giniSkuKey(KE20_STOCK_PILOT.parentSku) }).lean();
  const identities = await GiniVariantIdentity.find({ parentSkuKey: giniSkuKey(KE20_STOCK_PILOT.parentSku) }).lean();
  return runKe20StockPatch({
    direction,
    confirm,
    host: hostName(connection.baseUrl),
    owner,
    identities,
    operation: mongoOperation(),
  });
}
