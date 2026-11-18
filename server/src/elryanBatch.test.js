import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeElryanAttributeSet,
  inspectElryanAttributeValues,
  resolveElryanSavedAttributes,
} from "./utils/elryanAttributeSet.js";
import {
  buildElryanBatchCreateBody,
  buildElryanBatchUpdateBody,
  classifyElryanBatchResult,
  partitionElryanBatchCreates,
  reconcileElryanBatchResult,
} from "./utils/elryanBatch.js";

const powerSet = {
  id: 66,
  name: "Bowl mixer",
  attributes: [
    {
      code: "chopper_power",
      name: "Power",
      "Mandatory?": "Yes",
      values: [
        { id: 6150, name: "0 - 400 W" },
        { id: 6151, name: "401 - 800 W" },
      ],
    },
    {
      code: "plug_type",
      name: "Plug",
      mandatory: false,
      values: [{ id: 5, name: "Two pin" }],
    },
  ],
};

describe("Elryan attribute agreement", () => {
  it("treats Mandatory? the same way as the required-value check and keeps published ids", () => {
    const described = describeElryanAttributeSet(powerSet);
    assert.equal(described[0].status, "required");
    assert.equal(described[0].variesByProduct, true);
    assert.deepEqual(described[0].values.map((value) => value.id), [6150, 6151]);
    assert.equal(described[1].status, "optional");
    const inspected = inspectElryanAttributeValues(powerSet, {});
    assert.deepEqual(inspected.requiredCodes, ["chopper_power"]);
  });

  it("uses a product specification value id and ignores a collection watt value", () => {
    const staging = resolveElryanSavedAttributes({
      environment: "staging",
      mappingAttributes: { chopper_power: 1, plug_type: 5 },
      override: null,
      attributeSet: powerSet,
      product: { description: { en: "Motor 350 W" }, specifications: [{ name: "Power", value: "350 W" }] },
    });
    assert.equal(staging.chopper_power, 6150);
    assert.equal(staging.plug_type, 5);

    const overridden = resolveElryanSavedAttributes({
      environment: "staging",
      mappingAttributes: { chopper_power: 1, plug_type: 5 },
      override: { environment: "staging", attributes: { chopper_power: 6151 } },
      attributeSet: powerSet,
      product: { description: { en: "Motor 350 W" } },
    });
    assert.equal(overridden.chopper_power, 6151);

    const production = resolveElryanSavedAttributes({
      environment: "production",
      mappingAttributes: { chopper_power: 1, plug_type: 5 },
      override: { environment: "staging", attributes: { chopper_power: 6151 } },
      attributeSet: powerSet,
      product: { description: { en: "Motor 350 W" } },
    });
    assert.equal(production.chopper_power, 6150);
    assert.equal(production.plug_type, 5);
    const rejected = inspectElryanAttributeValues(powerSet, { chopper_power: 99999 });
    assert.deepEqual(rejected.rejectedCodes, ["chopper_power"]);
  });
});

describe("Elryan batch send contract", () => {
  it("builds create and update bodies without cost and tracks a partial result", () => {
    const create = buildElryanBatchCreateBody([
      {
        sku: "EL-READY-1",
        brand: "Acme",
        color: "Black",
        categoryId: "elr-cat-9",
        sellingPrice: 10000,
        quantity: 4,
        images: [{ fileUrl: "https://cdn.example.com/lamp.jpg" }],
        attributes: { plug_type: "5" },
        costPrice: 1,
      },
    ]);
    assert.equal(create.data[0].sellingPrice, 10000);
    assert.equal(create.data[0].costPrice, undefined);
    assert.equal(create.data[0].attributes.plug_type, 5);
    assert.deepEqual(create.data[0].images, ["https://cdn.example.com/lamp.jpg"]);
    const update = buildElryanBatchUpdateBody([{ sku: "EL-READY-1", quantity: 0, sellingPrice: 11000, costPrice: 4 }]);
    assert.deepEqual(update.data[0], { sku: "EL-READY-1", qty: 0, sellingPrice: 11000 });

    const partial = classifyElryanBatchResult({
      requestedSkus: ["EL-READY-1", "EL-NEW-1"],
      httpStatus: 200,
      json: {
        data: {
          _id: "a".repeat(24),
          status: true,
          failedItems: 1,
          failedProducts: [{ sku: "EL-NEW-1", errors: [{ field: "brand", code: "unknown", message: "missing" }] }],
        },
      },
    });
    assert.equal(partial.partial, true);
    assert.equal(partial.results.find((row) => row.sku === "EL-READY-1").outcome, "saved");
    assert.equal(partial.results.find((row) => row.sku === "EL-NEW-1").outcome, "failed");
  });

  it("keeps an ambiguous batch blocked until a later read settles it", () => {
    const pending = classifyElryanBatchResult({
      requestedSkus: ["EL-READY-1"],
      httpStatus: 200,
      json: { data: { _id: "b".repeat(24), status: null, failedItems: 0 } },
    });
    assert.equal(pending.ambiguous, true);
    assert.equal(pending.retryAllowed, false);
    const still = reconcileElryanBatchResult(pending, {
      requestedSkus: ["EL-READY-1"],
      httpStatus: 200,
      json: { data: { _id: "b".repeat(24), status: null } },
    });
    assert.equal(still.ambiguous, true);
    const settled = reconcileElryanBatchResult(pending, {
      requestedSkus: ["EL-READY-1"],
      httpStatus: 200,
      json: { data: { _id: "b".repeat(24), status: true, failedItems: 0 } },
    });
    assert.equal(settled.results[0].outcome, "saved");
    const hung = classifyElryanBatchResult({
      requestedSkus: ["EL-READY-1"],
      httpStatus: 0,
      json: null,
      transportError: "socket hang up",
    });
    assert.equal(hung.results[0].outcome, "ambiguous");
  });

  it("does not create the existing Kenwood pilot twice", () => {
    const held = partitionElryanBatchCreates({
      items: [
        { sku: "OWCH180002" },
        { sku: "EL-READY-1" },
      ],
      confirmedSkus: ["OWCH180002"],
      skuAvailability: { OWCH180002: true },
    });
    assert.deepEqual(held.send.map((item) => item.sku), ["EL-READY-1"]);
    assert.equal(held.results[0].outcome, "duplicate_blocked");
    const unanswered = partitionElryanBatchCreates({
      items: [{ sku: "OWCH180002" }],
      confirmedSkus: [],
      skuAvailability: { OWCH180002: null },
    });
    assert.equal(unanswered.send.length, 0);
    assert.equal(unanswered.results[0].outcome, "sku_unverified");
  });
});
