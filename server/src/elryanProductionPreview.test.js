import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Product } from "./models/Product.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { ElryanCategoryCatalogSnapshot } from "./models/ElryanCategoryCatalogSnapshot.js";
import { ElryanCollectionDimension } from "./models/ElryanCollectionDimension.js";
import { ElryanStagingDimensionCheck } from "./models/ElryanStagingDimensionCheck.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { setElryanFetch } from "./services/elryanClient.js";
import { __resetElryanAttributeValueCatalogCacheForTests } from "./services/elryanAttributeValueCatalog.js";
import { saveElryanVerifiedMapping } from "./services/elryanMappingSave.js";
import { upsertElryanValueMapping } from "./services/elryanAttributeMapping.js";
import { saveElryanProductWarrantyMapping } from "./services/elryanWarrantyMapping.js";
import { confirmElryanStagingDimensions } from "./services/elryanStagingInput.js";
import { approveElryanStagingPrice, previewElryanSyncOne, sendElryanSyncOne } from "./services/elryanSyncOne.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-production-preview-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-production-preview-key";

function mockResponse(status, body = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { get: () => "application/json" },
    async text() {
      return text;
    },
  };
}

describe("Elryan Production preview for OWCH180002", { concurrency: 1 }, () => {
  let memory;
  let productId;
  let otherId;
  let warrantyMode;
  let posts;
  let freshReads;

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-production-preview"));
  });

  after(async () => {
    setElryanFetch(null);
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    warrantyMode = "fresh-kenwood";
    posts = 0;
    freshReads = 0;
    __resetElryanAttributeValueCatalogCacheForTests();
    delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
    delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    await Promise.all([
      Product.deleteMany({}),
      ElryanConnection.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      ElryanCategoryCatalogSnapshot.deleteMany({}),
      ElryanCollectionDimension.deleteMany({}),
      ElryanStagingDimensionCheck.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({}),
    ]);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "production",
      hasApiKey: true,
      productionApiKeyEnc: encryptApiKey(API_KEY),
    });
    const product = await Product.create({
      ibsherId: "ibs-chopper",
      itemCode: "OWCH180002",
      name: { en: "Food Chopper" },
      description: { en: "Kenwood chopper 400 watts" },
      price: 66500,
      brand: { _id: "kenwood-brand", name: { en: "Kenwood" } },
      collectionName: { _id: "choppers", name: { en: "Choppers" } },
      variants: [
        {
          color: { en: "White" },
          images: [{ url: "https://cdn.example.com/chopper.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 10 }],
        },
      ],
      isActive: true,
    });
    productId = String(product._id);
    const other = await Product.create({
      ibsherId: "ibs-other",
      itemCode: "OTHER-1",
      name: { en: "Other" },
      price: 10000,
      brand: { _id: "kenwood-brand", name: { en: "Kenwood" } },
      collectionName: { _id: "choppers", name: { en: "Choppers" } },
      variants: [{ color: { en: "White" }, images: [{ url: "https://cdn.example.com/other.jpg" }], sizes: [{ stockQuantity: 1 }] }],
      isActive: true,
    });
    otherId = String(other._id);
    setElryanFetch(async (url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const target = String(url);
      assert.equal(method === "POST" || method === "PUT" || method === "PATCH", false);
      assert.equal(target.includes("staging-marketplace-api.elryan.com"), false);
      assert.equal(target.includes("https://marketplace-api.elryan.com/api"), true);
      if (method !== "GET") posts += 1;
      if (target.includes("/v1/warranty")) {
        const fresh = new URL(target).searchParams.get("fresh");
        if (fresh === "true") freshReads += 1;
        if (warrantyMode === "similar-only") {
          return mockResponse(200, { data: [{ warranty_code: "near", warranty_name: "Kenwood Food Chopper Pro" }] });
        }
        if (fresh === "true") {
          return mockResponse(200, {
            data: [{ warranty_code: "kenwood-chopper", warranty_name: "Kenwood Food Chopper" }],
          });
        }
        return mockResponse(200, { data: [{ warranty_code: "stale-code", warranty_name: "Kenwood Food Chopper" }] });
      }
      if (target.includes("/attribute-values/Brand/list")) {
        return mockResponse(200, { data: [{ id: "276", name: "Kenwood" }] });
      }
      if (target.includes("/attribute-values/Color/list")) {
        return mockResponse(200, { data: [{ id: "59", name: "White" }] });
      }
      if (target.includes("/v1/attribute-sets/category/")) {
        return mockResponse(200, {
          data: {
            id: "as-power",
            attributes: [
              {
                code: "chopper_power",
                name: "Power",
                mandatory: true,
                values: [{ id: 6150, name: "300-500" }],
              },
              { code: "plug_type", mandatory: true, values: [{ id: 5, name: "Two pin" }] },
            ],
          },
        });
      }
      if (target.includes("/commissions/calculate")) {
        return mockResponse(200, { data: { commission: 0 } });
      }
      return mockResponse(200, { data: [] });
    });
  });

  it("previews Production locally and keeps product writes disabled", async () => {
    await ElryanValueMapping.create({
      kind: "warranty",
      brownKey: "staging:brand:kenwood-brand",
      environment: "staging",
      warrantyScope: "brand",
      elryanCode: "staging-warranty",
      elryanLabel: "Staging warranty",
    });
    await ElryanCollectionDimension.create({
      environment: "staging",
      brownCollectionId: "choppers",
      width: 10,
      height: 20,
      depth: 30,
      unit: "cm",
      applyMode: "AUTO_APPLY",
      enabled: true,
      verifiedForCollection: true,
      confirmedAt: new Date(),
      confirmedBy: "staging@brownstore.test",
    });
    await ElryanStagingDimensionCheck.create({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      unit: "cm",
      width: 1,
      height: 1,
      depth: 1,
      axesConfirmed: true,
      confirmedAt: new Date(),
    });

    const blocked = await previewElryanSyncOne({ productId });
    assert.equal(blocked.connection.environment, "production");
    assert.equal(blocked.productWritesEnabled, false);
    assert.equal(blocked.liveWritesAllowed, false);
    assert.equal(blocked.product.stock, 10);
    assert.equal(blocked.pricing.proposedElryanPrice, 66500);
    assert.equal(blocked.packageDimensions.reason, "production_isolated");
    assert.match(blocked.packageDimensions.note, /Production package dimensions are missing/);
    assert.equal(blocked.packageDimensions.note.includes("Staging only"), false);
    const priceBlocker = blocked.blockers.find((blocker) => blocker.code === "pricing_unverified");
    assert.match(priceBlocker.message, /No Production price approval/);
    assert.equal(blocked.warranty?.elryanCode || "", "");
    assert.equal(freshReads >= 1, true);
    assert.equal(
      blocked.blockers.some((blocker) => blocker.code === "missing_category_mapping"),
      true
    );

    warrantyMode = "similar-only";
    await assert.rejects(
      () => saveElryanProductWarrantyMapping({ productId, sku: "OWCH180002", confirm: true }),
      (error) => error.code === "warranty_name_missing"
    );
    warrantyMode = "fresh-kenwood";
    await assert.rejects(
      () => saveElryanProductWarrantyMapping({ productId, sku: "OWCH180002", elryanCode: "stale-code", confirm: true }),
      (error) => error.code === "invalid_warranty_code"
    );
    const warranty = await saveElryanProductWarrantyMapping({ productId, sku: "OWCH180002", confirm: true });
    assert.equal(warranty.mapping.elryanCode, "kenwood-chopper");
    assert.equal(warranty.productPostCalled, false);
    assert.equal(warranty.productWritesEnabled, false);

    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      categories: [{ id: 999, name: "Staging only", hierarchy: "Staging", isParent: false }],
    });
    await ElryanCategoryCatalogSnapshot.create({
      environment: "production",
      status: "complete",
      coverage: "complete",
      categories: [{ id: 340, name: "Chopper", hierarchy: "Appliances : Chopper", isParent: false }],
    });
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "choppers",
      values: {
        environments: {
          staging: { categoryId: "999", categoryName: "Staging only", categoryHierarchy: "Staging", attributeSetId: "" },
        },
      },
    });
    const savedCategory = await saveElryanVerifiedMapping({
      brownCollectionId: "choppers",
      categoryId: "340",
      confirm: true,
    });
    assert.equal(savedCategory.environment, "production");
    const stored = await PlatformTaxonomyConfig.findOne({ partner: "elryan", brownCollectionId: "choppers" }).lean();
    assert.equal(stored.values.environments.staging.categoryId, "999");
    assert.equal(stored.values.environments.production.categoryId, "340");
    await PlatformTaxonomyConfig.updateOne(
      { partner: "elryan", brownCollectionId: "choppers" },
      { $set: { "values.environments.production.attributes": { plug_type: 5 } } }
    );
    await upsertElryanValueMapping({
      kind: "brand",
      environment: "production",
      brownKey: "kenwood-brand",
      brownLabel: "Kenwood",
      elryanId: "276",
      elryanLabel: "Kenwood",
    });
    await upsertElryanValueMapping({
      kind: "color",
      environment: "production",
      brownKey: "white",
      brownLabel: "White",
      elryanId: "59",
      elryanLabel: "White",
    });

    await assert.rejects(
      () =>
        confirmElryanStagingDimensions({
          environment: "production",
          productId: otherId,
          sku: "OTHER-1",
          unit: "cm",
          width: 20,
          height: 30,
          depth: 40,
          axesConfirmed: true,
          confirm: true,
        }),
      (error) => error.code === "first_test_sku_only"
    );
    await confirmElryanStagingDimensions({
      environment: "production",
      productId,
      sku: "OWCH180002",
      unit: "cm",
      width: 20,
      height: 30,
      depth: 40,
      axesConfirmed: true,
      confirm: true,
    });

    const priced = await previewElryanSyncOne({ productId });
    assert.equal(priced.mapping.categoryId, "340");
    assert.equal(priced.brand.elryanId, "276");
    assert.equal(priced.color.elryanId, "59");
    assert.equal(priced.warranty.elryanCode, "kenwood-chopper");
    assert.equal(priced.warranty.environment, "production");
    assert.equal(priced.proposedPayload.attributes.chopper_power, 6150);
    assert.equal(priced.proposedPayload.attributes.plug_type, 5);
    assert.equal(priced.packageDimensions.width, 20);
    assert.equal(priced.packageDimensions.status, "CONFIRMED");
    assert.match(priced.packageDimensions.note, /Production dimensions are confirmed/);
    assert.equal(priced.blockers.some((blocker) => blocker.code === "dimensions_unverified"), false);
    assert.equal(priced.blockers.some((blocker) => blocker.code === "pricing_unverified"), true);

    const approval = await approveElryanStagingPrice({ productId, confirm: true });
    assert.equal(approval.environment, "production");
    assert.equal(approval.price, 66500);
    const ready = await previewElryanSyncOne({ productId });
    assert.equal(ready.pricingApproval.valid, true);
    assert.equal(ready.readiness, "READY");
    assert.equal(ready.blockers.length, 0);
    assert.equal(ready.productWritesEnabled, false);

    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const sent = await sendElryanSyncOne({ productId, confirm: true, previewToken: ready.previewToken });
    assert.equal(sent.code, "staging_only");
    assert.equal(sent.published, false);
    assert.equal(posts, 0);
  });
});
