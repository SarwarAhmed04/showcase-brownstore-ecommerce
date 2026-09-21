import mongoose from "mongoose";
import { cdnUrl } from "../utils/productView.js";

const SLOTS = [1, 2, 3, 4, 5];
export const BANNER_ALIGNS = [
  "top-start",
  "top-center",
  "top-end",
  "middle-start",
  "middle-center",
  "middle-end",
  "bottom-start",
  "bottom-center",
  "bottom-end",
];

export const BANNER_DURATIONS = ["1d", "7d", "30d", "unlimited"];
const DURATION_DAYS = { "1d": 1, "7d": 7, "30d": 30 };

const locSchema = {
  ku: { type: String, default: "" },
  en: { type: String, default: "" },
  ar: { type: String, default: "" },
};

const bannerSchema = new mongoose.Schema(
  {
    slot: { type: Number, required: true, unique: true, min: 1, max: 5 },
    image: { type: String, default: "" },
    title: locSchema,
    subtitle: locSchema,
    textAlign: { type: String, enum: BANNER_ALIGNS, default: "bottom-start" },
    link: { type: String, default: "" },
    duration: { type: String, enum: BANNER_DURATIONS, default: "unlimited" },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Banner = mongoose.model("Banner", bannerSchema);

export function isBannerSlot(value) {
  const slot = Number(value);
  return SLOTS.includes(slot) ? slot : 0;
}

export function isBannerAlign(value) {
  return BANNER_ALIGNS.includes(String(value || "")) ? String(value) : "";
}

export function isBannerDuration(value) {
  return BANNER_DURATIONS.includes(String(value || "")) ? String(value) : "";
}

export function sanitizeBannerLink(value) {
  let raw = String(value || "").trim();
  if (!raw || raw.startsWith("//")) return "";
  if (raw.startsWith("/") && !raw.includes("://")) {
    return raw.slice(0, 500);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

export function applyDuration(doc, duration) {
  const next = isBannerDuration(duration);
  if (!next) return;
  if (next === "unlimited") {
    doc.duration = "unlimited";
    doc.expiresAt = null;
    return;
  }
  const days = DURATION_DAYS[next];
  const expired = doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now();
  if (doc.duration !== next || !doc.expiresAt || expired) {
    doc.expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
  doc.duration = next;
}

export function isBannerLive(doc, now = Date.now()) {
  if (!String(doc?.image || "")) return false;
  if (!doc?.expiresAt) return true;
  return new Date(doc.expiresAt).getTime() > now;
}

export function emptyLoc() {
  return { ku: "", en: "", ar: "" };
}

export function pickLoc(value, fallback = emptyLoc()) {
  const src = value && typeof value === "object" ? value : {};
  return {
    ku: String(src.ku ?? fallback.ku ?? "").trim(),
    en: String(src.en ?? fallback.en ?? "").trim(),
    ar: String(src.ar ?? fallback.ar ?? "").trim(),
  };
}

export function bannerSpec(slot) {
  if (slot <= 3) {
    return { slot, group: "slider", width: 1920, height: 720 };
  }
  return { slot, group: "inline", width: 1600, height: 480 };
}

export function copyFields(doc) {
  return {
    image: String(doc.image || ""),
    title: pickLoc(doc.title),
    subtitle: pickLoc(doc.subtitle),
    textAlign: isBannerAlign(doc.textAlign) || "bottom-start",
    link: String(doc.link || ""),
    duration: isBannerDuration(doc.duration) || "unlimited",
    expiresAt: doc.expiresAt || null,
  };
}

export function applyCopy(doc, fields) {
  doc.image = fields.image || "";
  doc.title = pickLoc(fields.title);
  doc.subtitle = pickLoc(fields.subtitle);
  doc.textAlign = isBannerAlign(fields.textAlign) || "bottom-start";
  doc.link = String(fields.link || "");
  doc.duration = isBannerDuration(fields.duration) || "unlimited";
  doc.expiresAt = fields.expiresAt || null;
}

export async function ensureBanners() {
  const existing = await Banner.find().sort({ slot: 1 });
  const have = new Set(existing.map((doc) => doc.slot));
  const missing = SLOTS.filter((slot) => !have.has(slot)).map((slot) => ({
    slot,
    image: "",
    title: emptyLoc(),
    subtitle: emptyLoc(),
    textAlign: "bottom-start",
    link: "",
    duration: "unlimited",
    expiresAt: null,
  }));
  if (missing.length) await Banner.insertMany(missing);
  return Banner.find().sort({ slot: 1 });
}

export function toPublicBanner(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  if (!isBannerLive(raw)) return null;
  return {
    ...bannerSpec(raw.slot),
    image: cdnUrl(raw.image),
    title: pickLoc(raw.title),
    subtitle: pickLoc(raw.subtitle),
    textAlign: isBannerAlign(raw.textAlign) || "bottom-start",
    link: sanitizeBannerLink(raw.link),
  };
}

export function toAdminBanner(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  const duration = isBannerDuration(raw.duration) || "unlimited";
  const expiresAt = raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null;
  const expired = Boolean(raw.expiresAt && new Date(raw.expiresAt).getTime() <= Date.now());
  return {
    ...bannerSpec(raw.slot),
    image: cdnUrl(raw.image || ""),
    title: pickLoc(raw.title),
    subtitle: pickLoc(raw.subtitle),
    textAlign: isBannerAlign(raw.textAlign) || "bottom-start",
    link: String(raw.link || ""),
    duration,
    expiresAt,
    expired,
    live: isBannerLive(raw),
  };
}
