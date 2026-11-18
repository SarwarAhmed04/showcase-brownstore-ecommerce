import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ElryanCollectionDimension } from "./models/ElryanCollectionDimension.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanStagingDimensionCheck } from "./models/ElryanStagingDimensionCheck.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { Product } from "./models/Product.js";
import { setElryanFetch } from "./services/elryanClient.js";
import { __resetElryanAttributeValueCatalogCacheForTests } from "./services/elryanAttributeValueCatalog.js";
import { brownColourKeyFromResolved } from "./services/elryanAttributeMapping.js";
import { saveElryanScopedValueMapping, upsertElryanValueMapping } from "./services/elryanAttributeMapping.js";
import {
  listElryanCollectionDimensionCatalog,
  saveElryanCollectionDimension,
} from "./services/elryanCollectionDimensions.js";
import { listElryanPairMapping } from "./services/elryanPairMapping.js";
import { previewElryanSyncOne } from "./services/elryanSyncOne.js";
import {
  listElryanWarrantyMappingPage,
  saveElryanBrandWarrantyMapping,
} from "./services/elryanWarrantyMapping.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { ELRYAN_MAPPING_RELOAD_MESSAGE } from "./utils/elryanTaxonomyMapping.js";
import { assessElryanSellableUnits } from "./utils/elryanVariations.js";
import { toResolvedProduct } from "./utils/productView.js";

const API_KEY = "elryan-mapping-workflow-key";
const BRAND = "6a7051ee6a1aacf1cc23be46";
const COLLECTION = "6ace1b33669f3bf0af2b55f1";
const BRAND_ID = "10104";
const COLOR_ID = "52";
const WARRANTY = "ingco-warranty";
const OVERRIDE_WARRANTY = "product-warranty";

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function installFetch() {
  setElryanFetch(async (url) => {
    const target = String(url);
    if (target.includes("/attribute-values/Brand/list")) {
      return mockResponse(200, { success: true, data: [{ id: BRAND_ID, name: "Kenwood" }] });
    }
    if (target.includes("/attribute-values/Color/list")) {
      return mockResponse(200, { success: true, data: [{ id: COLOR_ID, name: "Black" }, { id: "99", name: "White" }] });
    }
    if (target.includes("/v1/warranty")) {
      return mockResponse(200, {
        success: true,
        data: [
          { code: WARRANTY, name: "Ingco Warranty" },
          { code: OVERRIDE_WARRANTY, name: "Product warranty" },
        ],
      });
    }
    return mockResponse(200, { success: true, data: [] });
  });
}

function product(itemCode, extra = {}) {
  return {
    ibsherId: `ibs-${itemCode}`,
    itemCode,
    name: { en: `Product ${itemCode}` },
    price: 25000,
    brand: { _id: BRAND, name: { en: "Kenwood" } },
    collectionName: {
      _id: COLLECTION,
      name: { en: "Choppers" },
      category: { name: { en: "Kitchen" } },
      subcategory: { name: { en: "Appliances" } },
    },
    variants: [{ color: { en: "Black" }, sizes: [{ stockQuantity: 2 }] }],
    warranty: { duration: 1, unit: "years" },
    images: [{ url: "https://cdn.example.com/product.jpg" }],
    ...extra,
  };
}

describe("Elryan mapping workflow", () => {
  let memory;

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-mapping-workflow"));
  });

  after(async () => {
    setElryanFetch(null);
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    installFetch();
    __resetElryanAttributeValueCatalogCacheForTests();
    await Promise.all([
      Product.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      ElryanCollectionDimension.deleteMany({}),
      ElryanStagingDimensionCheck.deleteMany({}),
      ElryanConnection.deleteMany({}),
    ]);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      productionApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
  });

  it("saves and reopens colour, brand, warranty, and dimension mappings, keeps environments separate, and reuses them", async () => {
    const [first, second, special] = await Product.create([
      product("MAPBLK001"),
      product("MAPBLK002"),
      product("MAPOVR001", { warranty: { code: "special-chopper", duration: 1, unit: "years" } }),
    ]);

    await upsertElryanValueMapping({
      kind: "brand",
      brownKey: BRAND,
      brownLabel: "Kenwood",
      elryanId: BRAND_ID,
      elryanLabel: "Kenwood",
    });
    await upsertElryanValueMapping({
      kind: "color",
      brownKey: "black",
      brownLabel: "black",
      elryanId: COLOR_ID,
      elryanLabel: "Black",
    });
    await saveElryanBrandWarrantyMapping({
      brownKey: BRAND,
      elryanCode: WARRANTY,
      confirmCoverage: true,
    });
    await upsertElryanValueMapping({
      kind: "warranty",
      warrantyScope: "product",
      environment: "staging",
      brownKey: "special-chopper",
      elryanCode: OVERRIDE_WARRANTY,
      elryanLabel: "Product warranty",
    });
    await saveElryanCollectionDimension({
      environment: "staging",
      brownCollectionId: COLLECTION,
      width: 12,
      height: 24,
      depth: 36,
      unit: "cm",
      applyMode: "AUTO_APPLY",
      enabled: true,
      verifiedForCollection: true,
      confirm: true,
      confirmAutoApply: true,
    });
    await ElryanStagingDimensionCheck.create({
      environment: "staging",
      productId: String(special._id),
      sku: "MAPOVR001",
      unit: "cm",
      width: 4,
      height: 5,
      depth: 6,
      axesConfirmed: true,
      confirmedAt: new Date(),
    });

    const brands = await listElryanPairMapping("brand");
    const colours = await listElryanPairMapping("color");
    const warranties = await listElryanWarrantyMappingPage();
    const dimensions = await listElryanCollectionDimensionCatalog();
    assert.equal(brands.environment, "staging");
    assert.equal(brands.options.find((row) => row.brownKey === BRAND)?.mapping?.elryanId, BRAND_ID);
    assert.equal(colours.options.find((row) => row.brownKey === "black")?.mapping?.elryanId, COLOR_ID);
    assert.equal(warranties.fresh, true);
    assert.equal(warranties.brands.find((row) => row.brownKey === BRAND)?.warranty?.code, WARRANTY);
    const savedRule = dimensions.collections.find((row) => row.brownCollectionId === COLLECTION)?.rule;
    assert.equal(savedRule.width, 12);
    assert.equal(savedRule.height, 24);
    assert.equal(savedRule.depth, 36);
    assert.equal(savedRule.environment, "staging");

    for (const doc of [first, second]) {
      const preview = await previewElryanSyncOne({ productId: String(doc._id) });
      assert.equal(preview.proposedPayload.brandId, BRAND_ID);
      assert.equal(preview.proposedPayload.colorId, COLOR_ID);
      assert.equal(preview.proposedPayload.warrantyCode, WARRANTY);
      assert.equal(preview.proposedPayload.width, 12);
      assert.equal(preview.proposedPayload.height, 24);
      assert.equal(preview.proposedPayload.depth, 36);
    }
    const override = await previewElryanSyncOne({ productId: String(special._id) });
    assert.equal(override.proposedPayload.brandId, BRAND_ID);
    assert.equal(override.proposedPayload.colorId, COLOR_ID);
    assert.equal(override.proposedPayload.warrantyCode, OVERRIDE_WARRANTY);
    assert.equal(override.proposedPayload.width, 4);
    assert.equal(override.proposedPayload.height, 5);
    assert.equal(override.proposedPayload.depth, 6);

    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });
    __resetElryanAttributeValueCatalogCacheForTests();
    const productionColours = await listElryanPairMapping("color");
    assert.equal(productionColours.environment, "production");
    assert.equal(productionColours.options.find((row) => row.brownKey === "black")?.mapping, null);
    await upsertElryanValueMapping({
      kind: "color",
      environment: "production",
      brownKey: "black",
      brownLabel: "black",
      elryanId: "99",
      elryanLabel: "White",
    });
    await saveElryanBrandWarrantyMapping({
      brownKey: BRAND,
      elryanCode: OVERRIDE_WARRANTY,
      confirmCoverage: true,
    });
    await saveElryanCollectionDimension({
      environment: "production",
      brownCollectionId: COLLECTION,
      width: 7,
      height: 8,
      depth: 9,
      unit: "cm",
      applyMode: "AUTO_APPLY",
      enabled: true,
      verifiedForCollection: true,
      confirm: true,
      confirmAutoApply: true,
    });
    const productionDimensions = await listElryanCollectionDimensionCatalog();
    assert.equal(productionDimensions.environment, "production");
    assert.equal(productionDimensions.collections.find((row) => row.brownCollectionId === COLLECTION)?.rule?.width, 7);
    const productionWarranty = await listElryanWarrantyMappingPage();
    assert.equal(productionWarranty.brands.find((row) => row.brownKey === BRAND)?.warranty?.code, OVERRIDE_WARRANTY);

    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "staging" } });
    const stagingAgain = await previewElryanSyncOne({ productId: String(first._id) });
    assert.equal(stagingAgain.proposedPayload.colorId, COLOR_ID);
    assert.equal(stagingAgain.proposedPayload.warrantyCode, WARRANTY);
    assert.equal(stagingAgain.proposedPayload.width, 12);
    const reopened = await listElryanCollectionDimensionCatalog();
    assert.equal(reopened.collections.find((row) => row.brownCollectionId === COLLECTION)?.rule?.width, 12);
    assert.equal(await ElryanCollectionDimension.countDocuments({ environment: "production", width: 7 }), 1);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "color", environment: "production", elryanId: "99" }), 1);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "color", environment: "staging", elryanId: COLOR_ID }), 1);
  });

  it("lists override colours with the same key preview and payload building resolve", async () => {
    const calls = [];
    setElryanFetch(async (url) => {
      calls.push(String(url));
      const target = String(url);
      if (target.includes("/attribute-values/Color/list")) {
        return mockResponse(200, { success: true, data: [{ id: "77", name: "Navy" }] });
      }
      if (target.includes("/v1/warranty")) {
        return mockResponse(200, { success: true, data: [] });
      }
      return mockResponse(200, { success: true, data: [] });
    });
    const doc = await Product.create(
      product("MAPNAVY01", {
        variants: [{ color: { en: "Red" }, sizes: [{ stockQuantity: 1 }] }],
        overrides: {
          variants: [{ color: { name: { en: "Navy" } }, sizes: [{ stockQuantity: 1 }] }],
        },
      })
    );
    const colours = await listElryanPairMapping("color");
    assert.deepEqual(
      colours.options.map((row) => row.brownKey),
      ["navy"]
    );
    const resolved = toResolvedProduct(await Product.findById(doc._id).lean());
    const variation = assessElryanSellableUnits(resolved);
    assert.equal(brownColourKeyFromResolved(resolved, variation), "navy");
    await saveElryanScopedValueMapping({
      kind: "color",
      environment: "staging",
      brownKey: "navy",
      brownLabel: "Navy",
      elryanId: "77",
      elryanLabel: "Navy",
    });
    const reopened = await listElryanPairMapping("color");
    assert.equal(reopened.options.find((row) => row.brownKey === "navy")?.mapping?.elryanId, "77");
    const preview = await previewElryanSyncOne({ productId: String(doc._id) });
    assert.equal(preview.proposedPayload.colorId, "77");
    assert.equal(calls.some((url) => url.includes("staging-marketplace-api.elryan.com")), true);
  });

  it("rejects a colour, brand, or warranty save when the connection changed and leaves both environments unchanged", async () => {
    const calls = [];
    setElryanFetch(async (url) => {
      const target = String(url);
      calls.push(target);
      const production = target.includes("://marketplace-api.elryan.com") && !target.includes("staging-marketplace-api.elryan.com");
      if (target.includes("/attribute-values/Brand/list")) {
        return mockResponse(200, {
          success: true,
          data: production ? [{ id: "88", name: "Kenwood" }] : [{ id: BRAND_ID, name: "Kenwood" }],
        });
      }
      if (target.includes("/attribute-values/Color/list")) {
        return mockResponse(200, {
          success: true,
          data: production ? [{ id: "99", name: "White" }] : [{ id: COLOR_ID, name: "Black" }],
        });
      }
      if (target.includes("/v1/warranty")) {
        return mockResponse(200, {
          success: true,
          data: production
            ? [{ code: "production-warranty", name: "Production warranty" }]
            : [{ code: WARRANTY, name: "Ingco Warranty" }],
        });
      }
      return mockResponse(200, { success: true, data: [] });
    });
    await Product.create(product("MAPENV001"));
    await saveElryanScopedValueMapping({
      kind: "color",
      environment: "staging",
      brownKey: "black",
      brownLabel: "black",
      elryanId: COLOR_ID,
      elryanLabel: "Black",
    });
    await saveElryanBrandWarrantyMapping({
      brownKey: BRAND,
      environment: "staging",
      elryanCode: WARRANTY,
      confirmCoverage: true,
    });
    const stagingBefore = await ElryanValueMapping.find().lean();
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });
    __resetElryanAttributeValueCatalogCacheForTests();
    calls.length = 0;
    await assert.rejects(
      () =>
        saveElryanScopedValueMapping({
          kind: "color",
          environment: "staging",
          brownKey: "black",
          brownLabel: "black",
          elryanId: COLOR_ID,
          elryanLabel: "Black",
        }),
      (error) => error.code === "environment_changed" && error.message === ELRYAN_MAPPING_RELOAD_MESSAGE
    );
    await assert.rejects(
      () =>
        saveElryanScopedValueMapping({
          kind: "brand",
          environment: "staging",
          brownKey: BRAND,
          brownLabel: "Kenwood",
          elryanId: BRAND_ID,
          elryanLabel: "Kenwood",
        }),
      (error) => error.code === "environment_changed"
    );
    await assert.rejects(
      () =>
        saveElryanBrandWarrantyMapping({
          brownKey: BRAND,
          environment: "staging",
          elryanCode: WARRANTY,
          confirmCoverage: true,
        }),
      (error) => error.code === "environment_changed" && error.message === ELRYAN_MAPPING_RELOAD_MESSAGE
    );
    assert.equal(calls.length, 0);
    assert.equal(await ElryanValueMapping.countDocuments(), stagingBefore.length);
    const savedProduction = await saveElryanScopedValueMapping({
      kind: "color",
      environment: "production",
      brownKey: "black",
      brownLabel: "black",
      elryanId: "99",
      elryanLabel: "White",
    });
    assert.equal(savedProduction.environment, "production");
    assert.equal(savedProduction.elryanId, "99");
    assert.equal(
      calls.some(
        (url) =>
          url.includes("://marketplace-api.elryan.com") &&
          !url.includes("staging-marketplace-api.elryan.com") &&
          url.includes("/attribute-values/Color/list")
      ),
      true
    );
    await assert.rejects(
      () =>
        saveElryanScopedValueMapping({
          kind: "color",
          environment: "production",
          brownKey: "black",
          brownLabel: "black",
          elryanId: COLOR_ID,
          elryanLabel: "Black",
        }),
      (error) => error.code === "attribute_value_not_found" || error.code === "name_id_mismatch"
    );
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "color", environment: "staging", elryanId: COLOR_ID }), 1);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "color", environment: "production" }), 1);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "warranty", environment: "staging", elryanCode: WARRANTY }), 1);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "warranty", environment: "production" }), 0);
  });

  it("stores staging and production collection dimensions under one unique environment and collection key", async () => {
    const path = ElryanCollectionDimension.schema.path("environment");
    assert.deepEqual(path.enumValues, ["staging", "production"]);
    const unique = ElryanCollectionDimension.schema.indexes().some(([fields, options]) => {
      return fields.environment === 1 && fields.brownCollectionId === 1 && options?.unique === true;
    });
    assert.equal(unique, true);
    await Product.create(product("MAPDIM001"));
    await ElryanCollectionDimension.create({
      environment: "staging",
      brownCollectionId: COLLECTION,
      width: 1,
      height: 2,
      depth: 3,
      unit: "cm",
      applyMode: "SUGGEST_REVIEW",
    });
    await ElryanCollectionDimension.create({
      environment: "production",
      brownCollectionId: COLLECTION,
      width: 4,
      height: 5,
      depth: 6,
      unit: "cm",
      applyMode: "SUGGEST_REVIEW",
    });
    await assert.rejects(() =>
      ElryanCollectionDimension.create({
        environment: "staging",
        brownCollectionId: COLLECTION,
        width: 9,
        height: 9,
        depth: 9,
        unit: "cm",
        applyMode: "DISABLED",
      })
    );
    assert.equal(await ElryanCollectionDimension.countDocuments({ brownCollectionId: COLLECTION }), 2);
    const staging = await listElryanCollectionDimensionCatalog();
    assert.equal(staging.collections.find((row) => row.brownCollectionId === COLLECTION)?.rule?.width, 1);
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });
    const production = await listElryanCollectionDimensionCatalog();
    assert.equal(production.collections.find((row) => row.brownCollectionId === COLLECTION)?.rule?.width, 4);
  });
});
