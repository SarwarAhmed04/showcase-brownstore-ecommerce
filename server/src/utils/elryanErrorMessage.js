/**
 * Parse documented Elryan error bodies into a safe, readable message.
 * Shape: { success: false, error: { code, message }, meta? }
 * Never invents empty-children semantics from HTTP status alone.
 */

export function parseElryanErrorPayload(json, text = "") {
  let code = "";
  let message = "";

  if (json && typeof json === "object" && !Array.isArray(json)) {
    const errObj = json.error && typeof json.error === "object" ? json.error : null;
    code = String(errObj?.code || json.code || "").trim();
    message = String(errObj?.message || json.message || "").trim();
  }

  if (!message && text) {
    const raw = String(text).trim();
    if (raw.startsWith("{")) {
      try {
        return parseElryanErrorPayload(JSON.parse(raw), "");
      } catch {
        message = raw.slice(0, 400);
      }
    } else {
      message = raw.slice(0, 400);
    }
  }

  return { code, message };
}

export function formatElryanReadError(result = {}) {
  const httpStatus = Number(result.httpStatus) || 0;
  const parsed = parseElryanErrorPayload(result.json, result.text);
  const code = parsed.code || "elryan_read_failed";
  let message;
  if (parsed.code && parsed.message) {
    message = `${parsed.code} — ${parsed.message}`;
  } else if (parsed.message) {
    message = parsed.message;
  } else if (parsed.code) {
    message = parsed.code;
  } else {
    message = result.text || `Elryan read failed (${httpStatus || "unknown"})`;
  }
  return {
    code,
    message,
    elryanCode: parsed.code || "",
    httpStatus,
  };
}

export function formatElryanChildrenLoadError({
  kind,
  categoryId,
  status,
  code,
  message,
} = {}) {
  const idLabel = categoryId != null && categoryId !== "" ? String(categoryId) : "unknown";
  const errCode = String(code || "").trim() || "NOT_FOUND";
  if (kind === "parent" && Number(status) === 404) {
    return (
      `Category children returned ${errCode} for parent category ${idLabel}. ` +
      "This may be an API or data inconsistency."
    );
  }
  return String(message || "").trim() || `Failed to load category children (${status || "error"})`;
}
