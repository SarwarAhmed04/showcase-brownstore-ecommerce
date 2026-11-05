const EXISTING_EIGHT_GATES = Object.freeze([
  "GINI_BULK_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_BULK_WRITES",
  "GINI_UPDATE_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_UPDATE_WRITES",
  "GINI_IMAGE_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_IMAGE_WRITES",
  "GINI_RESYNC_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_RESYNC_WRITES",
]);

export function giniSkuCreateWritesEnabled(env = process.env) {
  return env.GINI_SKU_CREATE_WRITES_ENABLED === "true" && env.GINI_ALLOW_LIVE_SKU_CREATE === "true";
}

export function giniSyncOneWritesEnabled(env = process.env) {
  return env.GINI_SYNC_ONE_WRITES_ENABLED === "true" && env.GINI_ALLOW_LIVE_SYNC_ONE_WRITES === "true";
}

export function existingGiniWriteGatesEnabled(env = process.env) {
  return EXISTING_EIGHT_GATES.some((name) => env[name] === "true");
}
