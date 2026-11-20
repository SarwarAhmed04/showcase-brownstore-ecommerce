import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { fileURLToPath } from "node:url";
import { ElryanCategoryCatalogSnapshot } from "./models/ElryanCategoryCatalogSnapshot.js";
import { ElryanCollectionDimension } from "./models/ElryanCollectionDimension.js";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanProductionSkuReservation } from "./models/ElryanProductionSkuReservation.js";
import { ElryanSyncJob } from "./models/ElryanSyncJob.js";
import { ElryanSyncProductResult } from "./models/ElryanSyncProductResult.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { Product } from "./models/Product.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  getElryanSyncAllStatus,
  listElryanProductionSelection,
  resetElryanSyncRuntimeForTests,
  runElryanSyncPreview,
  sendElryanProductionSelection,
} from "./services/elryanSyncAll.js";
import { encryptApiKey } from "./utils/partnerAuth.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-production-selection-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-production-selection-key";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LISTING_ID = "64b7c2e1a9f0d4c3b2a19011";

let memory;
let posts;
let createMode;

function mockResponse(status, body) {
  return {
    status,
    headers: { get: () => "application/json" },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function installFetch() {
  posts = [];
  setElryanFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    assert.equal(target.includes("staging-marketplace-api.elryan.com"), false);
    if (method !== "GET" && method !== "HEAD") {
      assert.equal(method, "POST");
      assert.match(target, /\/v1\/products$/);
      const body = JSON.parse(options.body || "{}");
      posts.push(body);
      if (createMode === "ambiguous") {
        const error = new Error("socket hang up");
        error.code = "network_error";
        throw error;
      }
      return mockResponse(201, {
        data: { id: `elr-${body.sku}`, sku: body.sku, status: "in_review" },
      });
    }
    if (target.includes("/sku-exists")) {
      const sku = new URL(target).searchParams.get("sku");
      if (createMode === "exists" && sku === "SEL-2") {
        return mockResponse(409, {
          success: false,
          error: { code: "CONFLICT", message: "SKU already used" },
          data: { id: LISTING_ID, sku, status: "published" },
        });
      }
      if (createMode === "unverified" && sku === "SEL-4") {
        return mockResponse(409, {
          success: false,
          error: { code: "CONFLICT", message: "SKU already used" },
          data: {},
        });
      }
      return mockResponse(200, { success: true, data: { available: true } });
    }
    if (method === "GET" && /\/v1\/products\/[^/?]+$/.test(new URL(target).pathname)) {
      const id = decodeURIComponent(target.split("/").pop());
      return mockResponse(200, { data: { id, sku: "SEL-2", status: "published" } });
    }
    if (target.includes("/v1/warranty")) {
      return mockResponse(200, {
        success: true,
        data: [{ warranty_code: "W-STD", warranty_name: "Standard" }],
      });
    }
    if (target.includes("/v1/attribute-sets/category/")) {
      return mockResponse(200, {
        success: true,
        data: {
          id: "as-1",
          attributes: [{ code: "plug_type", mandatory: true, values: [{ id: "5", name: "Two pin" }] }],
        },
      });
    }
    return mockResponse(200, { success: true, data: [] });
  });
}

function productShape(overrides) {
  return {
    name: { en: overrides.itemCode },
    description: { en: "Desk lamp" },
    price: 10000,
    isActive: true,
    category: { _id: "cat-1", name: { en: "Home" } },
    subCategory: { _id: "sub-1", name: { en: "Lighting" } },
    brand: { _id: "brand-1", name: { en: "Acme" } },
    collectionName: { _id: "col-1", name: { en: "Lamps" } },
    variants: [
      {
        color: { en: "Black" },
        images: [{ url: "https://cdn.example.com/lamp.jpg", isMain: true }],
        sizes: [{ size: "One", stockQuantity: 4 }],
      },
    ],
    ...overrides,
    name: { en: overrides.name || overrides.itemCode },
  };
}

async function waitForPreview() {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 8000) {
    last = await getElryanSyncAllStatus();
    if (last.job?.status === "preview" && last.job?.finishedAt) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const rows = await ElryanSyncProductResult.find({}).select("sku status reason blockerCodes").lean();
  throw new Error(`preview did not finish (${last?.job?.status} ${last?.job?.ready}) ${JSON.stringify(rows)}`);
}

function enableWrites() {
  process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
  process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
}

describe("Elryan Production selected send", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-production-selection"));
    await Partner.create({ slug: "elryan", name: "Elryan", isActive: true });
  });

  after(async () => {
    resetElryanSyncRuntimeForTests();
    setElryanFetch(null);
    delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
    delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    createMode = "";
    resetElryanSyncRuntimeForTests();
    installFetch();
    delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
    delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    await Promise.all([
      Product.deleteMany({}),
      ElryanConnection.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      ElryanCategoryCatalogSnapshot.deleteMany({}),
      ElryanCollectionDimension.deleteMany({}),
      ElryanSyncJob.deleteMany({}),
      ElryanSyncProductResult.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
      ElryanProductionSkuReservation.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({}),
    ]);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "production",
      hasApiKey: true,
      productionApiKeyEnc: encryptApiKey(API_KEY),
    });
    await ElryanValueMapping.create([
      {
        kind: "brand",
        brownKey: "production:brand-1",
        environment: "production",
        elryanId: "elr-brand-1",
        elryanLabel: "Acme",
      },
      {
        kind: "color",
        brownKey: "production:black",
        environment: "production",
        elryanId: "elr-color-1",
        elryanLabel: "Black",
      },
      {
        kind: "warranty",
        brownKey: "production:brand:brand-1",
        environment: "production",
        warrantyScope: "brand",
        elryanCode: "W-STD",
        elryanLabel: "Standard",
      },
    ]);
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "col-1",
      values: {
        environments: {
          production: {
            categoryId: "340",
            categoryName: "Lamps",
            attributes: { plug_type: "5" },
          },
        },
      },
    });
    await ElryanCategoryCatalogSnapshot.create({
      environment: "production",
      status: "complete",
      coverage: "complete",
      categories: [{ id: 340, name: "Lamps", hierarchy: "Home : Lamps", isParent: false }],
    });
    await ElryanCollectionDimension.create({
      environment: "production",
      brownCollectionId: "col-1",
      width: 10,
      height: 20,
      depth: 20,
      unit: "cm",
      applyMode: "AUTO_APPLY",
      enabled: true,
      verifiedForCollection: true,
      verificationSource: "operator",
      confirmedAt: new Date(),
      confirmedBy: "elryan-selection@brownstore.test",
    });
    await Product.create([
      productShape({ ibsherId: "ibs-1", itemCode: "SEL-1", name: "Lamp One" }),
      productShape({ ibsherId: "ibs-2", itemCode: "SEL-2", name: "Lamp Two" }),
      productShape({ ibsherId: "ibs-3", itemCode: "SEL-3", name: "Lamp Three" }),
      productShape({ ibsherId: "ibs-4", itemCode: "SEL-4", name: "Lamp Four" }),
    ]);
  });

  async function readySelection() {
    await runElryanSyncPreview({ strategy: "full" });
    const done = await waitForPreview();
    assert.equal(done.environment, "production");
    assert.equal(done.job.ready, 4);
    assert.equal(done.job.newCount, 4);
    assert.equal(posts.length, 0);
    const listed = await listElryanProductionSelection();
    assert.equal(listed.ok, true);
    assert.equal(listed.previewId, done.job.id);
    assert.equal(listed.candidates.length, 4);
    for (const row of listed.candidates) {
      assert.equal(typeof row.name, "string");
      assert.ok(row.name);
      assert.ok(row.sku);
      assert.ok(row.productId);
      assert.equal(row.price, 10000);
      assert.equal(row.stock, 4);
    }
    return listed;
  }

  function sendBody(listed, skus) {
    return {
      previewId: listed.previewId,
      confirm: true,
      products: listed.candidates.filter((row) => skus.includes(row.sku)),
    };
  }

  it("sends only the selected new rows and keeps the bulk start buttons closed", async () => {
    const page = fs.readFileSync(path.join(__dirname, "../../client/src/components/admin/platform/ElryanSyncAll.jsx"), "utf8");
    const english = fs.readFileSync(path.join(__dirname, "../../client/src/i18n.js"), "utf8");
    assert.match(page, /disabled title=\{t\.elryanSyncWritesDisabled\}/);
    assert.match(page, /t\.elryanSendSelectedProduction/);
    assert.match(english, /elryanSendSelectedProduction: "Send selected to Production"/);
    const service = fs.readFileSync(path.join(__dirname, "services/elryanSyncAll.js"), "utf8");
    assert.equal(/Product\.(update|findOneAndUpdate|create|delete)/.test(service), false);

    enableWrites();
    const listed = await readySelection();
    const selected = sendBody(listed, ["SEL-1", "SEL-3"]);
    const sent = await sendElryanProductionSelection(selected);
    assert.equal(sent.code, "sent");
    assert.equal(sent.sentToElryan, 2);
    assert.deepEqual(posts.map((body) => body.sku).sort(), ["SEL-1", "SEL-3"]);
    assert.deepEqual(
      sent.results.map((row) => [row.sku, row.elryanProductId, row.listingStatus]).sort(),
      [
        ["SEL-1", "elr-SEL-1", "in_review"],
        ["SEL-3", "elr-SEL-3", "in_review"],
      ]
    );
    assert.equal(posts.some((body) => body.sku === "SEL-2" || body.sku === "SEL-4"), false);
    assert.equal(posts.some((body) => body.cost != null), false);

    const again = await sendElryanProductionSelection(selected);
    assert.equal(again.sentToElryan, 0);
    assert.equal(posts.length, 2);
    assert.equal(again.code, "updates_not_in_pilot");
  });

  it("blocks a stale preview, an existing listing, an unverified listing, and a second create after an ambiguous response", async () => {
    enableWrites();
    const listed = await readySelection();
    const currentId = listed.previewId;

    await ElryanSyncJob.create({
      environment: "production",
      status: "preview",
      mode: "preview",
      strategy: "full",
      createdAt: new Date(Date.now() + 5000),
    });
    const stale = await sendElryanProductionSelection(sendBody(listed, ["SEL-1"]));
    assert.equal(stale.code, "stale_preview");
    assert.equal(stale.sentToElryan, 0);
    assert.equal(posts.length, 0);
    await ElryanSyncJob.deleteOne({ _id: { $ne: currentId } });

    const product = await Product.findOne({ itemCode: "SEL-4" });
    await Product.updateOne({ _id: product._id }, { $set: { price: 18000 } });
    const changedPrice = await sendElryanProductionSelection(sendBody(listed, ["SEL-4"]));
    assert.equal(changedPrice.code, "stale_preview");
    assert.equal(posts.length, 0);
    await Product.updateOne({ _id: product._id }, { $set: { price: 10000 } });

    const changed = listed.candidates.find((row) => row.sku === "SEL-3");
    await ElryanConfirmedSend.create({
      environment: "production",
      productId: changed.productId,
      sku: "SEL-3",
      payloadHash: "previous-listing",
      elryanProductId: "64b7c2e1a9f0d4c3b2a19022",
      httpStatus: 201,
      published: true,
      confirmedAt: new Date(),
    });
    const update = await sendElryanProductionSelection(sendBody(listed, ["SEL-3"]));
    assert.equal(update.code, "updates_not_in_pilot");
    assert.equal(posts.length, 0);

    createMode = "exists";
    const mixed = await sendElryanProductionSelection(sendBody(listed, ["SEL-1", "SEL-2"]));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].sku, "SEL-1");
    const existing = mixed.results.find((row) => row.sku === "SEL-2");
    assert.equal(existing.sent, false);
    assert.equal(existing.code, "sku_already_exists");
    assert.equal(existing.elryanProductId, LISTING_ID);
    assert.equal(existing.listingStatus, "published");
    const created = mixed.results.find((row) => row.sku === "SEL-1");
    assert.equal(created.sent, true);
    assert.equal(created.listingStatus, "in_review");

    createMode = "unverified";
    const hidden = await sendElryanProductionSelection({
      previewId: currentId,
      confirm: true,
      products: [listed.candidates.find((row) => row.sku === "SEL-4")],
    });
    assert.equal(hidden.results[0].code, "listing_unverified");
    assert.equal(hidden.results[0].sent, false);
    assert.equal(posts.length, 1);

    createMode = "ambiguous";
    const one = listed.candidates.find((row) => row.sku === "SEL-4");
    const first = await sendElryanProductionSelection({
      previewId: currentId,
      confirm: true,
      products: [one],
    });
    assert.equal(first.results[0].code, "create_uncertain");
    assert.equal(posts.length, 2);
    const reserved = await ElryanProductionSkuReservation.findOne({ sku: "SEL-4" }).lean();
    assert.equal(reserved.status, "uncertain");
    const second = await sendElryanProductionSelection({
      previewId: currentId,
      confirm: true,
      products: [one],
    });
    assert.notEqual(second.results?.[0]?.sent, true);
    assert.equal(posts.length, 2);

    const unconfirmed = await sendElryanProductionSelection({
      ...sendBody(listed, ["SEL-1"]),
      confirm: false,
    });
    assert.equal(unconfirmed.code, "confirm_required");
    assert.equal(posts.length, 2);
    const tooMany = await sendElryanProductionSelection({
      previewId: currentId,
      confirm: true,
      products: listed.candidates,
    });
    assert.equal(tooMany.code, "too_many");
    assert.equal(posts.length, 2);
  });
});
