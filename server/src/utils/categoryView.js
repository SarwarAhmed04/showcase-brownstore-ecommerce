import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cdnUrl } from "./productView.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_ROOT = path.resolve(__dirname, "../../data/uploads");

function pickName(over = {}, source = {}) {
  return {
    ku: String(over.ku || "").trim() || source.ku || "",
    en: String(over.en || "").trim() || source.en || "",
    ar: String(over.ar || "").trim() || source.ar || "",
  };
}

export function categoryImage(doc) {
  const over = doc.overrides?.image;
  if (over) return cdnUrl(over);
  return cdnUrl(doc.images?.[0]?.url);
}

export function toPublicCategory(doc) {
  const raw = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const over = raw.overrides || {};
  return {
    id: raw.ibsherId,
    name: pickName(over.name, raw.name),
    image: categoryImage(raw),
  };
}

export function toAdminCategory(doc) {
  const raw = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const over = raw.overrides || {};
  return {
    id: raw.ibsherId,
    name: pickName(over.name, raw.name),
    image: categoryImage(raw),
    sourceName: raw.name || { ku: "", en: "", ar: "" },
    sourceImage: cdnUrl(raw.images?.[0]?.url),
    customImage: Boolean(over.image),
    overrides: {
      name: {
        ku: over.name?.ku || "",
        en: over.name?.en || "",
        ar: over.name?.ar || "",
      },
      image: over.image || "",
    },
  };
}

export function saveCategoryImageFile(ibsherId, dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:image\/(jpeg|jpg|png|webp|gif);base64,([a-zA-Z0-9+/=\s]+)$/i
  );
  if (!match) {
    const err = new Error("Invalid image");
    err.status = 400;
    throw err;
  }
  const extRaw = match[1].toLowerCase();
  const ext = extRaw === "jpeg" || extRaw === "jpg" ? "jpg" : extRaw;
  const buf = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buf.length || buf.length > 4.5 * 1024 * 1024) {
    const err = new Error("Image too large");
    err.status = 400;
    throw err;
  }
  const dir = path.join(UPLOAD_ROOT, "categories");
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(ibsherId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "cat";
  const filename = `${safe}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return `/media/local/categories/${filename}`;
}

export function removeLocalCategoryImage(imagePath) {
  if (!String(imagePath || "").includes("/media/local/categories/")) return;
  const name = path.basename(imagePath);
  const dir = path.resolve(UPLOAD_ROOT, "categories");
  const file = path.resolve(dir, name);
  if (!file.startsWith(dir)) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function savePartnerImageFile(slug, dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:image\/(jpeg|jpg|png|webp|gif);base64,([a-zA-Z0-9+/=\s]+)$/i
  );
  if (!match) {
    const err = new Error("Invalid image");
    err.status = 400;
    throw err;
  }
  const extRaw = match[1].toLowerCase();
  const ext = extRaw === "jpeg" || extRaw === "jpg" ? "jpg" : extRaw;
  const buf = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buf.length || buf.length > 4.5 * 1024 * 1024) {
    const err = new Error("Image too large");
    err.status = 400;
    throw err;
  }
  const dir = path.join(UPLOAD_ROOT, "partners");
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(slug).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "partner";
  const filename = `${safe}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return `/media/local/partners/${filename}`;
}

export function removeLocalPartnerImage(imagePath) {
  if (!String(imagePath || "").includes("/media/local/partners/")) return;
  const name = path.basename(imagePath);
  const dir = path.resolve(UPLOAD_ROOT, "partners");
  const file = path.resolve(dir, name);
  if (!file.startsWith(dir)) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
