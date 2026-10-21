const PLATFORM_TAXONOMY_FIELDS = {
  gini: [
    { key: "categoryName", label: "اسم الفئة", required: true },
    { key: "categoryId", label: "Category ID", required: true },
    { key: "subcategoryName", label: "الفئة الفرعيه", required: true },
    { key: "subcategoryId", label: "Subcategory ID", required: true },
  ],
  // Miswag Sync All uses this saved Collection → category_id mapping (L3/L4).
  // Eligibility/export is NOT gated by these fields — only Sync All skips unmapped collections.
  miswag: [
    { key: "categoryId", label: "Miswag category_id", required: true },
    { key: "categoryName", label: "Miswag category name", required: false },
    { key: "categoryPath", label: "Miswag category path", required: false },
    { key: "categoryLevel", label: "Miswag category level", required: false },
    // isLarge is stored on the same values object. It is not a completeness field.
  ],
};

/** Only Gini blocks export/eligibility when taxonomy setup is incomplete. */
export function taxonomyGatesEligibility(partner) {
  return String(partner || "").toLowerCase() === "gini";
}

export function taxonomyFieldsFor(partner) {
  return PLATFORM_TAXONOMY_FIELDS[String(partner || "").toLowerCase()] || [];
}

export function requiredTaxonomyKeys(partner) {
  return taxonomyFieldsFor(partner).filter((field) => field.required).map((field) => field.key);
}

export function isTaxonomyComplete(partner, values) {
  const keys = requiredTaxonomyKeys(partner);
  if (!keys.length) return false;
  if (!keys.every((key) => String(values?.[key] ?? "").trim() !== "")) return false;
  if (String(partner || "").toLowerCase() === "miswag") {
    return /^L[34]-/i.test(String(values?.categoryId || "").trim());
  }
  return true;
}

export function sanitizeTaxonomyValues(partner, input) {
  const fields = taxonomyFieldsFor(partner);
  if (!fields.length) {
    const error = new Error("Manual category fields are not configured for this platform yet");
    error.status = 400;
    throw error;
  }
  const source = input && typeof input === "object" ? input : {};
  const values = {};
  for (const field of fields) values[field.key] = String(source[field.key] ?? "").trim();
  if (String(partner || "").toLowerCase() === "miswag") {
    if (!/^L[34]-/i.test(values.categoryId || "")) {
      const error = new Error("Miswag category_id must be an L3-... or L4-... id.");
      error.status = 400;
      throw error;
    }
    if (!values.categoryLevel) {
      const match = String(values.categoryId).match(/^(L[34])-/i);
      values.categoryLevel = match ? match[1].toUpperCase() : "";
    }
  }
  return values;
}

/**
 * Miswag Large Product flag.
 * Missing values and anything other than a real true-like input resolve to false.
 * The return value is always a boolean.
 */
export function miswagIsLargeFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
