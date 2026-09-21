// Turns a catalogue `img` value into a real URL.
// Unsplash photo ids get sized/cropped on the CDN; anything else (a path under
// /public, or a full URL) is passed straight through so you can drop in your
// own photography without touching component code.

const isUnsplashId = (v) => typeof v === 'string' && v.startsWith('photo-')

const API_URL = String(import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function mediaSrc(img) {
  if (typeof img !== "string" || !img) return img;
  if (/^https?:\/\//i.test(img) || img.startsWith("data:")) return img;
  const isApiMedia = img.startsWith("/api/media");
  if (!isApiMedia && !img.startsWith("/media")) return img;
  const path = isApiMedia ? img : `/api${img}`;
  if (!API_URL || /localhost|127\.0\.0\.1/i.test(API_URL)) return path;
  return `${API_URL}${path}`;
}

export function imgUrl(img, { w = 800, h, crop = "entropy" } = {}) {
  if (!img) return "";
  if (!isUnsplashId(img)) return mediaSrc(img);
  const p = new URLSearchParams({ w: String(w), q: "80", auto: "format", fit: "crop", crop });
  if (h) p.set("h", String(h));
  return `https://images.unsplash.com/${img}?${p}`;
}

// A product "gallery" built from focal-point crops of the same photograph, so
// every product shows several angles without pairing it to someone else's shot.
export function galleryFor(img, { w = 1000 } = {}) {
  if (!isUnsplashId(img)) return [mediaSrc(img)]
  return [
    imgUrl(img, { w, h: Math.round(w * 0.95), crop: 'entropy' }),
    imgUrl(img, { w, h: Math.round(w * 0.95), crop: 'edges' }),
    imgUrl(img, { w, h: Math.round(w * 1.2), crop: 'entropy' }),
    imgUrl(img, { w, h: Math.round(w * 0.7), crop: 'faces,entropy' }),
  ]
}
