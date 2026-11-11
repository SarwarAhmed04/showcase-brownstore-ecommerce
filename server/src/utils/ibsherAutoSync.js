export const IBSHER_AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/** Production keeps the existing always-on schedule. Development requires an explicit true. */
export function ibsherAutoSyncEnabled(env = process.env) {
  if (env.NODE_ENV === "production") return true;
  return env.IBSHER_AUTO_SYNC_ENABLED === "true";
}

/**
 * Starts the existing immediate import and hourly timer only when enabled.
 * The manual admin sync route does not use this helper.
 */
export function startIbsherAutoSync({
  env = process.env,
  sync,
  setTimer = setInterval,
  intervalMs = IBSHER_AUTO_SYNC_INTERVAL_MS,
  onError = (err) => console.error("Catalog sync failed:", err?.message || err),
} = {}) {
  if (!ibsherAutoSyncEnabled(env)) return { enabled: false, timer: null };
  const refreshCatalog = () => {
    sync().catch(onError);
  };
  refreshCatalog();
  return { enabled: true, timer: setTimer(refreshCatalog, intervalMs) };
}
