/** First Staging create is limited to this SKU. The server send endpoint enforces the same limit. */
export const ELRYAN_STAGING_SEND_SKU = "OWCH180002";

const BLOCKING_ATTEMPT = new Set(["succeeded", "uncertain", "in_progress"]);

/**
 * Whether the Staging send button may open the confirmation dialog.
 * This reads fields the server already returned. The send endpoint still decides whether a create is allowed.
 */
export function elryanStagingSendGate({ preview, writesGate, now = Date.now(), localHold = "" } = {}) {
  const hold = String(localHold || "");
  if (BLOCKING_ATTEMPT.has(hold)) {
    return { enabled: false, reason: "send_attempt_blocked" };
  }
  if (!preview) return { enabled: false, reason: "preview_required" };

  const environment = String(preview.connection?.environment || "").toLowerCase();
  if (environment !== "staging") return { enabled: false, reason: "staging_only" };

  const productWritesEnabled = writesGate?.productWritesEnabled === true;
  const liveWritesAllowed = writesGate?.liveWritesAllowed === true;
  if (!productWritesEnabled && !liveWritesAllowed) return { enabled: false, reason: "writes_disabled" };
  if (!productWritesEnabled || !liveWritesAllowed) return { enabled: false, reason: "writes_partial" };

  if (String(preview.product?.sku || "") !== ELRYAN_STAGING_SEND_SKU) {
    return { enabled: false, reason: "wrong_sku" };
  }
  if (preview.readiness !== "READY") return { enabled: false, reason: "not_ready" };
  if (!Array.isArray(preview.blockers) || preview.blockers.length > 0) {
    return { enabled: false, reason: "blockers" };
  }

  const token = String(preview.previewToken || "").trim();
  if (!token) return { enabled: false, reason: "preview_required" };
  const expiresAt = new Date(preview.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { enabled: false, reason: "token_expired" };

  const attemptStatus = String(preview.sendAttempt?.status || "");
  if (preview.sendAttempt?.blocked === true || BLOCKING_ATTEMPT.has(attemptStatus)) {
    return { enabled: false, reason: "send_attempt_blocked" };
  }

  return { enabled: true, reason: "" };
}

/**
 * Send body for the existing Sync One endpoint.
 * A closed gate or a missing explicit confirmation returns null, so the screen does not call send.
 */
export function elryanStagingSendRequest({ preview, writesGate, now, localHold, confirm } = {}) {
  if (!elryanStagingSendGate({ preview, writesGate, now, localHold }).enabled) return null;
  return buildElryanStagingSendBody(preview, confirm);
}

/** Returns the existing send body only after an explicit confirmation. */
export function buildElryanStagingSendBody(preview, confirm) {
  if (confirm !== true) return null;
  const productId = String(preview?.product?.id || "").trim();
  const previewToken = String(preview?.previewToken || "").trim();
  if (!productId || !previewToken) return null;
  return { productId, previewToken, confirm: true };
}

export function elryanStagingSendConfirmFacts(preview) {
  const payloadImages = preview?.proposedPayload?.images;
  const productImages = preview?.product?.images;
  let image = "";
  if (Array.isArray(payloadImages) && payloadImages[0]?.fileUrl) image = String(payloadImages[0].fileUrl);
  else if (Array.isArray(productImages) && productImages.length) {
    const first = productImages[0];
    image = typeof first === "string" ? first : String(first?.fileUrl || "");
  }
  const environment = String(preview?.connection?.environment || "").toLowerCase();
  return {
    name: preview?.product?.name || {},
    sku: String(preview?.product?.sku || ""),
    environment: environment === "staging" ? "STAGING" : environment.toUpperCase(),
    price: preview?.pricing?.proposedElryanPrice ?? preview?.proposedPayload?.price ?? null,
    currency: "IQD",
    image,
    quantity: preview?.proposedPayload?.quantity ?? preview?.product?.stock ?? null,
    createsRealStagingProduct: environment === "staging",
  };
}

const UNCERTAIN = new Set(["send_uncertain", "create_uncertain", "create_uncertain_sku_taken"]);
const PREVIEW_INVALID = new Set(["preview_expired", "preview_mismatch", "preview_used", "preview_required"]);

/**
 * Maps a send response onto operator-facing result lines.
 * "published" is included only when the response itself says the product was published.
 */
export function describeElryanSendResult(result) {
  const code = String(result?.code || "");
  if (code === "created_and_published" && result?.published === true) {
    return {
      kind: "published",
      lines: ["created", "published"],
      retryBlocked: true,
      hold: "succeeded",
      tokenConsumed: true,
    };
  }
  if ((code === "created" || code === "created_and_published") && result?.ok === true && result?.published !== true) {
    return {
      kind: "created_in_review",
      lines: ["created", "in_review"],
      retryBlocked: true,
      hold: "succeeded",
      tokenConsumed: true,
    };
  }
  if (code === "created" && result?.ok === true) {
    return {
      kind: "created_in_review",
      lines: ["created", "in_review"],
      retryBlocked: true,
      hold: "succeeded",
      tokenConsumed: true,
    };
  }
  if (code === "elryan_rejected") {
    return { kind: "validation_error", lines: ["validation_error"], retryBlocked: false, hold: "", tokenConsumed: true };
  }
  if (code === "already_sent" || code === "sku_already_created") {
    return { kind: "already_sent", lines: ["already_sent"], retryBlocked: true, hold: "succeeded", tokenConsumed: false };
  }
  if (code === "send_in_progress") {
    return { kind: "in_progress", lines: ["in_progress"], retryBlocked: true, hold: "in_progress", tokenConsumed: false };
  }
  if (UNCERTAIN.has(code)) {
    return {
      kind: "uncertain",
      lines: ["uncertain"],
      retryBlocked: true,
      hold: "uncertain",
      tokenConsumed: code !== "send_uncertain",
    };
  }
  if (PREVIEW_INVALID.has(code)) {
    return {
      kind: "preview_invalid",
      lines: ["preview_invalid"],
      retryBlocked: false,
      hold: "",
      tokenConsumed: code === "preview_used",
    };
  }
  if (code === "writes_disabled" || code === "writes_gated") {
    return { kind: "writes_disabled", lines: ["writes_disabled"], retryBlocked: false, hold: "", tokenConsumed: false };
  }
  if (code === "staging_only") {
    return { kind: "staging_only", lines: ["staging_only"], retryBlocked: false, hold: "", tokenConsumed: false };
  }
  return { kind: "other", lines: [], retryBlocked: false, hold: "", tokenConsumed: false };
}

/** The UI never retries a send on its own. */
export function shouldRetryElryanSend() {
  return false;
}
