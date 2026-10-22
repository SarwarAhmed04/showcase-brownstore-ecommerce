import { MiswagProductSyncState } from "../models/MiswagProductSyncState.js";
import { MISWAG_PAYLOAD_HASH_VERSION, miswagPayloadHash } from "../utils/miswagPayloadHash.js";

let syncStateLookupCount = 0;

export function miswagSyncStateLookupCount() {
  return syncStateLookupCount;
}

export function resetMiswagSyncStateLookupCount() {
  syncStateLookupCount = 0;
}

/** One query for the whole batch. Empty input does not touch the database. */
export async function loadMiswagSyncStateMap(externalIds) {
  const ids = [...new Set((externalIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  syncStateLookupCount += 1;
  const rows = await MiswagProductSyncState.find({
    partner: "miswag",
    externalId: { $in: ids },
  }).lean();
  return new Map(rows.map((row) => [row.externalId, row]));
}

export function classifyMiswagPayload(payload, previous) {
  const currentPayloadHash = miswagPayloadHash(payload);
  const previousHash = String(previous?.lastPayloadHash || "");
  if (!previous || !previousHash) {
    return { changeType: "new", currentPayloadHash };
  }
  if (Number(previous.hashVersion) !== MISWAG_PAYLOAD_HASH_VERSION) {
    return { changeType: "changed", currentPayloadHash };
  }
  if (previousHash === currentPayloadHash) {
    return { changeType: "unchanged", currentPayloadHash };
  }
  return { changeType: "changed", currentPayloadHash };
}

/** Record the payload Miswag accepted. Does not store the payload, secrets, or headers. */
export async function saveMiswagAcceptedPayload({
  productId = "",
  ibsherId = "",
  externalId = "",
  payload,
  httpStatus = 0,
  miswagProductId = "",
} = {}) {
  const id = String(externalId || payload?.external_id || "").trim();
  if (!id || !payload || typeof payload !== "object") return null;
  const lastPayloadHash = miswagPayloadHash(payload);
  return MiswagProductSyncState.findOneAndUpdate(
    { partner: "miswag", externalId: id },
    {
      $set: {
        partner: "miswag",
        productId: String(productId || ""),
        ibsherId: String(ibsherId || ""),
        externalId: id,
        lastPayloadHash,
        lastSyncedAt: new Date(),
        lastHttpStatus: Number(httpStatus) || 0,
        miswagProductId: String(miswagProductId || ""),
        hashVersion: MISWAG_PAYLOAD_HASH_VERSION,
      },
    },
    { upsert: true, new: true }
  );
}
