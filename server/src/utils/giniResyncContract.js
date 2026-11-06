import crypto from "crypto";
import { isGiniHistoricalHoldSku } from "./giniHistoricalHold.js";
import { blockerMessage } from "./giniSyncEvaluate.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";

export const GINI_RESYNC_PREVIEW_TTL_MS = 30 * 60 * 1000;
export const GINI_RESYNC_CREATE_METHOD = "POST";

const EXTRA_TEXT = {
  remote_identity_conflict:
    "The saved GINI id belongs to a different SKU. The saved id was kept and no second create was sent.",
  duplicate_remote_sku:
    "GINI returned more than one product for this SKU. The saved id was kept and no second create was sent.",
  saved_id_unusable:
    "The saved GINI id is not a numeric id, so deletion cannot be verified. No second create was sent.",
  account_conflict:
    "GINI product reads did not stay on one merchant id. No second create was sent.",
  same_id_not_recreated:
    "GINI returned the original product id, so this was not treated as a new create. The saved id was kept.",
  resync_uncertain:
    "The re-sync response was not verified. No second create was sent.",
  search_pagination_incomplete:
    "GINI search did not return every page, so this SKU cannot be classified as missing. No second create was sent.",
};

export function giniResyncWritesEnabled() {
  return process.env.GINI_RESYNC_WRITES_ENABLED === "true" && process.env.GINI_ALLOW_LIVE_RESYNC_WRITES === "true";
}

export function resyncReason(code) {
  return EXTRA_TEXT[code] || blockerMessage(code);
}

function foundProduct(read) {
  return Boolean(read && read.state === "found" && String(read.giniProductId || "").trim() && giniSkuKey(read.sku));
}

function absentProduct(read) {
  return Boolean(read && read.state === "absent" && Number(read.status) === 404);
}

function remoteBase(remoteState, code, liveGiniProductId = "") {
  return {
    remoteState,
    code,
    liveGiniProductId: String(liveGiniProductId || ""),
    identityMatched: false,
  };
}

/**
 * A confirmed product is verified missing only when the SKU GET, the numeric id GET,
 * and the SKU search all finish without finding it. One 404, or any failed read, is not enough.
 */
export function assessGiniResyncRemote({ savedSku = "", savedGiniProductId = "", skuRead = null, idRead = null, search = null } = {}) {
  const savedKey = giniSkuKey(savedSku);
  const savedId = String(savedGiniProductId || "").trim();
  if (!savedKey || !/^\d+$/.test(savedId)) return remoteBase("uncertain", "saved_id_unusable");
  for (const read of [skuRead, idRead, search]) {
    if (!read) return remoteBase("uncertain", "confirmed_send_unverified");
    if (read.state === "auth") return remoteBase("uncertain", "gini_access_forbidden");
    if (read.state === "edge") return remoteBase("uncertain", "gini_edge_blocked");
    if (read.state === "rate_limited") return remoteBase("uncertain", "rate_limited");
  }

  const searchMatches = (Array.isArray(search.matches) ? search.matches : []).filter((item) => giniSkuKey(item?.sku) === savedKey);
  const searchIds = [...new Set(searchMatches.map((item) => String(item.giniProductId || "")).filter(Boolean))];
  if (search.state === "duplicate" || searchIds.length > 1) {
    return remoteBase("conflict", "duplicate_remote_sku", searchIds[0] || "");
  }

  if (foundProduct(idRead) && giniSkuKey(idRead.sku) !== savedKey) {
    return remoteBase("conflict", "remote_identity_conflict", idRead.giniProductId);
  }
  if (foundProduct(skuRead) && giniSkuKey(skuRead.sku) !== savedKey) {
    return remoteBase("conflict", "confirmed_send_sku_mismatch", skuRead.giniProductId);
  }

  const skuHit = foundProduct(skuRead) && giniSkuKey(skuRead.sku) === savedKey ? skuRead : null;
  const idHit = foundProduct(idRead) && giniSkuKey(idRead.sku) === savedKey ? idRead : null;
  if (skuHit && String(skuHit.giniProductId) !== savedId) {
    return remoteBase("existing", "confirmed_send_id_mismatch", skuHit.giniProductId);
  }
  if (skuHit && idHit && String(skuHit.giniProductId) === savedId && String(idHit.giniProductId) === savedId) {
    return {
      remoteState: "existing",
      code: "confirmed_local_send",
      liveGiniProductId: savedId,
      identityMatched: true,
    };
  }
  if ((skuHit && !idHit) || (!skuHit && idHit)) return remoteBase("uncertain", "confirmed_send_unverified", savedId);

  const searchHit = searchIds.length === 1 ? searchIds[0] : "";
  if (!skuHit && !idHit && searchHit) return remoteBase("uncertain", "confirmed_send_unverified", searchHit);
  const searchFinished = search.state === "absent" && search.incomplete !== true;
  if (absentProduct(skuRead) && absentProduct(idRead) && searchFinished && searchIds.length === 0) {
    return remoteBase("verified_missing", "confirmed_send_missing");
  }
  if (search.incomplete === true || search.state === "incomplete") {
    return remoteBase("uncertain", "search_pagination_incomplete");
  }
  return remoteBase("uncertain", "confirmed_send_unverified");
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function explainLocal(input) {
  if (!input.productFound) return { ok: false, reconciliation: true, code: "product_not_found", blockers: ["product_not_found"] };
  if (giniSkuKey(input.currentSku) !== giniSkuKey(input.savedSku)) {
    return { ok: false, reconciliation: true, code: "confirmed_sku_mismatch", blockers: ["confirmed_sku_mismatch"] };
  }
  if (input.duplicate) return { ok: false, code: "duplicate_brownstore_sku", blockers: ["duplicate_brownstore_sku"] };
  if (input.inactive) {
    const codes = unique(input.inactiveReasons?.length ? input.inactiveReasons : ["product_inactive"]);
    return { ok: false, code: codes[0], blockers: codes };
  }
  const blockers = unique(
    (input.planBlockers || []).filter((code) => code && code !== "existing_gini_product" && code !== "gini_lookup_failed")
  );
  if (blockers.length) return { ok: false, code: blockers[0], blockers };
  return { ok: true, code: "", blockers: [] };
}

export function classifyGiniResyncRow({
  savedSku = "",
  currentSku = "",
  productFound = false,
  inactive = false,
  inactiveReasons = [],
  planBlockers = [],
  duplicate = false,
  remote = null,
} = {}) {
  const assessed = remote || remoteBase("uncertain", "confirmed_send_unverified");
  const historical = isGiniHistoricalHoldSku(savedSku) || isGiniHistoricalHoldSku(currentSku);
  const shared = {
    historical,
    remoteState: assessed.remoteState,
    liveGiniProductId: assessed.liveGiniProductId || "",
    identityMatched: assessed.identityMatched === true,
    eligible: false,
    locallyEligible: false,
  };
  if (historical) {
    return {
      ...shared,
      classification: "BLOCKED",
      code: "historical_sku_hold",
      blockers: ["historical_sku_hold"],
      reason: resyncReason("historical_sku_hold"),
    };
  }
  if (assessed.identityMatched) {
    return {
      ...shared,
      classification: "EXISTING",
      code: "confirmed_local_send",
      blockers: [],
      reason: resyncReason("confirmed_local_send"),
    };
  }
  if (assessed.remoteState !== "verified_missing") {
    return {
      ...shared,
      classification: "RECONCILIATION",
      code: assessed.code || "confirmed_send_unverified",
      blockers: [assessed.code || "confirmed_send_unverified"],
      reason: resyncReason(assessed.code || "confirmed_send_unverified"),
    };
  }
  const local = explainLocal({ productFound, currentSku, savedSku, duplicate, inactive, inactiveReasons, planBlockers });
  if (!local.ok) {
    return {
      ...shared,
      classification: local.reconciliation ? "RECONCILIATION" : "BLOCKED",
      code: local.code,
      blockers: local.blockers,
      reason: local.blockers.map(resyncReason).join("; ").slice(0, 400),
    };
  }
  return {
    ...shared,
    classification: "VERIFIED_MISSING",
    eligible: true,
    locallyEligible: true,
    code: "confirmed_send_missing",
    blockers: [],
    reason: resyncReason("confirmed_send_missing"),
  };
}

export function giniResyncPreviewSignature(rows, account) {
  const stable = [...(rows || [])]
    .map((row) => ({
      sku: String(row?.sku || ""),
      productId: String(row?.productId || ""),
      classification: String(row?.classification || ""),
      code: String(row?.code || ""),
      eligible: row?.eligible === true,
      locallyEligible: row?.locallyEligible === true,
      historical: row?.historical === true,
      remoteState: String(row?.remoteState || ""),
      savedGiniProductId: String(row?.savedGiniProductId || ""),
      liveGiniProductId: String(row?.liveGiniProductId || ""),
      currentHash: String(row?.currentHash || ""),
      identityMatched: row?.identityMatched === true,
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku) || left.productId.localeCompare(right.productId));
  return crypto.createHash("sha256").update(JSON.stringify({
    clientId: String(account?.clientId || ""),
    baseHost: String(account?.baseHost || ""),
    rows: stable,
  })).digest("hex");
}

export function resyncRowCanSend(row) {
  if (!row || row.remoteState !== "verified_missing") return false;
  if (row.historical === true || row.code === "historical_sku_hold") return false;
  if (isGiniHistoricalHoldSku(row.sku) || isGiniHistoricalHoldSku(row.skuKey)) return false;
  return row.eligible === true && row.classification === "VERIFIED_MISSING";
}
