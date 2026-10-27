export function sanitizeElryanText(message, secrets = [], maxLength = 400) {
  let text = String(message || "");
  const values = [...secrets]
    .map((secret) => String(secret || ""))
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of values) text = text.split(secret).join("[redacted]");
  text = text
    .replace(/x-api-key\s*[:=]\s*\S+/gi, "x-api-key: [redacted]")
    .replace(/authorization\s*[:=]\s*bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/elryan-[A-Za-z0-9._\-]+/gi, "elryan-[redacted]");
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 400;
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function assertNoElryanSecretLeak(payload, submittedSecret = "") {
  const json = JSON.stringify(payload);
  const secret = String(submittedSecret || "");
  if (
    json.includes("apiKeyEnc") ||
    json.includes("\"apiKey\"") ||
    /elryan-[A-Za-z0-9._\-]{8,}/.test(json) ||
    (secret.length >= 4 && json.includes(secret))
  ) {
    const error = new Error("Refusing to return Elryan secret");
    error.status = 500;
    throw error;
  }
  return payload;
}
