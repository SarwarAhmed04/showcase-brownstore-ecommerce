import fs from "node:fs";
import path from "node:path";

export const IBSHER_AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const IBSHER_CATALOG_SYNC_PAUSE_FILE = "ibsher-catalog-sync.paused";

const PAUSE_LOG = "IBSHER catalog auto-sync is paused (IBSHER_CATALOG_SYNC_PAUSED or ibsher-catalog-sync.paused). Startup sync and the hourly schedule were not started.";
export const PAUSED_CATALOG_SYNC_AUTHORIZATION = "ALLOW_PAUSED_IBSHER_CATALOG_SYNC";

export function pausedCatalogSyncAuthorized(body) {
  return body?.authorizePausedCatalogSync === PAUSED_CATALOG_SYNC_AUTHORIZATION;
}

/** The dashboard Refresh Products request has no authorization field, so a pause refuses it. */
export function manualCatalogSyncAllowed({ env = process.env, pauseFileExists = null, body = null } = {}) {
  const paused = catalogSyncPaused(env, { pauseFileExists });
  if (!paused) return { allowed: true, paused: false, authorized: false };
  if (pausedCatalogSyncAuthorized(body)) return { allowed: true, paused: true, authorized: true };
  return { allowed: false, paused: true, authorized: false };
}

/** Production keeps the existing always-on schedule unless the catalog pause is set. */
export function catalogSyncPaused(env = process.env, { pauseFileExists = null } = {}) {
  const value = String(env.IBSHER_CATALOG_SYNC_PAUSED || "").trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (typeof pauseFileExists === "function") return Boolean(pauseFileExists());
  return false;
}

export function ibsherAutoSyncEnabled(env = process.env, options = {}) {
  if (catalogSyncPaused(env, options)) return false;
  if (env.NODE_ENV === "production") return true;
  return env.IBSHER_AUTO_SYNC_ENABLED === "true";
}

export function defaultPauseFileExists(cwd = process.cwd()) {
  return fs.existsSync(path.resolve(cwd, IBSHER_CATALOG_SYNC_PAUSE_FILE));
}

/**
 * Starts the immediate import and hourly timer only when enabled.
 * The manual admin sync route does not use this helper.
 * A production restart with the pause flag or pause file does not sync.
 */
export function startIbsherAutoSync({
  env = process.env,
  sync,
  setTimer = setInterval,
  intervalMs = IBSHER_AUTO_SYNC_INTERVAL_MS,
  onError = (err) => console.error("Catalog sync failed:", err?.message || err),
  log = console.warn,
  pauseFileExists = () => defaultPauseFileExists(),
} = {}) {
  const pauseOptions = { pauseFileExists };
  if (catalogSyncPaused(env, pauseOptions)) {
    log(PAUSE_LOG);
    return { enabled: false, paused: true, timer: null };
  }
  if (!ibsherAutoSyncEnabled(env, pauseOptions)) return { enabled: false, paused: false, timer: null };
  const refreshCatalog = () => {
    if (catalogSyncPaused(env, pauseOptions)) {
      log("IBSHER catalog auto-sync tick skipped because catalog sync is paused.");
      return;
    }
    sync().catch(onError);
  };
  refreshCatalog();
  return { enabled: true, paused: false, timer: setTimer(refreshCatalog, intervalMs) };
}
