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

export function productionSnapshotDecision(snapshot, { productIds = [], productId = "", now = Date.now() } = {}) {
  if (!snapshot || snapshot.verifiedProduction !== true || snapshot.reason !== "verified_production_loopback" || snapshot.databaseName !== "brownstore" || !snapshot.id) {
    return "production_context_unverified";
  }
  const saved = freshSnapshots.get(snapshot.id);
  if (!saved) return "production_context_unverified";
  if (now > saved.expires) return "production_snapshot_expired";
  const live = [...productIds].map((id) => String(id || "")).filter(Boolean).sort();
  if (!sameIds(live, saved.productIds)) return "production_context_unverified";
  if (!productId || !saved.productIds.includes(String(productId))) return "pilot_not_authorized";
  return "";
}

export function acceptFreshProductionSnapshot(snapshot, options = {}) {
  return productionSnapshotDecision(snapshot, options) === "";
}

const authorizationSnapshots = new Map();

function clean(value) {
  return String(value || "").trim();
}

/**
 * Registers an authorization handle in this process only.
 * A CLI audit, another server process, or a restarted process cannot see it.
 * The returned id is a lookup key. Callers must ignore any snapshot body supplied with a request.
 */
export function registerOwnershipAuthorization({
  parentSku = "",
  productId = "",
  sourceItemId = "",
  vendorId = "",
  administratorId = "",
  productIds = [],
  sourceItemIds = [],
} = {}) {
  const record = {
    parentSku: clean(parentSku),
    productId: clean(productId),
    sourceItemId: clean(sourceItemId),
    vendorId: clean(vendorId),
    administratorId: clean(administratorId),
    productIds: [...productIds].map(clean).filter(Boolean).sort(),
    sourceItemIds: [...sourceItemIds].map(clean).filter(Boolean).sort(),
  };
  if (!record.parentSku || !record.productId || !record.sourceItemId || !record.vendorId || !record.administratorId) return null;
  const capturedAt = new Date().toISOString();
  const id = randomUUID();
  authorizationSnapshots.set(id, {
    ...record,
    expires: Date.parse(capturedAt) + FRESH_MS,
    capturedAt,
  });
  return {
    id,
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + FRESH_MS).toISOString(),
    parentSku: record.parentSku,
    productId: record.productId,
    sourceItemId: record.sourceItemId,
    vendorId: record.vendorId,
    administratorId: record.administratorId,
  };
}

export function resolveOwnershipAuthorization(snapshotId, {
  parentSku = "",
  productId = "",
  sourceItemId = "",
  vendorId = "",
  administratorId = "",
  now = Date.now(),
} = {}) {
  const saved = authorizationSnapshots.get(clean(snapshotId));
  if (!saved) return { ok: false, code: "production_context_unverified" };
  if (now > saved.expires) return { ok: false, code: "production_snapshot_expired" };
  if (!saved.administratorId || clean(administratorId) !== saved.administratorId) {
    return { ok: false, code: "snapshot_admin_mismatch" };
  }
  const sameBinding = clean(parentSku).toLowerCase() === saved.parentSku.toLowerCase()
    && clean(productId) === saved.productId
    && clean(sourceItemId) === saved.sourceItemId
    && clean(vendorId) === saved.vendorId;
  if (!sameBinding) return { ok: false, code: "pilot_not_authorized" };
  return { ok: true, snapshot: saved };
}

export function clearOwnershipAuthorizations() {
  authorizationSnapshots.clear();
}
