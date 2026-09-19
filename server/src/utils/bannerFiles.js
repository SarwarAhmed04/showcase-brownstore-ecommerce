import fs from "fs";
import path from "path";
import { UPLOAD_ROOT } from "./categoryView.js";

export function saveBannerImageFile(slot, dataUrl) {
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
  if (!buf.length || buf.length > 6 * 1024 * 1024) {
    const err = new Error("Image too large");
    err.status = 400;
    throw err;
  }
  const dir = path.join(UPLOAD_ROOT, "banners");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `banner-${slot}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  return `/media/local/banners/${filename}`;
}

export function removeLocalBannerImage(imagePath) {
  if (!String(imagePath || "").includes("/media/local/banners/")) return;
  const name = path.basename(imagePath);
  const dir = path.resolve(UPLOAD_ROOT, "banners");
  const file = path.resolve(dir, name);
  if (!file.startsWith(dir)) return;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
