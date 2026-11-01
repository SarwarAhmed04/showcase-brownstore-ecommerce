import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { elryanValuesForEnvironment } from "./utils/elryanTaxonomyMapping.js";
import { resolveElryanWarrantyFromRows } from "./utils/elryanWarrantyResolve.js";
import {
  KENWOOD_STAGING_SUBJECTS,
  planKenwoodStagingMappings,
  resolveElryanScopedValue,
} from "./utils/elryanValueResolve.js";

const KENWOOD = KENWOOD_STAGING_SUBJECTS.brandId;

describe("Elryan brand and colour environment isolation", () => {
  it("keeps a legacy unprefixed brand on staging and out of production", () => {
    const rows = [{ kind: "brand", brownKey: "6ace1b33669f3bf0af2b55f2", elryanId: "10104", elryanLabel: "ingco" }];
    const staging = resolveElryanScopedValue(rows, {
      environment: "staging",
      subject: "6ace1b33669f3bf0af2b55f2",
    });
    const production = resolveElryanScopedValue(rows, {
      environment: "production",
      subject: "6ace1b33669f3bf0af2b55f2",
    });
    assert.equal(staging.row.elryanId, "10104");
    assert.equal(staging.legacy, true);
    assert.equal(production, null);
  });

  it("does not treat a Staging Kenwood brand or colour as a Production mapping", () => {
    const rows = [
      { kind: "brand", brownKey: `staging:${KENWOOD}`, environment: "staging", elryanId: "276", elryanLabel: "Kenwood" },
      { kind: "color", brownKey: "staging:white", environment: "staging", elryanId: "59", elryanLabel: "White" },
      { kind: "brand", brownKey: "6ace1b33669f3bf0af2b55f2", elryanId: "10104", elryanLabel: "ingco" },
      { kind: "color", brownKey: "yellow", elryanId: "60", elryanLabel: "Yellow" },
    ];
    assert.equal(resolveElryanScopedValue(rows, { environment: "staging", subject: KENWOOD }).row.elryanId, "276");
    assert.equal(resolveElryanScopedValue(rows, { environment: "production", subject: KENWOOD }), null);
    assert.equal(resolveElryanScopedValue(rows, { environment: "staging", subject: "white" }).row.elryanId, "59");
    assert.equal(resolveElryanScopedValue(rows, { environment: "production", subject: "white" }), null);
    assert.equal(resolveElryanScopedValue(rows, { environment: "staging", subject: "yellow" }).row.elryanId, "60");
    assert.equal(resolveElryanScopedValue(rows, { environment: "production", subject: "yellow" }), null);
  });

  it("prefers the environment-scoped row over a legacy row with the same subject", () => {
    const rows = [
      { kind: "brand", brownKey: KENWOOD, elryanId: "old", elryanLabel: "Old" },
      { kind: "brand", brownKey: `staging:${KENWOOD}`, environment: "staging", elryanId: "276", elryanLabel: "Kenwood" },
    ];
    const staging = resolveElryanScopedValue(rows, { environment: "staging", subject: KENWOOD });
    assert.equal(staging.row.elryanId, "276");
    assert.equal(staging.legacy, false);
    assert.equal(rows[0].brownKey, KENWOOD);
  });
});

describe("Kenwood Staging mapping plan", () => {
  it("prepares four Staging mappings and does not mark them saved", () => {
    const existing = {
      environments: { production: { categoryId: "900", categoryName: "Other" } },
      categoryId: "398",
      categoryName: "Air Compressors",
      elryanEnvironment: "staging",
    };
    const plan = planKenwoodStagingMappings({
      existingCategoryValues: existing,
      category: {
        name: "Chopper",
        hierarchy: "Home & Kitchen : Small Appliances : Kitchen Appliances : Chopper",
        attributeSetId: "67",
      },
    });
    assert.equal(plan.saved, false);
    assert.equal(plan.valueMappings.length, 3);
    assert.deepEqual(
      plan.valueMappings.map((row) => row.brownKey),
      [`staging:${KENWOOD}`, "staging:white", `staging:brand:${KENWOOD}`]
    );
    assert.equal(plan.valueMappings.every((row) => row.environment === "staging" && row.replacesExistingRows === false), true);
    assert.equal(plan.valueMappings[0].elryanId, "276");
    assert.equal(plan.valueMappings[1].elryanId, "59");
    assert.equal(plan.valueMappings[2].elryanCode, "rlbo35igt4");
    assert.equal(plan.category.brownCollectionId, "6a607135074f4d47dca09419");
    assert.equal(plan.category.values.environments.staging.categoryId, "340");
    assert.equal(plan.category.values.environments.staging.attributeSetId, "67");
    assert.equal(plan.category.values.environments.production.categoryId, "900");
    assert.equal(elryanValuesForEnvironment(plan.category.values, "production").categoryId, "900");
    assert.equal(elryanValuesForEnvironment(plan.category.values, "staging").categoryId, "340");
  });

  it("does not let the Staging warranty code satisfy Production", () => {
    const plan = planKenwoodStagingMappings();
    const warranty = plan.valueMappings.find((row) => row.kind === "warranty");
    const rows = [{ kind: "warranty", brownKey: warranty.brownKey, environment: "staging", elryanCode: warranty.elryanCode }];
    const staging = resolveElryanWarrantyFromRows(rows, { environment: "staging", brandId: KENWOOD });
    const production = resolveElryanWarrantyFromRows(rows, { environment: "production", brandId: KENWOOD });
    assert.equal(staging.mapping.elryanCode, "rlbo35igt4");
    assert.equal(production.mapping, null);
  });
});
