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
import { ElryanStagingPriceApproval } from "./models/ElryanStagingPriceApproval.js";
import { ElryanSendAttempt } from "./models/ElryanSendAttempt.js";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanSyncOnePreview } from "./models/ElryanSyncOnePreview.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { setElryanFetch } from "./services/elryanClient.js";

const LISTING_ID = "64b7c2e1a9f0d4c3b2a19001";
const OTHER_LISTING_ID = "64b7c2e1a9f0d4c3b2a19002";
import { __resetElryanAttributeValueCatalogCacheForTests } from "./services/elryanAttributeValueCatalog.js";
import { saveElryanVerifiedMapping } from "./services/elryanMappingSave.js";
import { upsertElryanValueMapping } from "./services/elryanAttributeMapping.js";
import { saveElryanProductWarrantyMapping } from "./services/elryanWarrantyMapping.js";
import { confirmElryanStagingDimensions } from "./services/elryanStagingInput.js";
import { elryanCreateProduct } from "./services/elryanCatalog.js";
import { startElryanSyncAll } from "./services/elryanSyncAll.js";
import {
  previewElryanProductionUpdate,
  updateElryanProductionDimensions,
} from "./services/elryanProductionUpdate.js";
import {
  approveElryanStagingPrice,
  previewElryanSyncOne,
  sendElryanProductionOne,
  sendElryanSyncOne,
} from "./services/elryanSyncOne.js";

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
  let createMode;
  let skuReads;
  let createdBody;
  let failNextSku;
  let hangPromise;
  let writeCalls;
  let listingBody;
  let savedListing;
  let patches;
  let skuConflictId;

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
    createMode = "";
    skuReads = 0;
    createdBody = null;
    failNextSku = false;
    hangPromise = Promise.resolve();
    writeCalls = [];
    listingBody = null;
    savedListing = null;
    patches = [];
    skuConflictId = "elr-existing";
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
      ElryanStagingPriceApproval.deleteMany({}),
      ElryanSendAttempt.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
      ElryanSyncOnePreview.deleteMany({}),
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
      assert.equal(target.includes("staging-marketplace-api.elryan.com"), false);
      assert.equal(target.includes("https://marketplace-api.elryan.com/api"), true);
      if (method !== "GET" && method !== "HEAD") writeCalls.push(`${method} ${target}`);
      if (target.includes("/sku-exists")) {
        skuReads += 1;
        if (createMode === "duplicate" || (createMode === "timeout-taken" && skuReads > 1)) {
          return mockResponse(409, {
            success: false,
            error: { code: "CONFLICT", message: "SKU already used" },
            data: { id: skuConflictId, sku: "OWCH180002", status: "in_review" },
          });
        }
        if (failNextSku) {
          throw new Error("sku check failed");
        }
        return mockResponse(200, { success: true, data: { available: true } });
      }
      if (method === "GET" && /\/v1\/products\/[^/?]+$/.test(new URL(target).pathname)) {
        const id = decodeURIComponent(target.split("/").pop());
        const body = savedListing || listingBody || {
          id,
          sku: "OWCH180002",
          price: 50000,
          quantity: 4,
          categoryId: "340",
          width: 10,
          height: 30,
          depth: 40,
        };
        return mockResponse(200, { data: { ...body, id: body.id || id } });
      }
      if (method === "PATCH" && /\/v1\/products\/[^/?]+$/.test(new URL(target).pathname)) {
        const id = decodeURIComponent(target.split("/").pop());
        const parsed = JSON.parse(options.body || "{}");
        patches.push({ url: target, body: parsed });
        const prior = savedListing || listingBody || {
          id,
          sku: "OWCH180002",
          width: 10,
          height: 30,
          depth: 40,
        };
        savedListing = { ...prior, ...parsed, id, sku: prior.sku || "OWCH180002" };
        return mockResponse(200, { data: savedListing });
      }
      if (method === "POST" && target.endsWith("/v1/products")) {
        assert.equal(target, "https://marketplace-api.elryan.com/api/v1/products");
        posts += 1;
        createdBody = JSON.parse(options.body || "{}");
        if (createMode === "hang") await hangPromise;
        if (createMode === "timeout" || createMode === "timeout-taken" || createMode === "timeout-uncheckable") {
          if (createMode === "timeout-uncheckable") failNextSku = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return mockResponse(201, { data: { id: "elr-prod-1", status: "in_review" } });
      }
      assert.equal(method === "POST" || method === "PUT" || method === "PATCH", false);
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

  async function prepareReady() {
    await saveElryanProductWarrantyMapping({ productId, sku: "OWCH180002", confirm: true });
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
    await saveElryanVerifiedMapping({ brownCollectionId: "choppers", categoryId: "340", confirm: true });
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
    await approveElryanStagingPrice({ productId, confirm: true });
    return previewElryanSyncOne({ productId });
  }

  it("creates OWCH180002 in Production and reports the listing id and status", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    createMode = "success";
    const ready = await prepareReady();
    assert.equal(ready.readiness, "READY");
    assert.equal(ready.product.stock, 10);
    assert.equal(ready.pricing.proposedElryanPrice, 66500);
    const sent = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.environment, "production");
    assert.equal(sent.elryanProductId, "elr-prod-1");
    assert.equal(sent.listingStatus, "in_review");
    assert.equal(sent.sku, "OWCH180002");
    assert.equal(posts, 1);
    assert.equal(skuReads, 1);
    assert.equal(createdBody.sku, "OWCH180002");
    assert.equal(createdBody.price, 66500);
    assert.equal(createdBody.quantity, 10);
    assert.equal(createdBody.cost, undefined);
  });

  it("stops when the Production SKU already exists and shows the listing", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    createMode = "duplicate";
    const ready = await prepareReady();
    const sent = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, "sku_already_exists");
    assert.equal(sent.listing.id, "elr-existing");
    assert.equal(sent.listing.status, "in_review");
    assert.equal(sent.listing.sku, "OWCH180002");
    assert.equal(posts, 0);
  });

  it("checks the SKU again after a create timeout before another attempt", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    createMode = "timeout";
    const ready = await prepareReady();
    const timedOut = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(timedOut.code, "create_timeout");
    assert.equal(posts, 1);
    assert.equal(skuReads, 2);
    const again = await previewElryanSyncOne({ productId });
    createMode = "success";
    const sent = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: again.previewToken,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.elryanProductId, "elr-prod-1");
    assert.equal(posts, 2);
    assert.ok(skuReads >= 3);
  });

  it("blocks Production create without write permission, confirmation, readiness, or the pilot SKU", async () => {
    const ready = await prepareReady();
    const closed = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(closed.code, "writes_disabled");
    assert.equal(posts, 0);

    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    const partial = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(partial.code, "writes_gated");

    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const unconfirmed = await sendElryanProductionOne({
      productId,
      confirm: false,
      previewToken: ready.previewToken,
    });
    assert.equal(unconfirmed.code, "confirm_required");

    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "staging" } });
    const staging = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(staging.code, "production_required");
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });

    const other = await sendElryanProductionOne({
      productId: otherId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(other.code, "first_test_sku_only");

    await ElryanStagingPriceApproval.deleteMany({});
    const notReady = await previewElryanSyncOne({ productId });
    const blocked = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: notReady.previewToken,
    });
    assert.equal(blocked.code, "pricing_unverified");
    assert.equal(posts, 0);
  });

  it("keeps a timed-out create blocked when the follow-up SKU check fails", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const ready = await prepareReady();
    createMode = "timeout-uncheckable";
    const timedOut = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(timedOut.code, "create_uncertain");
    assert.equal(posts, 1);
    failNextSku = false;
    const again = await previewElryanSyncOne({ productId });
    const second = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: again.previewToken,
    });
    assert.equal(second.code, "send_uncertain");
    assert.equal(posts, 1);
    assert.equal(writeCalls.filter((line) => line.startsWith("POST")).length, 1);
  });

  it("lets both write flags create only OWCH180002 and refuses bulk, update, and other Production writes", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const ready = await prepareReady();
    const bulk = await startElryanSyncAll({ confirm: true, strategy: "full" });
    assert.equal(bulk.ok, false);
    assert.equal(bulk.sentToElryan, 0);
    const stagingSend = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(stagingSend.code, "staging_only");
    await assert.rejects(
      () => elryanCreateProduct({ sku: "OWCH180002", price: 66500 }),
      (error) => error.code === "staging_only"
    );
    const other = await sendElryanProductionOne({
      productId: otherId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(other.code, "first_test_sku_only");
    assert.equal(posts, 0);
    assert.equal(writeCalls.some((line) => line.includes("/batch/")), false);
    assert.equal(writeCalls.some((line) => line.startsWith("PUT") || line.startsWith("PATCH")), false);

    createMode = "success";
    const sent = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.sku, "OWCH180002");
    assert.equal(posts, 1);
    assert.deepEqual(
      writeCalls.filter((line) => line.startsWith("POST")),
      ["POST https://marketplace-api.elryan.com/api/v1/products"]
    );
  });

  it("does not send a second POST for an overlapping Production confirmation", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const ready = await prepareReady();
    const secondPreview = await previewElryanSyncOne({ productId });
    let release = () => {};
    hangPromise = new Promise((resolve) => {
      release = resolve;
    });
    createMode = "hang";
    const first = sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: ready.previewToken,
    });
    for (let i = 0; i < 40 && posts < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const overlapped = await sendElryanProductionOne({
      productId,
      confirm: true,
      previewToken: secondPreview.previewToken,
    });
    assert.equal(overlapped.code, "send_in_progress");
    release();
    const created = await first;
    assert.equal(created.ok, true);
    assert.equal(posts, 1);
    assert.equal(writeCalls.filter((line) => line.startsWith("POST")).length, 1);
  });

  it("previews the existing OWCH180002 listing beside the proposed values and updates only differing dimensions", async () => {
    const ready = await prepareReady();
    createMode = "duplicate";
    skuConflictId = LISTING_ID;
    const preview = await previewElryanProductionUpdate({ productId, listingId: LISTING_ID });
    assert.equal(preview.matched, true);
    assert.equal(preview.sku, "OWCH180002");
    assert.equal(preview.listingId, LISTING_ID);
    assert.equal(preview.dimensionUnit, "cm");
    assert.deepEqual(preview.dimensionApiFields, ["width", "height", "depth"]);
    const width = preview.rows.find((row) => row.apiField === "width");
    const height = preview.rows.find((row) => row.apiField === "height");
    const depth = preview.rows.find((row) => row.apiField === "depth");
    assert.equal(width.current, 10);
    assert.equal(width.proposed, 20);
    assert.equal(width.differs, true);
    assert.equal(height.current, 30);
    assert.equal(height.proposed, 30);
    assert.equal(height.differs, false);
    assert.equal(depth.current, 40);
    assert.equal(depth.proposed, 40);
    assert.equal(preview.updateAllowed, true);
    assert.deepEqual(preview.dimensionPatch, { width: 20 });
    assert.equal(patches.length, 0);
    assert.equal(posts, 0);

    const refused = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(refused.code, "writes_disabled");
    assert.equal(patches.length, 0);
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const wrongAction = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: ready.previewToken,
    });
    assert.equal(wrongAction.code, "preview_mismatch");
    assert.equal(patches.length, 0);

    const updated = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(updated.ok, true);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].url, `https://marketplace-api.elryan.com/api/v1/products/${LISTING_ID}`);
    assert.deepEqual(patches[0].body, { width: 20 });
    assert.equal(patches[0].body.unit, undefined);
    assert.equal(updated.savedDimensions.unit, "cm");
    assert.equal(updated.savedDimensions.width, 20);
    assert.equal(updated.savedDimensions.height, 30);
    assert.equal(updated.savedDimensions.depth, 40);
    assert.equal(updated.rows.find((row) => row.apiField === "width").current, 20);
    assert.equal(posts, 0);
    assert.equal(writeCalls.some((line) => line.includes("/batch/") || line.startsWith("PUT")), false);
  });

  it("does not update when the SKU and listing ID disagree or the API dimension fields are absent", async () => {
    await prepareReady();
    createMode = "duplicate";
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    skuConflictId = LISTING_ID;
    const invalid = await previewElryanProductionUpdate({ productId, listingId: "elr-existing" });
    assert.equal(invalid.code, "listing_id_invalid");
    const matched = await previewElryanProductionUpdate({ productId, listingId: LISTING_ID });
    const mismatch = await previewElryanProductionUpdate({ productId, listingId: OTHER_LISTING_ID });
    assert.equal(mismatch.code, "listing_mismatch");
    assert.equal(mismatch.updateAllowed, false);
    const mismatchWrite = await updateElryanProductionDimensions({
      productId,
      listingId: OTHER_LISTING_ID,
      confirm: true,
      previewToken: matched.previewToken,
    });
    assert.equal(mismatchWrite.code, "preview_mismatch");
    assert.equal(patches.length, 0);

    listingBody = { id: LISTING_ID, sku: "OWCH180002", width: 10, height: 30, length: 50 };
    const foreign = await previewElryanProductionUpdate({ productId, listingId: LISTING_ID });
    assert.deepEqual(foreign.missingApiFields, ["depth"]);
    assert.equal(foreign.updateAllowed, false);
    const width = foreign.rows.find((row) => row.field === "width");
    assert.equal(width.current, 10);
    assert.equal(width.proposed, 20);
    const blocked = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: foreign.previewToken,
    });
    assert.equal(blocked.code, "dimension_fields_missing");
    assert.equal(patches.length, 0);
    assert.equal(posts, 0);
  });

  it("does not patch a listing whose confirmed dimensions already match", async () => {
    await prepareReady();
    createMode = "duplicate";
    skuConflictId = LISTING_ID;
    listingBody = {
      id: LISTING_ID,
      sku: "OWCH180002",
      width: 20,
      height: 30,
      depth: 40,
    };
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const preview = await previewElryanProductionUpdate({ productId, listingId: LISTING_ID });
    assert.equal(preview.updateAllowed, false);
    assert.deepEqual(preview.dimensionPatch, {});
    const same = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(same.code, "dimensions_unchanged");
    assert.equal(patches.length, 0);
  });

  it("does not PATCH when the reviewed dimensions or the proposed patch change", async () => {
    await prepareReady();
    createMode = "duplicate";
    skuConflictId = LISTING_ID;
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const preview = await previewElryanProductionUpdate({ productId, listingId: LISTING_ID });
    assert.deepEqual(preview.dimensionPatch, { width: 20 });
    listingBody = {
      id: LISTING_ID,
      sku: "OWCH180002",
      width: 12,
      height: 30,
      depth: 40,
    };
    const staleDimensions = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(staleDimensions.code, "preview_stale");
    assert.equal(patches.length, 0);

    listingBody = {
      id: LISTING_ID,
      sku: "OWCH180002",
      width: 10,
      height: 30,
      depth: 40,
    };
    await ElryanStagingDimensionCheck.updateOne({ productId, environment: "production" }, { width: 25 });
    const stalePatch = await updateElryanProductionDimensions({
      productId,
      listingId: LISTING_ID,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(stalePatch.code, "preview_stale");
    assert.equal(patches.length, 0);
    assert.equal(posts, 0);
  });
});
