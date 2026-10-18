const PLATFORM_TAXONOMY_FIELDS = {
  gini: [
    { key: "categoryName", label: "اسم الفئة", required: true },
    { key: "categoryId", label: "Category ID", required: true },
    { key: "subcategoryName", label: "الفئة الفرعيه", required: true },
    { key: "subcategoryId", label: "Subcategory ID", required: true },
  ],
};

export function taxonomyFieldsFor(partner) {
  return PLATFORM_TAXONOMY_FIELDS[String(partner || "").toLowerCase()] || [];
}

export function requiredTaxonomyKeys(partner) {
  return taxonomyFieldsFor(partner).filter((field) => field.required).map((field) => field.key);
}

export function isTaxonomyComplete(partner, values) {
  const keys = requiredTaxonomyKeys(partner);
  if (!keys.length) return false;
  return keys.every((key) => String(values?.[key] ?? "").trim() !== "");
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
  return values;
}
