function attributeRows(attributeSet) {
  const raw =
    attributeSet?.attributes ||
    attributeSet?.items ||
    attributeSet?.data?.attributes ||
    (Array.isArray(attributeSet) ? attributeSet : []);
  return Array.isArray(raw) ? raw : [];
}

function isMandatory(item) {
  return (
    item?.mandatory === true ||
    item?.required === true ||
    String(item?.["Mandatory?"] || item?.Mandatory || "").toLowerCase() === "yes" ||
    String(item?.mandatory || "").toLowerCase() === "yes"
  );
}

function attributeCode(item) {
  return String(item?.code || item?.attributeCode || item?.AttributeCode || "").trim();
}

/**
 * Mandatory codes and values that are not in the category attribute set.
 * Does not invent value ids. Brand and colour stay on their own mappings.
 */
export function inspectElryanAttributeValues(attributeSet, attributes = {}) {
  const requiredCodes = [];
  const rejectedCodes = [];
  for (const item of attributeRows(attributeSet)) {
    const code = attributeCode(item);
    if (!code || !isMandatory(item)) continue;
    requiredCodes.push(code);
    const current = attributes?.[code];
    const text = current == null ? "" : String(current).trim();
    const allowed = Array.isArray(item?.values) ? item.values : [];
    if (!text || !allowed.length) continue;
    const ok = allowed.some((value) => String(value?.id ?? "") === text);
    if (!ok) rejectedCodes.push(code);
  }
  return { requiredCodes, rejectedCodes };
}
