import { ELRYAN_READINESS } from "./elryanConstants.js";
import { publicMediaUrl } from "./commissionExcel.js";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
let mediaFetch = globalThis.fetch;

export function setElryanMediaFetchForTests(fn) {
  mediaFetch = typeof fn === "function" ? fn : globalThis.fetch;
}

function isLocalHost(hostname) {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(hostname || ""));
}

export function brownStoreMediaOrigin() {
  try {
    return new URL(publicMediaUrl("/uploads/products/check.webp")).origin;
  } catch {
    return "";
  }
}

export function isBrownStoreMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.origin === brownStoreMediaOrigin() &&
    url.pathname.startsWith("/api/media/uploads/products/") &&
    !url.pathname.includes("..")
  );
}

/**
 * Relative BrownStore uploads use the public media host and `/api/media`.
 * The admin request origin is ignored, so localhost is never the image host.
 * An absolute HTTPS URL that is already public is kept as stored.
 */
export function resolveElryanImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !isLocalHost(url.hostname) && !url.username && !url.password) {
        return url.href;
      }
      if (!/uploads\/products\//i.test(url.pathname)) return "";
      return isBrownStoreMediaUrl(publicMediaUrl(url.pathname)) ? publicMediaUrl(url.pathname) : "";
    } catch {
      return "";
    }
  }
  if (!/uploads\/products\//i.test(value)) return "";
  const resolved = publicMediaUrl(value);
  return isBrownStoreMediaUrl(resolved) ? resolved : "";
}

export function collectElryanImageUrls(resolved) {
  const urls = [];
  const seen = new Set();
  function push(url) {
    const next = resolveElryanImageUrl(url);
    if (!next || seen.has(next)) return;
    seen.add(next);
    urls.push(next);
  }
  for (const variant of resolved?.variants || []) {
    for (const image of variant.images || []) push(image?.url);
  }
  push(resolved?.image);
  return urls;
}

function imageKind(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const gif = bytes.slice(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  return "";
}

function unreachable(url) {
  return {
    code: "image_unreachable",
    status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
    message: `The public product image did not return image content (${url}).`,
  };
}

async function imageContentOk(url, fetchImpl) {
  const response = await fetchImpl(url, { method: "GET", redirect: "follow" });
  const status = Number(response?.status) || 0;
  if (status !== 200) return false;
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) return false;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return false;
  return Boolean(imageKind(bytes));
}

/** Live-check BrownStore media URLs. Other absolute HTTPS URLs are left unchanged. */
export async function verifyElryanPublicImages(urls, fetchImpl = mediaFetch) {
  const blockers = [];
  for (const url of urls || []) {
    if (!isBrownStoreMediaUrl(url)) continue;
    try {
      const ok = await imageContentOk(url, fetchImpl);
      if (!ok) blockers.push(unreachable(url));
    } catch {
      blockers.push(unreachable(url));
    }
  }
  return blockers;
}
