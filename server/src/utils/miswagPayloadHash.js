import { createHash } from "node:crypto";

/** Bump when canonical payload fingerprint rules change. Stored beside the hash, not inside it. */
export const MISWAG_PAYLOAD_HASH_VERSION = 1;

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * SHA-256 of the exact Miswag item payload.
 * Object keys are sorted. Array order and value types are preserved.
 * The caller must pass `built.payload` (barcodeSource is already removed there).
 */
export function miswagPayloadHash(payload) {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
