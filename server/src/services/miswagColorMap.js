/**
 * Verified English color names → HEX.
 * Used only for an exact, unambiguous normalized name.
 * Unknown names, multi-color labels, and product HEX fields are never guessed.
 * There is no Miswag color directory API in this codebase.
 */
export const MISWAG_VERIFIED_COLOR_MAP = {
  black: ["#000000", "Black"],
  white: ["#FFFFFF", "White"],
  red: ["#FF0000", "Red"],
  blue: ["#0000FF", "Blue"],
  green: ["#008000", "Green"],
  yellow: ["#FFFF00", "Yellow"],
  orange: ["#FFA500", "Orange"],
  purple: ["#800080", "Purple"],
  pink: ["#FFC0CB", "Pink"],
  gray: ["#808080", "Gray"],
  grey: ["#808080", "Gray"],
  silver: ["#C0C0C0", "Silver"],
  gold: ["#D4AF37", "Gold"],
  brown: ["#8B4513", "Brown"],
  beige: ["#F5F5DC", "Beige"],
  navy: ["#000080", "Navy"],
  "navy blue": ["#000080", "Navy"],
};

const HEX_NAME = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isMiswagColorHex(value) {
  return /^#[0-9A-F]{6}$/.test(String(value || ""));
}

/** Accept #RGB or #RRGGBB and store/send only #RRGGBB. Anything else is empty. */
export function normalizeMiswagHex(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return "";
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  const normalized = `#${hex.toUpperCase()}`;
  return isMiswagColorHex(normalized) ? normalized : "";
}

export function normalizeMiswagColorKey(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function plainText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Original BrownStore color text. English is preferred.
 * HEX strings are not names, and multi-color labels are not split.
 */
export function readOriginalMiswagColorName(variant) {
  const candidates = [];

  function pushCandidate(value) {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = plainText(value);
      if (!text || HEX_NAME.test(text)) return;
      candidates.push(text);
      return;
    }
    if (typeof value !== "object") return;
    if (value.name && typeof value.name === "object") {
      pushCandidate(value.name.en);
      pushCandidate(value.name.ar);
      pushCandidate(value.name.ku);
    } else {
      pushCandidate(value.name);
    }
    pushCandidate(value.en);
    pushCandidate(value.label);
  }

  pushCandidate(variant?.color);
  pushCandidate(variant?.colour);
  pushCandidate(variant?.colorName);
  return candidates.find((text) => text.length > 0) || "";
}

/** Product-stored HEX for display only. Never used as an automatic Miswag color. */
export function readStoredProductHex(variant) {
  const bits = [];
  const color = variant?.color ?? variant?.colour;
  if (color && typeof color === "object") bits.push(color.hex, color.colorHex);
  bits.push(variant?.colorHex, variant?.hex);
  for (const bit of bits) {
    const hex = normalizeMiswagHex(bit);
    if (hex) return hex;
  }
  return "";
}
