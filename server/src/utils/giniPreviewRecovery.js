import crypto from "crypto";
import { giniSkuKey } from "./giniSyncOnePlan.js";

/** Local decisions that do not depend on a GINI product lookup. */
export const LOCAL_PREVIEW_CLASSIFICATIONS = Object.freeze(["INACTIVE", "BLOCKED", "NEEDS_REVIEW"]);

const LOCAL_CLASSIFICATION = new Set(LOCAL_PREVIEW_CLASSIFICATIONS);

const REMOTE_BLOCKERS = new Set(["gini_lookup_failed", "existing_gini_product"]);

export function previewBlockerKey(blockers) {
  return [...(blockers || [])]
    .map(String)
    .filter((code) => code && !REMOTE_BLOCKERS.has(code))
    .sort()
    .join("|");
}

/**
 * Identity of the local decision. lastSyncedAt is intentionally absent:
 * an IBSHER refresh rewrites it even when the GINI payload is unchanged.
 */
export function localPreviewFingerprint({
  skuKey = "",
  payloadHash = "",
  blockers = [],
  ownerIds = [],
  inactiveCodes = [],
  policySignature = "",
} = {}) {
  const body = JSON.stringify({
    version: 1,
    skuKey: skuKey || "",
    payloadHash: payloadHash || "",
    blockers: previewBlockerKey(blockers),
    owners: [...(ownerIds || [])].map(String).sort(),
    inactiveCodes: [...(inactiveCodes || [])].map(String).sort(),
    policySignature: policySignature || "",
  });
  return crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * A prior local classification can be copied only when the current plan
 * reproduces it. READY_CREATE is never reused from another job.
 */
export function canReuseLocalPreviewRow(source, current) {
  if (!source || !current) return false;
  const classification = String(source.classification || "");
  if (!LOCAL_CLASSIFICATION.has(classification) || classification !== String(current.classification || "")) return false;
  const sourceKey = giniSkuKey(source.sku || source.skuKey || "");
  const currentKey = giniSkuKey(current.sku || current.skuKey || "");
  if (!sourceKey || sourceKey !== currentKey) return false;
  if (String(source.payloadHash || "") !== String(current.payloadHash || "")) return false;
  if (previewBlockerKey(source.blockers) !== previewBlockerKey(current.blockers)) return false;
  return true;
}

/**
 * Absence or existence recorded on the current job for the same SKU.
 * A prior job's READY_CREATE label is not a lookup result.
 */
export function storedLookupReusable(row, skuKey) {
  if (!row) return null;
  const outcome = String(row.lookupOutcome || "");
  if (outcome !== "absent" && outcome !== "exists") return null;
  const savedKey = String(row.lookupSkuKey || "");
  if (!savedKey || savedKey !== String(skuKey || "")) return null;
  if (outcome === "absent") return { exists: false };
  const giniProductId = String(row.giniProductId || "");
  if (!giniProductId) return null;
  return { exists: true, giniProductId, sku: row.sku || skuKey };
}

export function lookupOutcomeOf(found) {
  if (!found || found.error || (found.exists !== true && found.exists !== false)) return "uncertain";
  return found.exists ? "exists" : "absent";
}
