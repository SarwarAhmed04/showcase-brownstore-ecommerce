import { isGiniHistoricalHoldSku } from "./giniHistoricalHold.js";
import { blockerMessage, giniPayloadHash, isUnresolvedHistoricalGiniSku } from "./giniSyncEvaluate.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";
import { explainGiniPriceQuantityChange } from "./giniProductUpdateContract.js";

function result(classification, code, plan, localSend, reason) {
  const blockers = code ? [code] : [];
  return {
    classification,
    blockers,
    reason: reason || (code ? blockerMessage(code) : ""),
    errorCode: code || "",
    sku: plan?.sku || "",
    skuKey: giniSkuKey(plan?.sku || ""),
    giniProductId: String(localSend?.giniProductId || ""),
    giniPrice: plan?.giniPrice ?? null,
    quantity: plan?.quantity ?? null,
    imageCount: plan?.imageCount || 0,
    payloadHash: giniPayloadHash(plan?.payloadPreview),
    payloadPreview: plan?.payloadPreview || null,
  };
}

/**
 * Decide whether a saved GINI id can be skipped from the remote lookup.
 * A matching SKU and payload hash is unchanged. A different BrownStore SKU is
 * reconciliation. Anything else still needs a complete remote read.
 */
export function localConfirmedCatalogDecision({ plan, localSend } = {}) {
  const savedId = String(localSend?.giniProductId || "");
  if (!savedId) return { action: "verify_remote" };
  const savedKey = giniSkuKey(localSend?.sku);
  const currentKey = giniSkuKey(plan?.sku);
  if (savedKey && currentKey && savedKey !== currentKey) {
    return { action: "store", result: result("RECONCILE", "confirmed_sku_mismatch", plan, localSend) };
  }
  const savedHash = String(localSend?.payloadHash || "");
  const currentHash = giniPayloadHash(plan?.payloadPreview);
  if (savedHash && currentHash && savedKey && savedKey === currentKey && savedHash === currentHash) {
    return {
      action: "store",
      result: result("UNCHANGED", "", plan, localSend, blockerMessage("unchanged_confirmed_payload")),
    };
  }
  return { action: "verify_remote" };
}

/**
 * The live id already matched the saved id. Only an official price or quantity
 * difference can become an update. Historical holds are never updated here.
 */
export function classifyOfficialFieldChange({ plan, localSend, snapshot } = {}) {
  const sku = plan?.sku || localSend?.sku || "";
  if (isUnresolvedHistoricalGiniSku(sku)) {
    return result("RECONCILE", "historical_sku_unresolved", plan, localSend);
  }
  if (isGiniHistoricalHoldSku(sku)) {
    return result("RECONCILE", "historical_sku_hold", plan, localSend);
  }
  const explained = explainGiniPriceQuantityChange({
    savedHash: localSend?.payloadHash,
    currentPayload: plan?.payloadPreview,
    savedPrice: snapshot?.giniPrice,
    savedQuantity: snapshot?.quantity,
  });
  if (!explained.ok) {
    const code = explained.code || "unsupported_field_change";
    return result("BLOCKED", code, plan, localSend);
  }
  const packed = result("CHANGED", "", plan, localSend, blockerMessage("local_payload_hash_differs"));
  packed.updateChanges = explained.changes;
  packed.confirmFullHash = explained.confirmFullHash === true;
  packed.nextPayloadHash = explained.confirmFullHash ? explained.nextHash : "";
  return packed;
}
