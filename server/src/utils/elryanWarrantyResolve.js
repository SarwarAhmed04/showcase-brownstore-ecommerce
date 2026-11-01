/**
 * Elryan warranty selection.
 * Product-specific mappings win. Brand mappings are the only fallback.
 * A brownKey of "default" is never applied, so one brand's warranty cannot
 * cover the rest of the catalog. Staging and production keys stay separate.
 */

const SCOPED_KEY = /^(staging|production):(product|brand):(.+)$/;

export function normalizeElryanWarrantyEnvironment(environment) {
  return String(environment || "").trim().toLowerCase() === "production" ? "production" : "staging";
}

export function explicitElryanProductWarrantyKey(doc) {
  const warranty = doc?.warranty;
  let raw = "";
  if (typeof warranty === "string") raw = warranty.trim();
  else if (warranty && typeof warranty === "object") {
    const code = warranty.code || warranty.id || warranty._id || warranty.period;
    if (code != null) raw = String(code).trim();
  }
  const key = raw.toLowerCase();
  if (!key || key === "default") return "";
  return key;
}

export function elryanBrandWarrantySubject(doc) {
  const id = doc?.brand?._id || doc?.brand?.id || "";
  return String(id || "").trim().toLowerCase();
}

export function elryanWarrantyStorageKey({ environment, scope, subject }) {
  const env = normalizeElryanWarrantyEnvironment(environment);
  const warrantyScope = scope === "brand" ? "brand" : "product";
  let key = String(subject || "").trim().toLowerCase();
  const already = key.match(SCOPED_KEY);
  if (already && already[1] === env && already[2] === warrantyScope) key = String(already[3] || "").trim();
  if (!key || key === "default") return "";
  return `${env}:${warrantyScope}:${key}`;
}

export function describeElryanWarrantyRow(row) {
  if (row?.kind && row.kind !== "warranty") return null;
  const code = String(row?.elryanCode || "").trim();
  const brownKey = String(row?.brownKey || "").trim().toLowerCase();
  const scoped = brownKey.match(SCOPED_KEY);
  if (scoped) {
    const subject = String(scoped[3] || "").trim();
    if (!subject || subject === "default" || !code) return null;
    return {
      environment: scoped[1],
      scope: scoped[2],
      subject,
      code,
      legacy: false,
      row,
    };
  }
  if (!brownKey || brownKey === "default" || !code) return null;
  return {
    environment: "staging",
    scope: "product",
    subject: brownKey,
    code,
    legacy: true,
    row,
  };
}

/**
 * @returns {{ mapping: object|null, source: ""|"product"|"brand", environment: "staging"|"production" }}
 */
export function resolveElryanWarrantyFromRows(rows, { environment, explicitKey, brandId } = {}) {
  const env = normalizeElryanWarrantyEnvironment(environment);
  const described = (Array.isArray(rows) ? rows : [])
    .map(describeElryanWarrantyRow)
    .filter((item) => item && item.environment === env);

  const explicit = String(explicitKey || "").trim().toLowerCase();
  if (explicit && explicit !== "default") {
    const productMatches = described.filter((item) => item.scope === "product" && item.subject === explicit);
    const product = productMatches.find((item) => item.legacy === false) || productMatches[0] || null;
    if (product) return { mapping: product.row, source: "product", environment: env };
  }

  const brand = String(brandId || "").trim().toLowerCase();
  if (brand) {
    const brandMatch = described.find((item) => item.scope === "brand" && item.subject === brand);
    if (brandMatch) return { mapping: brandMatch.row, source: "brand", environment: env };
  }

  return { mapping: null, source: "", environment: env };
}
