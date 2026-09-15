import crypto from "crypto";
import { Partner, PARTNER_DEFS, PARTNER_SLUGS } from "../models/Partner.js";

export { PARTNER_DEFS, PARTNER_SLUGS };

const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyPartner(name) {
  const ascii = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || "platform";
}

export function isPartnerSlug(value) {
  const slug = String(value || "").toLowerCase().trim();
  return slug.length >= 2 && slug.length <= 48 && SLUG_RX.test(slug);
}

export async function uniquePartnerSlug(name, excludeId) {
  const base = slugifyPartner(name);
  let slug = base;
  let n = 2;
  while (true) {
    const existing = await Partner.findOne({ slug });
    if (!existing || (excludeId && String(existing._id) === String(excludeId))) {
      return slug;
    }
    slug = `${base}-${n}`;
    n += 1;
  }
}

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function generateApiKey(slug) {
  const secret = crypto.randomBytes(24).toString("base64url");
  const key = `bs_${slug}_${secret}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: `${key.slice(0, 18)}…`,
  };
}

export function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:5000")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

export function partnerCatalogUrl(req, slug) {
  return `${requestOrigin(req)}/api/partners/${slug}/products`;
}

export function toAdminPartner(doc, req, extra = {}) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  const slug = raw.slug;
  return {
    slug,
    name: raw.name,
    image: raw.image || "",
    isActive: raw.isActive !== false,
    hasApiKey: Boolean(raw.apiKeyHash),
    apiKeyPrefix: raw.apiKeyPrefix || "",
    catalogUrl: req ? partnerCatalogUrl(req, slug) : `/api/partners/${slug}/products`,
    categoriesUrl: req
      ? `${requestOrigin(req)}/api/partners/${slug}/categories`
      : `/api/partners/${slug}/categories`,
    ...extra,
  };
}

function readIncomingKey(req) {
  const header = String(req.headers["x-api-key"] || "").trim();
  if (header) return header;
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return "";
}

export async function requirePartner(req, res, next) {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!isPartnerSlug(slug)) {
      return res.status(404).json({ message: "Unknown partner" });
    }

    const key = readIncomingKey(req);
    if (!key) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const partner = await Partner.findOne({ slug, isActive: { $ne: false } });
    if (!partner?.apiKeyHash) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const incoming = hashApiKey(key);
    const expected = String(partner.apiKeyHash);
    if (incoming.length !== expected.length) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const left = Buffer.from(incoming, "hex");
    const right = Buffer.from(expected, "hex");
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    req.partner = partner;
    next();
  } catch (err) {
    next(err);
  }
}
