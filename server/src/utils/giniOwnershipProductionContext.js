import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { evaluateLoopbackAuthorization } from "../scripts/giniProductionPreflight.js";
import { inspectDeployment, maskClientId } from "../scripts/giniProductionReadOnlyAudit.js";

export const OWNERSHIP_PILOT_SKU = "38104";

/** Preview counts that identify the verified Hostinger brownstore database. */
export const OWNERSHIP_PRODUCTION_PREVIEW = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

const FRESH_MS = 15 * 60 * 1000;
const freshSnapshots = new Map();

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/**
 * Reads only the connection and preview rows needed to identify the database.
 * It does not read products, owners, operations, or indexes.
 */
export async function verifyOwnershipDatabase(db, {
  confirmProduction = false,
  allowLoopback = false,
  loopback = false,
} = {}) {
  if (confirmProduction !== true || allowLoopback !== true || loopback !== true || db?.databaseName !== "brownstore") {
    return { ok: false, reason: "production_context_unverified" };
  }
  const names = new Map((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => [String(item.name).toLowerCase(), item.name]));
  const connectionName = names.get("giniconnections");
  const jobName = names.get("ginisyncjobs");
  const connection = connectionName
    ? await db.collection(connectionName).findOne({}, { projection: { baseUrl: 1, clientId: 1 } })
    : null;
  const preview = jobName
    ? await db.collection(jobName).find({ mode: "preview", ...OWNERSHIP_PRODUCTION_PREVIEW }).sort({ createdAt: -1 }).limit(1).next()
    : null;
  let host = "";
  try {
    host = new URL(String(connection?.baseUrl || "")).hostname;
  } catch {
    host = "";
  }
  const decision = evaluateLoopbackAuthorization({
    confirmProduction: true,
    allowLoopback: true,
    loopback: true,
    databaseName: db.databaseName,
    deployment: inspectDeployment(fileURLToPath(new URL(".", import.meta.url))),
    merchant: {
      hostMatches: host === "merchant.gini.iq",
      clientMaskMatches: maskClientId(connection?.clientId) === "1423...2bee",
    },
    preview: preview ? { found: true, ...OWNERSHIP_PRODUCTION_PREVIEW } : { found: false },
  });
  if (decision.allowed !== true || decision.reason !== "verified_production_loopback") {
    return { ok: false, reason: "production_context_unverified" };
  }
  return { ok: true, reason: "verified_production_loopback" };
}

export function rememberVerifiedSnapshot({ productIds = [], sourceItemIds = [] } = {}) {
  const capturedAt = new Date().toISOString();
  const snapshot = {
    id: randomUUID(),
    verifiedProduction: true,
    reason: "verified_production_loopback",
    databaseName: "brownstore",
    capturedAt,
    productIds: [...productIds].map((id) => String(id || "")).filter(Boolean).sort(),
    sourceItemIds: [...sourceItemIds].map((id) => String(id || "")).filter(Boolean).sort(),
  };
  freshSnapshots.set(snapshot.id, {
    expires: Date.parse(capturedAt) + FRESH_MS,
    productIds: snapshot.productIds,
  });
  return snapshot;
}

export function acceptFreshProductionSnapshot(snapshot, { productIds = [], productId = "" } = {}) {
  if (!snapshot || snapshot.verifiedProduction !== true || snapshot.reason !== "verified_production_loopback" || snapshot.databaseName !== "brownstore" || !snapshot.id) {
    return false;
  }
  const saved = freshSnapshots.get(snapshot.id);
  if (!saved || Date.now() > saved.expires) return false;
  const live = [...productIds].map((id) => String(id || "")).filter(Boolean).sort();
  if (!sameIds(live, saved.productIds)) return false;
  if (!productId || !saved.productIds.includes(String(productId))) return false;
  return true;
}
