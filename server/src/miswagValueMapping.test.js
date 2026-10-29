import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { MiswagValueMapping } from "./models/MiswagValueMapping.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { Product } from "./models/Product.js";
import {
  createBrandResolverCache,
  normalizeBrandKey,
  resolveMiswagBrandForProduct,
} from "./services/miswagBrandResolve.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import { buildMiswagTestPayload, resolveMiswagColor } from "./services/miswagTestProduct.js";
import {
  rememberAutoBrandMapping,
  resetMiswagValueMapping,
  upsertMiswagValueMapping,
} from "./services/miswagValueMapping.js";

let mongo;

function mockResponse(status, body = {}, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async text() {
      return text;
    },
  };
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller.miswag.api.test";
  process.env.MISWAG_API_KEY = "test-key";
  process.env.MISWAG_API_SECRET = "test-secret";
  setMiswagFetch(async (url, options) => {
    if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
    return mockResponse(200, {});
  });
  assert.equal((await testMiswagConnection()).ok, true);
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

after(async () => {
  setMiswagFetch(null);
  delete process.env.MISWAG_API_KEY;
  delete process.env.MISWAG_API_SECRET;
  delete process.env.MISWAG_BASE_URL;
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  setMiswagFetch(null);
  delete process.env.MISWAG_API_KEY;
  delete process.env.MISWAG_API_SECRET;
  delete process.env.MISWAG_BASE_URL;
  await Promise.all([
    MiswagValueMapping.deleteMany({}),
    MiswagConnection.deleteMany({}),
    Product.deleteMany({}),
    PlatformTaxonomyConfig.deleteMany({}),
    ElryanValueMapping.deleteMany({}),
  ]);
});

describe("Miswag brand mappings and original color names", { concurrency: 1 }, () => {
  it("matches brands exactly via live search and remembers an auto mapping", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      assert.match(String(url), /\/v1\/brands\/search/);
      return mockResponse(200, {
        data: { content: [{ id: 42, name: "Philips", alias: "" }] },
      });
    });

    const result = await resolveMiswagBrandForProduct(
      { brand: { _id: "brand-philips", name: { en: "Philips" } } },
      createBrandResolverCache()
    );
    assert.equal(result.ok, true);
    assert.equal(result.brand.id, 42);
    assert.equal(result.source, "live_search");

    const saved = await MiswagValueMapping.findOne({
      kind: "brand",
      brownKey: "brand-philips",
    }).lean();
    assert.equal(saved.mode, "auto");
    assert.equal(saved.miswagId, "42");
  });

  it("uses an existing manual brand mapping and never overwrites it with auto", async () => {
    await upsertMiswagValueMapping({
      kind: "brand",
      brownKey: "brand-1",
      brownLabel: "Acme",
      miswagId: "99",
      miswagLabel: "Acme Official",
      mode: "manual",
    });

    const result = await resolveMiswagBrandForProduct(
      { brand: { _id: "brand-1", name: { en: "Acme" } } },
      createBrandResolverCache()
    );
    assert.equal(result.ok, true);
    assert.equal(result.brand.id, 99);
    assert.equal(result.source, "manual_mapping");

    await rememberAutoBrandMapping({
      brownKey: "brand-1",
      brownLabel: "Acme",
      miswagId: 7,
      miswagLabel: "Wrong",
    });
    const saved = await MiswagValueMapping.findOne({ kind: "brand", brownKey: "brand-1" }).lean();
    assert.equal(saved.mode, "manual");
    assert.equal(saved.miswagId, "99");
  });

  it("leaves ambiguous and unknown brands for manual review", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      return mockResponse(200, {
        data: {
          content: [
            { id: 1, name: "Dup", alias: "" },
            { id: 2, name: "Dup", alias: "dup" },
          ],
        },
      });
    });
    const ambiguous = await resolveMiswagBrandForProduct(
      { brand: { _id: "b-dup", name: { en: "Dup" } } },
      createBrandResolverCache()
    );
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, "brand_ambiguous");

    setMiswagFetch(async (url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      return mockResponse(200, { data: { content: [] } });
    });
    const missing = await resolveMiswagBrandForProduct(
      { brand: { _id: "b-x", name: { en: "UnknownBrandXYZ" } } },
      createBrandResolverCache()
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "brand_unresolved");
  });

  it("uses original BrownStore color names without HEX or mapping", () => {
    assert.deepEqual(resolveMiswagColor({ color: { name: { en: "Black + White" }, hex: "#000000" } }), {
      name: "Black + White",
    });
    assert.deepEqual(resolveMiswagColor({ color: { name: { en: "Space Gray" } } }), {
      name: "Space Gray",
    });
    assert.deepEqual(resolveMiswagColor({ color: { name: { en: "Dark Blue" } } }), {
      name: "Dark Blue",
    });
    assert.equal(resolveMiswagColor({ color: { hex: "#112233" } }), null);
    assert.equal(resolveMiswagColor({ color: { name: { en: "" } } }), null);
  });

  it("builds variation color with name only and no value field", () => {
    process.env.MEDIA_PUBLIC_ORIGIN = "https://cdn.example.com";
    const built = buildMiswagTestPayload(
      {
        ibsherId: "ibs-color",
        itemCode: "SKU-COLOR",
        name: { en: "Color Product", ar: "منتج لوني كافٍ" },
        description: { ar: "وصف عربي كافٍ للمنتج التجريبي" },
        price: 1000,
        isActive: true,
        keyword: ["color"],
        brand: { _id: "brand-1", name: { en: "Philips" } },
        collectionName: { _id: "col-1", name: { en: "Col" } },
        variants: [
          {
            _id: "v1",
            barcode: "6291041500999",
            color: { name: { en: "Black + White" }, hex: "#ABCDEF" },
            images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
            sizes: [{ _id: "s1", size: "M", stockQuantity: 2 }],
          },
        ],
      },
      {
        categoryId: "L4-100",
        brandId: "42",
        brandName: "Philips",
      }
    );
    assert.equal(built.ok, true);
    assert.deepEqual(built.payload.variations[0].color, { name: "Black + White" });
    assert.equal(Object.prototype.hasOwnProperty.call(built.payload.variations[0].color, "value"), false);
    assert.equal(built.errors.includes("missing_color_name"), false);
    assert.equal(built.errors.includes("missing_color_value"), false);
  });

  it("does not alter category mappings or Elryan value mappings", async () => {
    await PlatformTaxonomyConfig.create({
      partner: "miswag",
      brownCollectionId: "col-1",
      values: { categoryId: "L4-100" },
    });
    await ElryanValueMapping.create({
      kind: "brand",
      brownKey: "brand-1",
      elryanId: "el-9",
      elryanLabel: "Elryan Brand",
    });
    await MiswagValueMapping.create({
      kind: "color",
      brownKey: "historical",
      brownLabel: "Historical",
      hex: "#123456",
      mode: "manual",
    });

    await upsertMiswagValueMapping({
      kind: "brand",
      brownKey: "brand-1",
      brownLabel: "Philips",
      miswagId: "42",
      miswagLabel: "Philips",
      mode: "manual",
    });
    await resetMiswagValueMapping("brand", "brand-1");

    const category = await PlatformTaxonomyConfig.findOne({
      partner: "miswag",
      brownCollectionId: "col-1",
    }).lean();
    assert.equal(category.values.categoryId, "L4-100");

    const elryan = await ElryanValueMapping.findOne({ kind: "brand", brownKey: "brand-1" }).lean();
    assert.equal(elryan.elryanId, "el-9");

    const historicalColor = await MiswagValueMapping.findOne({
      kind: "color",
      brownKey: "historical",
    }).lean();
    assert.equal(historicalColor.hex, "#123456");

    await assert.rejects(
      () =>
        upsertMiswagValueMapping({
          kind: "color",
          brownKey: "new",
          hex: "#FFFFFF",
        }),
      /color mapping has been removed/i
    );
  });

  it("normalizes brand keys consistently for cache lookups", () => {
    assert.equal(normalizeBrandKey("Philips"), normalizeBrandKey("  philips "));
  });
});
