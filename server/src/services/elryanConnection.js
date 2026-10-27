import { decryptApiKey, encryptApiKey } from "../utils/partnerAuth.js";
import {
  ELRYAN_DEFAULT_ENVIRONMENT,
  ELRYAN_PATHS,
  elryanEnvironmentConfig,
  elryanProductWritesEnabled,
} from "../utils/elryanConstants.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";
import { ElryanConnection } from "../models/ElryanConnection.js";
import {
  ElryanClientError,
  elryanBaseForEnvironment,
  elryanRequest,
  validateElryanBaseUrl,
} from "./elryanClient.js";

const SECRET_SELECT = "+apiKeyEnc +stagingApiKeyEnc +productionApiKeyEnc";

function tryDecrypt(enc) {
  if (!enc) return { ok: false, value: "", error: false };
  try {
    const value = decryptApiKey(enc);
    if (!String(value || "").trim()) return { ok: false, value: "", error: false };
    return { ok: true, value: String(value).trim(), error: false };
  } catch {
    return { ok: false, value: "", error: true };
  }
}

function envKeyField(environment) {
  return environment === "production" ? "productionApiKeyEnc" : "stagingApiKeyEnc";
}

function encForEnvironment(stored, environment) {
  if (!stored) return "";
  const primary = stored[envKeyField(environment)];
  if (primary) return primary;
  // Legacy single-slot key applies only when it matches the saved environment (or no env set).
  const legacyEnv = normalizeEnvironment(stored.environment || ELRYAN_DEFAULT_ENVIRONMENT);
  if (stored.apiKeyEnc && legacyEnv === environment) return stored.apiKeyEnc;
  return "";
}

async function loadStored(withSecret = false) {
  const query = ElryanConnection.findOne({ singletonKey: "default" });
  if (withSecret) query.select(SECRET_SELECT);
  return query.lean();
}

function normalizeEnvironment(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value === "production" ? "production" : "staging";
}

function accessLabelFor(snapshot) {
  if (snapshot.decryptionError) return "Configuration error";
  if (!snapshot.keyStored) return "API key missing";
  if (snapshot.status === "authenticated") return "Authentication verified";
  if (snapshot.status === "auth_rejected" || snapshot.status === "auth_failed") {
    return "Authentication rejected";
  }
  if (snapshot.status === "reachable") return "API reachable, authentication not verified";
  if (snapshot.keyStored) return "API key securely stored";
  return "Awaiting Elryan API Access";
}

function buildPublicSnapshot(stored, { environment, keyStored, decryptionError, resolvedHasKey }) {
  const env = elryanEnvironmentConfig(environment);
  let status = "awaiting_access";
  if (decryptionError) status = "config_error";
  else if (!keyStored) status = "awaiting_access";
  else if (stored?.lastStatus === "authenticated" && stored?.lastAuthOk) status = "authenticated";
  else if (stored?.lastStatus === "auth_rejected" || stored?.lastStatus === "auth_failed") {
    status = stored.lastStatus;
  } else if (stored?.lastStatus === "reachable" || stored?.lastReachable) status = "reachable";
  else if (keyStored) status = "key_configured";

  const snapshot = {
    configured: keyStored,
    hasApiKey: keyStored,
    keyStored,
    decryptionError: Boolean(decryptionError),
    environment,
    baseUrl: env.baseUrl,
    apiRoot: env.apiRoot,
    status,
    reachable: Boolean(stored?.lastReachable),
    authenticated: status === "authenticated",
    lastAuthOk: Boolean(stored?.lastAuthOk),
    lastHttpStatus: stored?.lastHttpStatus || 0,
    lastEndpoint: stored?.lastEndpoint || "",
    lastError: stored?.lastError || "",
    lastTestedAt: stored?.lastTestedAt || null,
    lastSuccessAt: stored?.lastSuccessAt || null,
    lastAuthVerifiedAt: stored?.lastAuthVerifiedAt || null,
    lastClassification: stored?.lastClassification || "",
    writes: getElryanWritesGatePublic(),
  };
  snapshot.accessLabel = accessLabelFor(snapshot);
  void resolvedHasKey;
  return snapshot;
}

export function getElryanWritesGatePublic() {
  return {
    productWritesEnabled: elryanProductWritesEnabled(),
    envFlag: "ELRYAN_PRODUCT_WRITES_ENABLED",
    default: false,
    note: "Product create/update/bulk remain disabled until Elryan grants publishing and this flag is explicitly set to true after a separate review.",
  };
}

export async function getElryanConnectionPublic() {
  const stored = await loadStored(true);
  const environment = normalizeEnvironment(stored?.environment || ELRYAN_DEFAULT_ENVIRONMENT);
  const enc = encForEnvironment(stored, environment);
  const decrypted = tryDecrypt(enc);
  const keyStored = decrypted.ok;
  const decryptionError = Boolean(enc) && decrypted.error;
  return buildPublicSnapshot(stored, {
    environment,
    keyStored,
    decryptionError,
    resolvedHasKey: keyStored,
  });
}

export async function resolveElryanConfig(overrides = {}) {
  const stored = await loadStored(true);
  const environment = normalizeEnvironment(
    overrides.environment != null ? overrides.environment : stored?.environment
  );
  const env = elryanEnvironmentConfig(environment);
  const validated = validateElryanBaseUrl(env.baseUrl);
  if (!validated.ok) {
    throw new ElryanClientError(validated.message, { code: "invalid_base_url" });
  }

  const overrideKey =
    overrides.apiKey != null && String(overrides.apiKey).trim()
      ? String(overrides.apiKey).trim()
      : "";
  const enc = encForEnvironment(stored, environment);
  const decrypted = tryDecrypt(enc);

  if (enc && decrypted.error && !overrideKey) {
    throw new ElryanClientError(
      "Stored Elryan API key could not be decrypted. Re-save the key for this environment.",
      { status: 409, code: "config_error", classification: "READ" }
    );
  }

  const storedKey = decrypted.ok ? decrypted.value : "";
  const apiKey = overrideKey || storedKey;
  return {
    environment,
    baseUrl: validated.baseUrl,
    apiRoot: env.apiRoot,
    apiKey,
    hasApiKey: Boolean(apiKey),
    storedHasApiKey: Boolean(storedKey),
    temporaryKey: Boolean(overrideKey),
    decryptionError: Boolean(enc) && decrypted.error,
  };
}

export async function saveElryanConnection(input = {}) {
  const environment = normalizeEnvironment(input.environment);
  const env = elryanEnvironmentConfig(environment);
  const validated = validateElryanBaseUrl(env.baseUrl);
  if (!validated.ok) {
    throw new ElryanClientError(validated.message, { status: 400, code: "invalid_base_url" });
  }

  const existing = await ElryanConnection.findOne({ singletonKey: "default" }).select(SECRET_SELECT);
  const nextKey =
    input.apiKey != null && String(input.apiKey).trim() ? String(input.apiKey).trim() : "";

  const field = envKeyField(environment);
  const stagingEnc = existing?.stagingApiKeyEnc || "";
  const productionEnc = existing?.productionApiKeyEnc || "";
  const legacyEnc = existing?.apiKeyEnc || "";

  let nextStaging = stagingEnc;
  let nextProduction = productionEnc;

  // Adopt legacy single key into the environment it was last associated with (once).
  if (legacyEnc && !stagingEnc && !productionEnc) {
    const legacyEnv = normalizeEnvironment(existing?.environment || environment);
    if (legacyEnv === "production") nextProduction = legacyEnc;
    else nextStaging = legacyEnc;
  }

  if (nextKey) {
    if (!nextKey.startsWith("elryan-") && nextKey.length < 8) {
      throw new ElryanClientError("API key looks invalid.", { status: 400, code: "invalid_api_key" });
    }
    const sealed = encryptApiKey(nextKey);
    if (environment === "production") nextProduction = sealed;
    else nextStaging = sealed;
  }

  const currentEnc = environment === "production" ? nextProduction : nextStaging;
  const currentDecrypt = tryDecrypt(currentEnc);
  if (currentEnc && currentDecrypt.error) {
    throw new ElryanClientError(
      "Stored Elryan API key could not be decrypted. Paste a new key to replace it.",
      { status: 409, code: "config_error" }
    );
  }

  const keyStored = currentDecrypt.ok;
  const $set = {
    environment,
    stagingApiKeyEnc: nextStaging,
    productionApiKeyEnc: nextProduction,
    hasApiKey: keyStored,
  };

  // Clear legacy slot after env-specific fields are populated so we never dual-source ambiguously.
  if (nextStaging || nextProduction) {
    $set.apiKeyEnc = "";
  }

  // Saving a new key or switching env invalidates prior auth verification for the active env.
  if (nextKey || (existing && normalizeEnvironment(existing.environment) !== environment)) {
    $set.lastAuthOk = false;
    $set.lastStatus = keyStored ? "key_configured" : "awaiting_access";
    $set.lastAuthVerifiedAt = null;
  } else if (!keyStored) {
    $set.lastStatus = "awaiting_access";
    $set.lastAuthOk = false;
  }

  await ElryanConnection.findOneAndUpdate(
    { singletonKey: "default" },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return getElryanConnectionPublic();
}

async function persistTestResult(patch) {
  // Never invent hasApiKey / never clear encrypted key fields from test results.
  const safe = { ...patch };
  delete safe.apiKeyEnc;
  delete safe.stagingApiKeyEnc;
  delete safe.productionApiKeyEnc;
  delete safe.hasApiKey;
  await ElryanConnection.findOneAndUpdate(
    { singletonKey: "default" },
    { $set: safe },
    { upsert: true }
  );
}

/**
 * Explicit admin test: health (reachability) then authenticated categories?limit=1 when a key is available.
 * Temporary request keys are used for the probe only and are not persisted.
 */
export async function testElryanConnection(overrides = {}) {
  const started = new Date();
  const publicBefore = await getElryanConnectionPublic();
  let config;
  try {
    config = await resolveElryanConfig(overrides);
  } catch (err) {
    if (err?.code === "config_error") {
      await persistTestResult({
        lastStatus: "config_error",
        lastError: sanitizeElryanText(err.message, []),
        lastAuthOk: false,
        lastReachable: false,
        lastTestedAt: started,
        lastClassification: "READ",
        lastEndpoint: "",
      });
      return {
        ok: false,
        status: "config_error",
        message: err.message,
        code: "config_error",
        classification: "READ",
        keyPersisted: false,
        temporaryKey: false,
        connection: await getElryanConnectionPublic(),
      };
    }
    throw err;
  }

  const temporaryKey = Boolean(config.temporaryKey);
  const keyPersisted = Boolean(config.storedHasApiKey);

  // 1) Public health — reachability only (OpenAPI security: []).
  let health;
  try {
    health = await elryanRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      path: ELRYAN_PATHS.healthCheck,
      method: "GET",
      classification: "READ",
      timeoutMs: overrides.timeoutMs,
      retries: 1,
      allowMissingApiKey: true,
    });
  } catch (err) {
    const message = sanitizeElryanText(err?.message || "Health check failed", [config.apiKey]);
    await persistTestResult({
      environment: config.environment,
      lastStatus: keyPersisted ? "key_configured" : "awaiting_access",
      lastHttpStatus: err?.httpStatus || 0,
      lastEndpoint: ELRYAN_PATHS.healthCheck,
      lastError: message,
      lastAuthOk: false,
      lastReachable: false,
      lastTestedAt: started,
      lastClassification: "READ",
    });
    return {
      ok: false,
      status: "connection_failed",
      message,
      code: err?.code || "connection_failed",
      classification: "READ",
      reachable: false,
      authenticated: false,
      keyPersisted,
      temporaryKey,
      connection: await getElryanConnectionPublic(),
    };
  }

  const reachable = Boolean(health.ok);
  if (!reachable) {
    const message = sanitizeElryanText(
      health.json?.message || health.text || `Health check HTTP ${health.httpStatus}`,
      [config.apiKey]
    );
    await persistTestResult({
      environment: config.environment,
      lastStatus: keyPersisted ? "key_configured" : "awaiting_access",
      lastHttpStatus: health.httpStatus,
      lastEndpoint: ELRYAN_PATHS.healthCheck,
      lastError: message,
      lastAuthOk: false,
      lastReachable: false,
      lastTestedAt: started,
      lastClassification: "READ",
    });
    return {
      ok: false,
      status: "connection_failed",
      message,
      classification: "READ",
      reachable: false,
      authenticated: false,
      keyPersisted,
      temporaryKey,
      endpoint: ELRYAN_PATHS.healthCheck,
      connection: await getElryanConnectionPublic(),
    };
  }

  // No key at all → reachable only.
  if (!config.apiKey) {
    await persistTestResult({
      environment: config.environment,
      lastStatus: "reachable",
      lastHttpStatus: health.httpStatus,
      lastEndpoint: ELRYAN_PATHS.healthCheck,
      lastError: "",
      lastAuthOk: false,
      lastReachable: true,
      lastTestedAt: started,
      lastClassification: "READ",
    });
    return {
      ok: true,
      status: "reachable",
      message: "API is reachable. Authentication was not verified (no API key available).",
      classification: "READ",
      reachable: true,
      authenticated: false,
      keyPersisted: false,
      temporaryKey: false,
      endpoint: ELRYAN_PATHS.healthCheck,
      connection: await getElryanConnectionPublic(),
    };
  }

  // 2) Authenticated read — only on explicit test action.
  const authProbe = await elryanRequest({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    path: ELRYAN_PATHS.categories,
    method: "GET",
    query: { limit: 1, page: 1 },
    classification: "READ",
    timeoutMs: overrides.timeoutMs,
    retries: 1,
  });

  const authRejected = authProbe.httpStatus === 401 || authProbe.httpStatus === 403;
  const authenticated = Boolean(authProbe.ok);
  let status = "reachable";
  let message = "API is reachable. Authentication was not verified.";

  if (authenticated) {
    status = "authenticated";
    message = temporaryKey
      ? "Authentication verified with a temporary key. Save the key to persist it for catalog requests."
      : "Authentication verified (read-only categories probe).";
  } else if (authRejected) {
    status = "auth_rejected";
    message = sanitizeElryanText(
      authProbe.json?.message || authProbe.text || `Authentication rejected (HTTP ${authProbe.httpStatus})`,
      [config.apiKey]
    );
  } else {
    status = "reachable";
    message = sanitizeElryanText(
      authProbe.json?.message ||
        authProbe.text ||
        `API reachable, but authenticated categories probe returned HTTP ${authProbe.httpStatus}`,
      [config.apiKey]
    );
  }

  await persistTestResult({
    environment: config.environment,
    lastStatus: status,
    lastHttpStatus: authProbe.httpStatus,
    lastEndpoint: ELRYAN_PATHS.categories,
    lastError: authenticated ? "" : message,
    lastAuthOk: authenticated,
    lastReachable: true,
    lastTestedAt: started,
    lastSuccessAt: authenticated ? started : undefined,
    lastAuthVerifiedAt: authenticated ? started : undefined,
    lastClassification: "READ",
  });

  void publicBefore;
  return {
    ok: authenticated,
    status,
    message,
    classification: "READ",
    reachable: true,
    authenticated,
    keyPersisted,
    temporaryKey,
    endpoint: ELRYAN_PATHS.categories,
    httpStatus: authProbe.httpStatus,
    connection: await getElryanConnectionPublic(),
  };
}

/** Authenticated read helper used by catalog services — stored key only (no temp override). */
export async function elryanAuthedRead(path, { query, timeoutMs, retries = 1 } = {}) {
  const config = await resolveElryanConfig();
  if (!config.storedHasApiKey) {
    throw new ElryanClientError(
      config.decryptionError
        ? "Stored Elryan API key could not be decrypted. Re-save the key."
        : "Awaiting Elryan API Access",
      {
        status: 409,
        code: config.decryptionError ? "config_error" : "api_access_pending",
        classification: "READ",
      }
    );
  }
  return elryanRequest({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    path,
    method: "GET",
    query,
    timeoutMs,
    retries,
    classification: "READ",
  });
}

export { elryanBaseForEnvironment };
