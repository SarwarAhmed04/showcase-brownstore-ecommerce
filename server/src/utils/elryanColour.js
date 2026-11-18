/**
 * One colour label and key for the mapping picker, Elryan preview, and payload.
 * A selectable key is the same string findElryanColorMapping looks up.
 */
export function brownColourLabel(color) {
  if (color == null) return "";
  if (typeof color === "string") return color.trim();
  if (typeof color !== "object") return "";
  const name = color.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (name && typeof name === "object") {
    const localized = String(name.en || name.ku || name.ar || "").trim();
    if (localized) return localized;
  }
  if (typeof color.en === "string" && color.en.trim()) return color.en.trim();
  return String(color.ku || color.ar || "").trim();
}

export function brownColourKey(color) {
  return brownColourLabel(color).toLowerCase();
}
