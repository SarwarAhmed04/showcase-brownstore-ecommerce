import crypto from "crypto";

export const GINI_USER_AGENT = "BrownStore/1.0 (GINI Merchant API)";
export const GINI_PING_PATH = "/api/v2.0/third-party/ping";
export const GINI_CATEGORIES_PATH = "/api/v2.0/third-party/categories";

/** Full request path only: no host and no query string. */
export function giniRequestPath(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) {
    const error = new Error("GINI request path is required");
    error.status = 500;
    throw error;
  }
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return url.pathname || "/";
  }
  const path = raw.split("?")[0].split("#")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

export function giniTimestampSeconds(now = new Date()) {
  return String(Math.floor(now.getTime() / 1000));
}

/**
 * signing_string = METHOD + PATH + BODY + TIMESTAMP
 * signature = lowercase hex HMAC-SHA256(signing_string, clientSecret)
 *
 * GET and DELETE always sign an empty body. JSON callers must pass the exact
 * raw body string that will be sent. This helper does not re-serialize it.
 */
export function signGiniRequest({ method, path, body = "", timestamp, clientSecret }) {
  const verb = String(method || "GET").trim().toUpperCase();
  const signingPath = giniRequestPath(path);
  const rawBody = verb === "GET" || verb === "DELETE" ? "" : String(body ?? "");
  const stamp = String(timestamp || giniTimestampSeconds());
  if (!/^\d{1,12}$/.test(stamp)) {
    const error = new Error("GINI timestamp must be unix seconds");
    error.status = 500;
    throw error;
  }
  const signingString = `${verb}${signingPath}${rawBody}${stamp}`;
  const signature = crypto.createHmac("sha256", String(clientSecret || "")).update(signingString).digest("hex");
  return {
    method: verb,
    path: signingPath,
    body: rawBody,
    timestamp: stamp,
    signature,
  };
}

export function giniAuthHeaders({ clientId, signature, timestamp }) {
  return {
    Accept: "application/json",
    "User-Agent": GINI_USER_AGENT,
    "X-API-KEY": String(clientId || ""),
    "X-TIMESTAMP": String(timestamp),
    "X-SIGNATURE": String(signature),
  };
}
