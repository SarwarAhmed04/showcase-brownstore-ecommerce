import { mergeElryanStagingAttributes } from "./elryanStagingGate.js";

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

export function elryanAttributeRequirement(item) {
  return isMandatory(item) ? "required" : "optional";
}

/** Power and wattage differ by product, so a collection mapping cannot supply one value. */
export function isElryanVaryingPowerAttribute(item) {
  const code = attributeCode(item);
  const name = String(item?.name || item?.label || "");
  return /watt|power|واط|طاقة/i.test(`${code} ${name}`);
}

export function describeElryanAttributeSet(attributeSet) {
  return attributeRows(attributeSet)
    .map((item) => {
      const code = attributeCode(item);
      const values = Array.isArray(item?.values) ? item.values : [];
      return {
        id: item?.id ?? null,
        code,
        name: String(item?.name || item?.label || code),
        status: elryanAttributeRequirement(item),
        variesByProduct: isElryanVaryingPowerAttribute(item),
        values: values
          .map((value) => ({
            id: value?.id ?? null,
            name: String(value?.name || value?.label || value?.value || ""),
          }))
          .filter((value) => value.id != null || value.name),
      };
    })
    .filter((row) => row.code);
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

function specificationText(product) {
  const chunks = [];
  const bags = [
    product?.specifications,
    product?.specs,
    product?.overrides?.specifications,
    product?.overrides?.specs,
  ];
  for (const bag of bags) {
    if (!bag) continue;
    if (Array.isArray(bag)) {
      for (const row of bag) {
        if (row == null) continue;
        if (typeof row === "string") chunks.push(row);
        else chunks.push(`${row.name || row.key || row.label || ""} ${row.value ?? row.text ?? ""}`);
      }
    } else if (typeof bag === "object") {
      for (const [key, value] of Object.entries(bag)) chunks.push(`${key} ${value ?? ""}`);
    } else chunks.push(String(bag));
  }
  const description = product?.description;
  if (description && typeof description === "object") {
    chunks.push(description.en, description.ar, description.ku);
  } else if (description) chunks.push(String(description));
  return chunks
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function matchPublishedPowerValue(text, values) {
  const numbers = [...String(text || "").matchAll(/(\d+(?:\.\d+)?)\s*(?:watts|watt|واط|w)\b/gi)].map((match) =>
    Number(match[1])
  );
  if (!numbers.length) return null;
  const hits = [];
  for (const value of values || []) {
    const id = Number(value?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const range = String(value?.name || "").match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
    if (!range) continue;
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (numbers.some((number) => number >= low && number <= high)) hits.push(id);
  }
  const unique = [...new Set(hits)];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Collection mappings do not choose wattage. A Staging product override wins,
 * then one published Elryan value id matched from that product's specifications.
 * Production never receives Staging overrides.
 */
export function resolveElryanSavedAttributes({
  environment,
  mappingAttributes,
  override = null,
  attributeSet = null,
  product = null,
} = {}) {
  const described = describeElryanAttributeSet(attributeSet);
  const varying = new Set(described.filter((row) => row.variesByProduct).map((row) => row.code));
  const base = {};
  const source =
    mappingAttributes && typeof mappingAttributes === "object" && !Array.isArray(mappingAttributes)
      ? mappingAttributes
      : {};
  for (const [key, value] of Object.entries(source)) {
    const code = String(key || "").trim();
    if (!code || varying.has(code) || isElryanVaryingPowerAttribute({ code })) continue;
    base[code] = value;
  }
  const merged = mergeElryanStagingAttributes(environment, base, override);
  const text = specificationText(product);
  if (!text) return merged;
  for (const row of described) {
    if (!row.variesByProduct || merged[row.code] != null) continue;
    const id = matchPublishedPowerValue(text, row.values);
    if (id != null) merged[row.code] = id;
  }
  return merged;
}
