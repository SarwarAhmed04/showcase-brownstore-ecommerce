import { ElryanValueMapping } from "../models/ElryanValueMapping.js";
import { assertVerifiedElryanValueIdForMapping } from "../utils/elryanAttributeValues.js";
import { ElryanClientError } from "./elryanClient.js";
import {
  elryanAttributeSupportsValueList,
  verifyElryanAttributeValueFromList,
} from "./elryanAttributeValueCatalog.js";

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function kindToListAttribute(kind) {
  if (kind === "brand") return "Brand";
  if (kind === "color") return "Color";
  return "";
}

export async function listElryanValueMappings(kind) {
  const filter = kind ? { kind: String(kind) } : {};
  return ElryanValueMapping.find(filter).sort({ kind: 1, brownKey: 1 }).lean();
}

/**
 * Persist a local BrownStore ↔ Elryan value mapping.
 * Brand/colour require verification against authenticated /attribute-values/{Attr}/list
 * (exact id; name match when a label is provided). Never invents ids. No Elryan product writes.
 */
export async function upsertElryanValueMapping(input = {}) {
  const kind = String(input.kind || "").trim();
  if (!["brand", "color", "warranty"].includes(kind)) {
    const error = new Error("kind must be brand, color, or warranty");
    error.status = 400;
    error.code = "invalid_kind";
    throw error;
  }
  const brownKey = normalizeKey(input.brownKey);
  if (!brownKey) {
    const error = new Error("brownKey is required");
    error.status = 400;
    error.code = "brown_key_required";
    throw error;
  }

  let elryanId = normalizeKey(input.elryanId);
  const elryanCode = normalizeKey(input.elryanCode);
  let elryanLabel = normalizeKey(input.elryanLabel);

  if (kind === "warranty") {
    if (!elryanCode) {
      const error = new Error("warranty mapping requires elryanCode");
      error.status = 400;
      error.code = "warranty_code_required";
      throw error;
    }
    elryanId = "";
  } else {
    assertVerifiedElryanValueIdForMapping(kind, elryanId);
    const attribute = kindToListAttribute(kind);
    if (!elryanAttributeSupportsValueList(attribute)) {
      throw new ElryanClientError(
        `Cannot verify ${kind} mappings: attribute list catalog unavailable.`,
        { status: 400, code: "catalog_unavailable", classification: "READ" }
      );
    }
    // Server-side only — never trust frontend verification alone.
    // Require name match when a label is supplied (e.g. INGCO → ingco).
    const verified = await verifyElryanAttributeValueFromList({
      attribute,
      valueId: elryanId,
      name: elryanLabel || undefined,
      requireName: Boolean(elryanLabel),
    });
    elryanId = String(verified.value.verifiedId);
    if (!elryanLabel && verified.value.name) {
      elryanLabel = verified.value.name;
    }
  }

  return ElryanValueMapping.findOneAndUpdate(
    { kind, brownKey },
    {
      $set: {
        brownLabel: normalizeKey(input.brownLabel),
        elryanId,
        elryanCode,
        elryanLabel,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

export async function deleteElryanValueMapping(kind, brownKey) {
  await ElryanValueMapping.deleteOne({ kind, brownKey: normalizeKey(brownKey) });
  return { ok: true };
}

export async function findElryanBrandMapping(brandId) {
  const key = normalizeKey(brandId);
  if (!key) return null;
  return ElryanValueMapping.findOne({ kind: "brand", brownKey: key }).lean();
}

export async function findElryanColorMapping(colorKey) {
  const key = normalizeKey(colorKey).toLowerCase();
  if (!key) return null;
  return ElryanValueMapping.findOne({ kind: "color", brownKey: key }).lean();
}

export async function findElryanWarrantyMapping(warrantyKey = "default") {
  const key = normalizeKey(warrantyKey) || "default";
  return ElryanValueMapping.findOne({ kind: "warranty", brownKey: key }).lean();
}

export function brownColourKeyFromResolved(resolved, variation) {
  const label = variation?.colourLabel || "";
  if (label) return String(label).trim().toLowerCase();
  const variant = resolved?.variants?.[0];
  const colour =
    variant?.color?.name?.en ||
    variant?.color?.en ||
    variant?.color?.name ||
    (typeof variant?.color === "string" ? variant.color : "") ||
    "";
  return String(colour).trim().toLowerCase();
}

export function brownWarrantyKeyFromProduct(doc) {
  const warranty = doc?.warranty;
  if (warranty == null) return "default";
  if (typeof warranty === "string" && warranty.trim()) return warranty.trim().toLowerCase();
  if (typeof warranty === "object") {
    const code = warranty.code || warranty.id || warranty._id || warranty.period;
    if (code != null && String(code).trim()) return String(code).trim().toLowerCase();
  }
  return "default";
}
