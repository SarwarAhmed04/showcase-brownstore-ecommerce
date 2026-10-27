/**
 * Elryan attribute-value helpers (Brand / Color).
 * Never invent value IDs — only surface IDs present on official API payloads.
 */

export function normalizeElryanAttributeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function extractElryanAttributeValueId(row) {
  if (!row || typeof row !== "object") return "";
  const candidates = [
    row.verifiedId,
    row.id,
    row._id,
    row.valueId,
    row.attributeValueId,
    row.brandId,
    row.colorId,
    row.raw?.id,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const id = String(candidate).trim();
    if (id) return id;
  }
  return "";
}

export function normalizeElryanAttributeValueRow(row) {
  const source = row && typeof row === "object" ? row : {};
  const verifiedId = extractElryanAttributeValueId(source);
  const name = String(source.Name ?? source.name ?? "").trim();
  const nameAr = String(source.nameAr ?? source.NameAr ?? "").trim();
  const attribute = String(source.attribute ?? "").trim();
  return {
    name,
    nameAr,
    attribute,
    verifiedId: verifiedId || null,
    idVerified: Boolean(verifiedId),
    /** Raw official fields only — no synthetic id. */
    raw: {
      ...(attribute ? { attribute } : {}),
      ...(name ? { name } : {}),
      ...(nameAr ? { nameAr } : {}),
      ...(verifiedId ? { id: verifiedId } : {}),
    },
  };
}

/** Exact string id equality after trim — never compare by array index. */
export function findElryanCatalogRowByExactId(rows, valueId) {
  const needle = String(valueId ?? "").trim();
  if (!needle) return null;
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const id = extractElryanAttributeValueId(row);
    if (id && id === needle) return normalizeElryanAttributeValueRow({ ...row, id });
  }
  return null;
}

/**
 * Verify an official catalog row by exact id, optionally requiring a name match
 * against `name` or `nameAr` (case-insensitive).
 */
export function verifyElryanCatalogIdAndName({ rows, valueId, name, requireName = false } = {}) {
  const id = String(valueId ?? "").trim();
  if (!id) {
    return { ok: false, code: "verified_id_required", message: "Elryan value id is required." };
  }
  if (/^index:\d+$/i.test(id)) {
    return { ok: false, code: "invented_id_rejected", message: "Array-index placeholders are not valid Elryan value ids." };
  }
  const found = findElryanCatalogRowByExactId(rows, id);
  if (!found || !found.idVerified) {
    return {
      ok: false,
      code: "attribute_value_not_found",
      message: `Elryan value id "${id}" was not found in the authenticated attribute catalog.`,
    };
  }
  const expected = normalizeElryanAttributeName(name);
  if (requireName || expected) {
    const nameOk =
      normalizeElryanAttributeName(found.name) === expected ||
      (found.nameAr && normalizeElryanAttributeName(found.nameAr) === expected);
    if (!nameOk) {
      return {
        ok: false,
        code: "name_id_mismatch",
        message: `Elryan id "${id}" does not match name "${String(name || "").trim()}".`,
        value: found,
      };
    }
  }
  return { ok: true, code: "ok", value: found };
}

export function normalizeElryanAttributeValueList(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => normalizeElryanAttributeValueRow(row));
}

export function elryanAttributeValuesHaveVerifiedIds(rows) {
  return normalizeElryanAttributeValueList(rows).some((row) => row.idVerified);
}

/**
 * Brand/colour mapping may only persist a non-empty official value id.
 * Array indices and blank values are rejected.
 */
export function assertVerifiedElryanValueIdForMapping(kind, elryanId) {
  const k = String(kind || "").trim().toLowerCase();
  const id = String(elryanId ?? "").trim();
  if (k === "warranty") {
    return { ok: true, elryanId: "" };
  }
  if (k !== "brand" && k !== "color") {
    const error = new Error("kind must be brand, color, or warranty");
    error.status = 400;
    error.code = "invalid_kind";
    throw error;
  }
  if (!id) {
    const error = new Error(
      `${k} mapping requires a verified Elryan value id. List/search often returns names only — do not invent ids.`
    );
    error.status = 400;
    error.code = "verified_id_required";
    throw error;
  }
  // Reject obvious array-index placeholders that older UI versions wrote as "ids".
  if (/^index:\d+$/i.test(id)) {
    const error = new Error("Array-index placeholders are not valid Elryan value ids.");
    error.status = 400;
    error.code = "invented_id_rejected";
    throw error;
  }
  return { ok: true, elryanId: id };
}
