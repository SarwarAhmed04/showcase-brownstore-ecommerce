import { Activity, ACTIVITY_ACTIONS, ACTIVITY_GROUPS } from "../models/Activity.js";
import { PARTNER_DEFS } from "../models/Partner.js";

export function partnerDisplayName(slug, name) {
  if (name) return String(name);
  const def = PARTNER_DEFS.find((item) => item.slug === slug);
  return def?.name || String(slug || "");
}

function localizedName(name) {
  if (!name || typeof name !== "object") {
    return { ku: String(name || ""), en: String(name || ""), ar: String(name || "") };
  }
  return {
    ku: String(name.ku || ""),
    en: String(name.en || ""),
    ar: String(name.ar || ""),
  };
}

export function toAdminActivity(doc) {
  const raw = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  return {
    id: raw._id.toString(),
    actorEmail: String(raw.actorEmail || ""),
    action: raw.action,
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
    createdAt: raw.createdAt,
  };
}

export async function logActivity(req, action, meta = {}) {
  if (!ACTIVITY_ACTIONS.includes(action)) return;
  try {
    await Activity.create({
      actorId: req.user?._id || null,
      actorEmail: String(req.user?.email || "").toLowerCase().trim(),
      action,
      meta,
    });
  } catch (err) {
    console.error("Failed to log activity:", err.message);
  }
}

export function activityFilter(group) {
  const actions = ACTIVITY_GROUPS[group];
  return actions?.length ? { action: { $in: actions } } : {};
}

export { localizedName };
