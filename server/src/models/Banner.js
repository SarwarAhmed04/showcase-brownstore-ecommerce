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
  };
}

export function applyCopy(doc, fields) {
  doc.image = fields.image || "";
  doc.title = pickLoc(fields.title);
  doc.subtitle = pickLoc(fields.subtitle);
  doc.textAlign = isBannerAlign(fields.textAlign) || "bottom-start";
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
  }));
  if (missing.length) await Banner.insertMany(missing);
  return Banner.find().sort({ slot: 1 });
}

export function toPublicBanner(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  const image = String(raw.image || "");
  if (!image) return null;
  return {
    ...bannerSpec(raw.slot),
    image: cdnUrl(image),
    title: pickLoc(raw.title),
    subtitle: pickLoc(raw.subtitle),
    textAlign: isBannerAlign(raw.textAlign) || "bottom-start",
  };
}

export function toAdminBanner(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  return {
    ...bannerSpec(raw.slot),
    image: cdnUrl(raw.image || ""),
    title: pickLoc(raw.title),
    subtitle: pickLoc(raw.subtitle),
    textAlign: isBannerAlign(raw.textAlign) || "bottom-start",
  };
}
