/**
 * Elryan-only environment-scoped taxonomy helpers.
 * PlatformTaxonomyConfig remains partner+collection unique; staging/production
 * live under values.environments without changing Miswag/GINI identity.
 */

export function normalizeElryanMappingEnvironment(raw) {
  return String(raw || "").trim().toLowerCase() === "production" ? "production" : "staging";
}

export function emptyElryanMappingFields(environment = "staging") {
  return {
    categoryId: "",
    categoryName: "",
    categoryHierarchy: "",
    attributeSetId: "",
    elryanEnvironment: normalizeElryanMappingEnvironment(environment),
  };
}

/** Resolve flat Elryan mapping fields for a specific environment. */
export function elryanValuesForEnvironment(values, environment) {
  const env = normalizeElryanMappingEnvironment(environment);
  const source = values && typeof values === "object" ? values : {};
  const nested = source.environments?.[env];
  if (nested && typeof nested === "object") {
    return {
      categoryId: String(nested.categoryId ?? "").trim(),
      categoryName: String(nested.categoryName ?? "").trim(),
      categoryHierarchy: String(nested.categoryHierarchy ?? "").trim(),
      attributeSetId: String(nested.attributeSetId ?? "").trim(),
      elryanEnvironment: env,
    };
  }

  const tagged = String(source.elryanEnvironment || "").trim().toLowerCase();
  // Untagged legacy flat fields apply to staging only — never treat as production.
  if (tagged === "production" && env !== "production") {
    return emptyElryanMappingFields(env);
  }
  if (tagged === "staging" && env !== "staging") {
    return emptyElryanMappingFields(env);
  }
  if (!tagged && env === "production") {
    return emptyElryanMappingFields(env);
  }
  if (tagged && tagged !== env) {
    return emptyElryanMappingFields(env);
  }

  return {
    categoryId: String(source.categoryId ?? "").trim(),
    categoryName: String(source.categoryName ?? "").trim(),
    categoryHierarchy: String(source.categoryHierarchy ?? "").trim(),
    attributeSetId: String(source.attributeSetId ?? "").trim(),
    elryanEnvironment: tagged || "staging",
  };
}

export function elryanMappingIsComplete(values, environment) {
  const resolved = elryanValuesForEnvironment(values, environment);
  return Boolean(resolved.categoryId);
}

/** Merge a verified mapping into partner values without wiping the other environment. */
export function mergeElryanEnvironmentMapping(existingValues, environment, mappingFields) {
  const env = normalizeElryanMappingEnvironment(environment);
  const prev = existingValues && typeof existingValues === "object" ? { ...existingValues } : {};
  const environments = {
    ...(prev.environments && typeof prev.environments === "object" ? prev.environments : {}),
  };
  const nextEnvValues = {
    categoryId: String(mappingFields.categoryId ?? "").trim(),
    categoryName: String(mappingFields.categoryName ?? "").trim(),
    categoryHierarchy: String(mappingFields.categoryHierarchy ?? "").trim(),
    attributeSetId: String(mappingFields.attributeSetId ?? "").trim(),
  };
  environments[env] = nextEnvValues;

  return {
    ...prev,
    environments,
    // Flat mirror for the environment being saved (Category Setup / completeness).
    categoryId: nextEnvValues.categoryId,
    categoryName: nextEnvValues.categoryName,
    categoryHierarchy: nextEnvValues.categoryHierarchy,
    attributeSetId: nextEnvValues.attributeSetId,
    elryanEnvironment: env,
  };
}

export function elryanMappingDiff(previousFlat, nextFlat) {
  const keys = ["categoryId", "categoryName", "categoryHierarchy", "attributeSetId"];
  const changes = [];
  for (const key of keys) {
    const before = String(previousFlat?.[key] ?? "").trim();
    const after = String(nextFlat?.[key] ?? "").trim();
    if (before !== after) changes.push({ key, before, after });
  }
  return changes;
}
