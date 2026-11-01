/**
 * Environment scope for Elryan brand and colour rows.
 * New rows are stored as staging:<subject> or production:<subject>.
 * Unprefixed legacy rows stay on disk and resolve for Staging only.
 */

import {
  mergeElryanEnvironmentMapping,
  normalizeElryanMappingEnvironment,
} from "./elryanTaxonomyMapping.js";
import { elryanWarrantyStorageKey } from "./elryanWarrantyResolve.js";

const SCOPED_KEY = /^(staging|production):(.+)$/;

export const KENWOOD_STAGING_SUBJECTS = Object.freeze({
  brandId: "6a7051ee6a1aacf1cc23be46",
  colourKey: "white",
  warrantyCode: "rlbo35igt4",
  collectionId: "6a607135074f4d47dca09419",
  categoryId: "340",
  brandElryanId: "276",
  colourElryanId: "59",
});

export function elryanScopedValueStorageKey({ environment, subject }) {
  const env = normalizeElryanMappingEnvironment(environment);
  let key = String(subject || "").trim().toLowerCase();
  const already = key.match(SCOPED_KEY);
  if (already && already[1] === env) key = String(already[2] || "").trim();
  if (!key) return "";
  return `${env}:${key}`;
}

export function describeElryanScopedValueRow(row) {
  if (row?.kind !== "brand" && row?.kind !== "color") return null;
  const elryanId = String(row?.elryanId || "").trim();
  const brownKey = String(row?.brownKey || "").trim().toLowerCase();
  if (!elryanId || !brownKey) return null;
  const scoped = brownKey.match(SCOPED_KEY);
  if (scoped) {
    const subject = String(scoped[2] || "").trim();
    if (!subject) return null;
    return { environment: scoped[1], subject, legacy: false, row };
  }
  return { environment: "staging", subject: brownKey, legacy: true, row };
}

export function resolveElryanScopedValue(rows, { environment, subject } = {}) {
  const env = normalizeElryanMappingEnvironment(environment);
  const key = String(subject || "").trim().toLowerCase();
  if (!key) return null;
  const matches = (Array.isArray(rows) ? rows : [])
    .map(describeElryanScopedValueRow)
    .filter((item) => item && item.environment === env && item.subject === key);
  return matches.find((item) => item.legacy === false) || matches[0] || null;
}

/**
 * Intended Staging writes for OWCH180002. Does not touch the database.
 * Category fields other than categoryId come from the caller (the Staging snapshot).
 */
export function planKenwoodStagingMappings({ category = {}, existingCategoryValues = null } = {}) {
  const subjects = KENWOOD_STAGING_SUBJECTS;
  const categoryFields = {
    categoryId: subjects.categoryId,
    categoryName: String(category.categoryName || category.name || "").trim(),
    categoryHierarchy: String(category.categoryHierarchy || category.hierarchy || "").trim(),
    attributeSetId: String(category.attributeSetId || "").trim(),
  };
  return {
    saved: false,
    valueMappings: [
      {
        action: "insert",
        kind: "brand",
        environment: "staging",
        brownKey: elryanScopedValueStorageKey({ environment: "staging", subject: subjects.brandId }),
        subject: subjects.brandId,
        elryanId: subjects.brandElryanId,
        elryanLabel: "Kenwood",
        replacesExistingRows: false,
      },
      {
        action: "insert",
        kind: "color",
        environment: "staging",
        brownKey: elryanScopedValueStorageKey({ environment: "staging", subject: subjects.colourKey }),
        subject: subjects.colourKey,
        elryanId: subjects.colourElryanId,
        elryanLabel: "White",
        replacesExistingRows: false,
      },
      {
        action: "insert",
        kind: "warranty",
        environment: "staging",
        warrantyScope: "brand",
        brownKey: elryanWarrantyStorageKey({
          environment: "staging",
          scope: "brand",
          subject: subjects.brandId,
        }),
        subject: subjects.brandId,
        elryanCode: subjects.warrantyCode,
        replacesExistingRows: false,
      },
    ],
    category: {
      action: existingCategoryValues ? "update" : "insert",
      partner: "elryan",
      brownCollectionId: subjects.collectionId,
      environment: "staging",
      values: mergeElryanEnvironmentMapping(existingCategoryValues, "staging", categoryFields),
    },
  };
}
