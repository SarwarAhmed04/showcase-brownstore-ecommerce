import { GiniVariantChangedOperation } from "../models/GiniVariantChangedOperation.js";
import { performGiniJsonRequest } from "./giniConnection.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { previewVariantChangedSync } from "./giniVariantChangedSync.js";

const LIVE_VARIANT_PRICE_PATCH = false;

export function variantChangedOperationKey(parentSku, variantId) {
  return `${giniSkuKey(parentSku)}:${String(variantId || "")}`;
}

export function variantPriceWritesEnabled() {
  return LIVE_VARIANT_PRICE_PATCH === true;
}

function closed(code, extra = {}) {
  return { ok: false, code, sent: false, sentToGini: 0, canSend: false, liveSend: false, ...extra };
}

function mongoStore() {
  return {
    async read(productId) {
      return GiniVariantChangedOperation.find({ productId: String(productId || "") }).lean();
    },
    async save(doc) {
      await GiniVariantChangedOperation.updateOne({ operationKey: doc.operationKey }, { $set: doc }, { upsert: true });
      return doc;
    },
  };
}

function sameBaseline(saved, row) {
  return Number(saved?.baselinePrice) === Number(row.oldPrice)
    && Number(saved?.baselineQuantity) === Number(row.oldStock)
    && String(saved?.rawBody || "") === String(row.patch?.rawBody || "");
}

export async function approveVariantPricePilot({
  parentSku = "",
  confirm = false,
  preview = null,
  store = null,
} = {}) {
  if (confirm !== true) return closed("approval_required");
  const view = preview || await previewVariantChangedSync();
  if (view?.canSend === true || view?.writesEnabled === true || view?.bulkSyncEnabled === true) return closed("send_not_permitted");
  const pilot = view?.pricePilot;
  const requested = giniSkuKey(parentSku);
  const current = (view?.pilots || []).find((item) => giniSkuKey(item.parentSku) === requested) || null;
  const pilotMatch = Boolean(pilot?.ready && giniSkuKey(pilot.parentSku) === requested);
  const records = store || mongoStore();
  const existing = current?.productId ? await records.read(current.productId) : [];
  if ((existing || []).some((row) => row.status === "in_progress" || row.status === "uncertain")) return closed("uncertain_no_retry");
  for (const prior of existing || []) {
    const row = (current?.priceRows || []).find((item) => String(item.variantId) === String(prior.variantId));
    if (!row || !["approved", "pending_approval", "verified"].includes(prior.status) || sameBaseline(prior, row)) continue;
    const { _id, __v, createdAt, updatedAt, ...rest } = prior;
    await records.save({
      ...rest,
      operationKey: prior.operationKey,
      status: "conflict",
      lastCode: "baseline_conflict",
      httpStatus: 0,
    });
    return closed("baseline_conflict", { parentSku: current.parentSku });
  }
  if (!pilotMatch) return closed("pilot_not_ready");
  if (!pilot.variants?.length || pilot.variants.some((row) => !row.patch?.rawBody || row.patch.liveSend !== false)) return closed("pilot_not_ready");
  const saved = [];
  for (const row of pilot.variants) {
    const operationKey = variantChangedOperationKey(pilot.parentSku, row.variantId);
    const prior = (existing || []).find((item) => item.operationKey === operationKey);
    if (prior && (prior.status === "conflict" || (["approved", "pending_approval", "verified"].includes(prior.status) && !sameBaseline(prior, row)))) {
      await records.save({
        operationKey,
        productId: pilot.productId,
        parentSku: pilot.parentSku,
        variantId: String(row.variantId),
        variantSku: row.sku || "",
        status: "conflict",
        baselinePrice: row.oldPrice,
        baselineQuantity: row.oldStock,
        proposedPrice: row.newPrice,
        proposedQuantity: row.newStock,
        rawBody: row.patch.rawBody,
        baselineKey: view.pilots?.find((item) => giniSkuKey(item.parentSku) === giniSkuKey(pilot.parentSku))?.baselineKey || "",
        lastCode: "baseline_conflict",
        httpStatus: 0,
      });
      return closed("baseline_conflict", { parentSku: pilot.parentSku });
    }
    const doc = {
      operationKey,
      productId: pilot.productId,
      parentSku: pilot.parentSku,
      variantId: String(row.variantId),
      variantSku: row.sku || "",
      status: "approved",
      baselinePrice: row.oldPrice,
      baselineQuantity: row.oldStock,
      proposedPrice: row.newPrice,
      proposedQuantity: row.newStock,
      rawBody: row.patch.rawBody,
      baselineKey: view.pilots?.find((item) => giniSkuKey(item.parentSku) === giniSkuKey(pilot.parentSku))?.baselineKey || "",
      lastCode: prior?.status === "approved" ? "already_approved" : "approved_not_sent",
      httpStatus: 0,
    };
    await records.save(doc);
    saved.push(doc);
  }
  return {
    ok: true,
    code: saved.every((row) => row.lastCode === "already_approved") ? "already_approved" : "approved_not_sent",
    sent: false,
    sentToGini: 0,
    canSend: false,
    liveSend: false,
    parentSku: pilot.parentSku,
    variantCount: saved.length,
  };
}

/** Same signed PATCH client used by the verified single-variant stock update. This phase does not call it. */
export const variantPricePatchClient = performGiniJsonRequest;

/**
 * LIVE_VARIANT_PRICE_PATCH is fixed off. The prepared body is the stock PATCH body,
 * and this function returns before the signed client can run.
 */
export async function sendVariantPricePilot({ performJson = variantPricePatchClient, confirm = false } = {}) {
  if (!variantPriceWritesEnabled() || confirm !== true || typeof performJson !== "function") {
    return closed("variant_price_patch_disabled");
  }
  return closed("variant_price_patch_disabled");
}
