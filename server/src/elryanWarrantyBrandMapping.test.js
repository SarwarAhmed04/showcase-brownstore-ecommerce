import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { Product } from "./models/Product.js";
import {
  resolveElryanWarrantyForProduct,
  upsertElryanValueMapping,
} from "./services/elryanAttributeMapping.js";
import {
  elryanWarrantyStorageKey,
  resolveElryanWarrantyFromRows,
} from "./utils/elryanWarrantyResolve.js";

const KENWOOD_BRAND = "6a7051ee6a1aacf1cc23be46";
const OTHER_BRAND = "6ace1b33669f3bf0af2b55f2";
const KENWOOD_CODE = "rlbo35igt4";

function kenwoodWarrantyRow() {
  return {
    kind: "warranty",
    brownKey: elryanWarrantyStorageKey({
      environment: "staging",
      scope: "brand",
      subject: KENWOOD_BRAND,
    }),
    environment: "staging",
    warrantyScope: "brand",
    elryanCode: KENWOOD_CODE,
    elryanLabel: "waranty kenwood",
    brownLabel: "Kenwood",
  };
}

function productDoc(brandId, warranty = { duration: 1, unit: "years", description: "" }) {
  return {
    brand: { _id: brandId, name: "Kenwood" },
    warranty,
  };
}

describe("Elryan brand warranty resolution", () => {
  it("resolves the Kenwood staging warranty only for the Kenwood brand", () => {
    const rows = [kenwoodWarrantyRow()];
    const kenwood = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "",
      brandId: KENWOOD_BRAND,
    });
    assert.equal(kenwood.source, "brand");
    assert.equal(kenwood.mapping.elryanCode, KENWOOD_CODE);

    const other = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "",
      brandId: OTHER_BRAND,
    });
    assert.equal(other.mapping, null);
    assert.equal(other.source, "");
  });

  it("ignores a universal default warranty row", () => {
    const rows = [
      kenwoodWarrantyRow(),
      { kind: "warranty", brownKey: "default", elryanCode: "EVERYONE", elryanLabel: "All" },
    ];
    const other = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "",
      brandId: OTHER_BRAND,
    });
    assert.equal(other.mapping, null);
    const kenwood = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "",
      brandId: KENWOOD_BRAND,
    });
    assert.equal(kenwood.mapping.elryanCode, KENWOOD_CODE);
  });

  it("prefers an explicit product warranty mapping over the brand fallback", () => {
    const rows = [
      kenwoodWarrantyRow(),
      {
        kind: "warranty",
        brownKey: "staging:product:2-year",
        environment: "staging",
        warrantyScope: "product",
        elryanCode: "PRODUCT-CODE",
      },
    ];
    const resolved = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "2-year",
      brandId: KENWOOD_BRAND,
    });
    assert.equal(resolved.source, "product");
    assert.equal(resolved.mapping.elryanCode, "PRODUCT-CODE");
  });

  it("keeps a legacy explicit product key on staging and out of production", () => {
    const rows = [{ kind: "warranty", brownKey: "2-year", elryanCode: "LEGACY" }];
    const staging = resolveElryanWarrantyFromRows(rows, {
      environment: "staging",
      explicitKey: "2-year",
      brandId: OTHER_BRAND,
    });
    assert.equal(staging.source, "product");
    assert.equal(staging.mapping.elryanCode, "LEGACY");
    const production = resolveElryanWarrantyFromRows(rows, {
      environment: "production",
      explicitKey: "2-year",
      brandId: OTHER_BRAND,
    });
    assert.equal(production.mapping, null);
  });

  it("does not reuse a staging brand warranty code in production", () => {
    const rows = [kenwoodWarrantyRow()];
    const production = resolveElryanWarrantyFromRows(rows, {
      environment: "production",
      explicitKey: "",
      brandId: KENWOOD_BRAND,
    });
    assert.equal(production.mapping, null);
    assert.equal(production.environment, "production");
  });

  it("falls back to the brand mapping when the product warranty has duration but no code", () => {
    const resolved = resolveElryanWarrantyFromRows([kenwoodWarrantyRow()], {
      environment: "staging",
      explicitKey: "",
      brandId: KENWOOD_BRAND,
    });
    assert.equal(resolved.source, "brand");
    assert.equal(resolved.mapping.elryanCode, KENWOOD_CODE);
  });
});

describe("Elryan warranty mapping persistence", () => {
  let memory;

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-warranty-brand"));
  });

  after(async () => {
    await mongoose.disconnect();
    await memory.stop();
  });

  it("rejects a universal default warranty and leaves other mappings and the product unchanged", async () => {
    const product = await Product.create({
      ibsherId: "ibs-kenwood-chopper",
      itemCode: "OWCH180002",
      name: { en: "Food Chopper" },
      price: 50000,
      brand: { _id: KENWOOD_BRAND, name: "Kenwood" },
      warranty: { duration: 1, unit: "years", description: "" },
    });
    const beforeProduct = await Product.findById(product._id).lean();
    await ElryanValueMapping.create([
      {
        kind: "brand",
        brownKey: OTHER_BRAND,
        brownLabel: "INGCO",
        elryanId: "10104",
        elryanLabel: "ingco",
      },
      {
        kind: "color",
        brownKey: "yellow",
        brownLabel: "Yellow",
        elryanId: "60",
        elryanLabel: "Yellow",
      },
    ]);
    const beforeMappings = await ElryanValueMapping.find({ kind: { $in: ["brand", "color"] } })
      .sort({ kind: 1, brownKey: 1 })
      .lean();

    await assert.rejects(
      () =>
        upsertElryanValueMapping({
          kind: "warranty",
          warrantyScope: "brand",
          environment: "staging",
          brownKey: "default",
          elryanCode: KENWOOD_CODE,
        }),
      (error) => {
        assert.equal(error.code, "warranty_default_rejected");
        return true;
      }
    );

    const saved = await upsertElryanValueMapping({
      kind: "warranty",
      warrantyScope: "brand",
      environment: "staging",
      brownKey: KENWOOD_BRAND,
      brownLabel: "Kenwood",
      elryanCode: KENWOOD_CODE,
      elryanLabel: "waranty kenwood",
    });
    assert.equal(saved.brownKey, `staging:brand:${KENWOOD_BRAND}`);
    assert.equal(saved.environment, "staging");
    assert.equal(saved.warrantyScope, "brand");
    assert.equal(saved.elryanCode, KENWOOD_CODE);

    const kenwood = await resolveElryanWarrantyForProduct(beforeProduct, "staging");
    assert.equal(kenwood.source, "brand");
    assert.equal(kenwood.mapping.elryanCode, KENWOOD_CODE);

    const other = await resolveElryanWarrantyForProduct(productDoc(OTHER_BRAND), "staging");
    assert.equal(other.mapping, null);

    const production = await resolveElryanWarrantyForProduct(beforeProduct, "production");
    assert.equal(production.mapping, null);

    const afterProduct = await Product.findById(product._id).lean();
    assert.deepEqual(afterProduct.warranty, beforeProduct.warranty);
    assert.equal(afterProduct.name.en, "Food Chopper");
    assert.equal(afterProduct.itemCode, "OWCH180002");

    const afterMappings = await ElryanValueMapping.find({ kind: { $in: ["brand", "color"] } })
      .sort({ kind: 1, brownKey: 1 })
      .lean();
    assert.deepEqual(
      afterMappings.map((row) => ({
        kind: row.kind,
        brownKey: row.brownKey,
        elryanId: row.elryanId,
        elryanLabel: row.elryanLabel,
      })),
      beforeMappings.map((row) => ({
        kind: row.kind,
        brownKey: row.brownKey,
        elryanId: row.elryanId,
        elryanLabel: row.elryanLabel,
      }))
    );
  });
});
