import { cdnUrl } from "./productView.js";

/**
 * Browser URL for an ownership card. This is the Products admin resolver (`cdnUrl`):
 * IBSHER CDN hosts become `/api/media/...`, and relative BrownStore paths use that
 * same media prefix. Credentialed URLs and non-http schemes are dropped. Nothing
 * is fetched or re-uploaded here.
 */
export function resolveOwnershipImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.includes("..")) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return "";
    } catch {
      return "";
    }
  }
  const resolved = String(cdnUrl(value) || "").trim();
  if (!resolved || resolved.includes("..")) return "";
  return resolved;
}

export function resolveOwnershipImageUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of values || []) {
    const next = resolveOwnershipImageUrl(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    urls.push(next);
    if (urls.length >= 8) break;
  }
  return urls;
}
