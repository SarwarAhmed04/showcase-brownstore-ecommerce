import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { MiswagProductSyncState } from "./models/MiswagProductSyncState.js";
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
import { saveMiswagAcceptedPayload } from "./services/miswagSyncState.js";
import {
  listMiswagColorMappingRows,
  loadMiswagColorMappingMap,
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

function colorProduct(overrides = {}) {
  return {
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
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
        sizes: [{ _id: "s1", size: "M", stockQuantity: 2 }],
      },
    ],
    ...overrides,
  };
}

describe("Miswag brand and color mappings", { concurrency: 1 }, () => {
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

  it("auto-maps only exact verified colors and keeps the original name", () => {
    assert.deepEqual(resolveMiswagColor({ color: { name: { en: "BLUE" }, hex: "#111111" } }), {
      name: "BLUE",
      value: "#0000FF",
      source: "verified_name",
    });
    assert.equal(resolveMiswagColor({ color: { name: { en: "White" }, hex: "#000000" } }).value, "#FFFFFF");
    assert.equal(resolveMiswagColor({ color: { name: { en: "Green" } } }).value, "#008000");
    assert.equal(resolveMiswagColor({ color: { name: { en: "Red" } } }).value, "#FF0000");
    assert.equal(resolveMiswagColor({ color: { en: "Black" } }).value, "#000000");
    assert.equal(resolveMiswagColor({ color: { name: { en: "Space Gray" }, hex: "#000000" } }), null);
    assert.equal(resolveMiswagColor({ color: { name: { en: "Dark Blue" }, hex: "#00008B" } }), null);
    assert.equal(resolveMiswagColor({ color: { name: { en: "Black + White" }, hex: "#000000" } }), null);
    assert.equal(resolveMiswagColor({ color: { hex: "#112233" } }), null);
    assert.equal(resolveMiswagColor({ color: { name: { en: "" } } }), null);
  });

  it("lets a manual HEX override automatic matching without renaming the color", async () => {
    await upsertMiswagValueMapping({
      kind: "color",
      brownKey: "Black",
      brownLabel: "Black",
      hex: "#123456",
      miswagLabel: "#123456",
      mode: "manual",
    });
    await upsertMiswagValueMapping({
      kind: "color",
      brownKey: "black + white",
      brownLabel: "Black + White",
      hex: "fff",
      mode: "manual",
    });
    const colorMap = await loadMiswagColorMappingMap();
    const manual = resolveMiswagColor({ color: { name: { en: "Black" }, hex: "#000000" } }, colorMap);
    assert.equal(manual.name, "Black");
    assert.equal(manual.value, "#123456");
    assert.equal(manual.source, "manual_mapping");

    const multi = resolveMiswagColor({ color: { name: { en: "Black + White" } } }, colorMap);
    assert.deepEqual(
      { name: multi.name, value: multi.value },
      { name: "Black + White", value: "#FFFFFF" }
    );

    const saved = await MiswagValueMapping.findOne({ kind: "color", brownKey: "black + white" }).lean();
    assert.equal(saved.brownLabel, "Black + White");
    assert.equal(saved.miswagLabel, "Black + White");
    assert.equal(saved.hex, "#FFFFFF");

    await assert.rejects(
      () => upsertMiswagValueMapping({ kind: "color", brownKey: "Coral", hex: "not-a-color" }),
      /HEX/i
    );
  });

  it("builds every variation with the original name and a #RRGGBB value", async () => {
    process.env.MEDIA_PUBLIC_ORIGIN = "https://cdn.example.com";
    await upsertMiswagValueMapping({
      kind: "color",
      brownKey: "Mint",
      brownLabel: "Mint",
      hex: "#98FF98",
      mode: "manual",
    });
    const colorMap = await loadMiswagColorMappingMap();
    const built = buildMiswagTestPayload(
      colorProduct({
        variants: [
          {
            _id: "v1",
            barcode: "6291041500999",
            color: { name: { en: "Black" }, hex: "#ABCDEF" },
            images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
            sizes: [{ _id: "s1", size: "M", stockQuantity: 2 }],
          },
          {
            _id: "v2",
            barcode: "6291041501002",
            color: { name: { en: "Mint" }, hex: "#000000" },
            images: [{ url: "https://cdn.example.com/b.jpg", isMain: true }],
            sizes: [{ _id: "s2", size: "L", stockQuantity: 1 }],
          },
        ],
      }),
      { categoryId: "L4-100", brandId: "42", brandName: "Philips", colorMap }
    );
    assert.equal(built.ok, true);
    assert.equal(built.payload.variations.length, 2);
    assert.deepEqual(built.payload.variations[0].color, { name: "Black", value: "#000000" });
    assert.deepEqual(built.payload.variations[1].color, { name: "Mint", value: "#98FF98" });
    assert.equal(built.errors.includes("missing_color_value"), false);
  });

  it("blocks a product when any variation has no verified HEX", () => {
    process.env.MEDIA_PUBLIC_ORIGIN = "https://cdn.example.com";
    const built = buildMiswagTestPayload(
      colorProduct({
        variants: [
          {
            _id: "v1",
            barcode: "6291041500999",
            color: { name: { en: "Red" } },
            images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
            sizes: [{ _id: "s1", size: "M", stockQuantity: 2 }],
          },
          {
            _id: "v2",
            barcode: "6291041501002",
            color: { name: { en: "Black + White" }, hex: "#000000" },
            images: [{ url: "https://cdn.example.com/b.jpg", isMain: true }],
            sizes: [{ _id: "s2", size: "L", stockQuantity: 1 }],
          },
        ],
      }),
      { categoryId: "L4-100", brandId: "42", brandName: "Philips" }
    );
    assert.equal(built.ok, false);
    assert.equal(built.payload.variations.length, 2);
    assert.deepEqual(built.payload.variations[0].color, { name: "Red", value: "#FF0000" });
    assert.equal(built.payload.variations[1].color, undefined);
    assert.equal(built.errors.includes("missing_color_value"), true);
    assert.equal(built.errors.includes("missing_color_name"), false);
  });

  it("lists unique colors with product counts and keeps manual mappings after reset to auto", async () => {
    await Product.create({
      ibsherId: "c1",
      itemCode: "C1",
      name: { en: "One" },
      price: 1,
      variants: [
        { color: { name: { en: "Red" } } },
        { color: { name: { en: "Red" } } },
      ],
    });
    await Product.create({
      ibsherId: "c2",
      itemCode: "C2",
      name: { en: "Two" },
      price: 1,
      variants: [{ color: { name: { en: "Red" } } }, { color: { name: { en: "Space Gray" }, hex: "#000000" } }],
    });
    await MiswagValueMapping.create({
      kind: "color",
      brownKey: "historical",
      brownLabel: "Historical",
      hex: "#123456",
      mode: "manual",
    });

    const all = await listMiswagColorMappingRows({ limit: 50 });
    const red = all.rows.find((row) => row.brownKey === "red");
    const gray = all.rows.find((row) => row.brownKey === "space gray");
    const historical = all.rows.find((row) => row.brownKey === "historical");
    assert.equal(red.productCount, 2);
    assert.equal(red.status, "auto");
    assert.equal(red.miswag.hex, "#FF0000");
    assert.equal(red.brownLabel, "Red");
    assert.equal(gray.productCount, 1);
    assert.equal(gray.status, "needs_review");
    assert.equal(gray.miswag, null);
    assert.equal(historical.hex || historical.miswag.hex, "#123456");
    assert.equal(all.rows.some((row) => row.brownKey === "beige"), false);

    const needs = await listMiswagColorMappingRows({ status: "needs_review", limit: 50 });
    assert.equal(needs.rows.some((row) => row.brownKey === "space gray"), true);
    assert.equal(needs.rows.some((row) => row.brownKey === "red"), false);
    const autos = await listMiswagColorMappingRows({ status: "auto", limit: 50 });
    assert.equal(autos.rows.some((row) => row.brownKey === "red"), true);

    await upsertMiswagValueMapping({
      kind: "color",
      brownKey: "space gray",
      brownLabel: "Space Gray",
      hex: "#767676",
      mode: "manual",
    });
    const manual = await listMiswagColorMappingRows({ status: "manual", limit: 50 });
    assert.equal(manual.rows.some((row) => row.brownKey === "space gray"), true);

    await resetMiswagValueMapping("color", "Space Gray");
    const afterReset = await loadMiswagColorMappingMap();
    assert.equal(afterReset.has("space gray"), false);
    assert.equal(afterReset.get("historical").hex, "#123456");
    assert.equal(resolveMiswagColor({ color: { name: { en: "Space Gray" } } }, afterReset), null);
    const stillThere = await Product.findOne({ ibsherId: "c2" }).lean();
    assert.equal(stillThere.variants[1].color.name.en, "Space Gray");
    assert.equal(stillThere.variants[1].color.hex, "#000000");
  });

  it("does not record a rejected Miswag response as an accepted payload hash", async () => {
    const saved = await saveMiswagAcceptedPayload({
      externalId: "bs-rejected",
      payload: { external_id: "bs-rejected", variations: [{ color: { name: "White" } }] },
      httpStatus: 422,
    });
    assert.equal(saved, null);
    assert.equal(await MiswagProductSyncState.countDocuments({ externalId: "bs-rejected" }), 0);

    const accepted = await saveMiswagAcceptedPayload({
      externalId: "bs-ok",
      payload: {
        external_id: "bs-ok",
        variations: [{ color: { name: "White", value: "#FFFFFF" } }],
      },
      httpStatus: 201,
    });
    assert.equal(accepted.lastHttpStatus, 201);
    assert.ok(accepted.lastPayloadHash);
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

    await upsertMiswagValueMapping({
      kind: "color",
      brownKey: "new",
      brownLabel: "New",
      hex: "#FFFFFF",
      mode: "manual",
    });
    const added = await MiswagValueMapping.findOne({ kind: "color", brownKey: "new" }).lean();
    assert.equal(added.hex, "#FFFFFF");
    const historicalAfter = await MiswagValueMapping.findOne({
      kind: "color",
      brownKey: "historical",
    }).lean();
    assert.equal(historicalAfter.hex, "#123456");
  });

  it("normalizes brand keys consistently for cache lookups", () => {
    assert.equal(normalizeBrandKey("Philips"), normalizeBrandKey("  philips "));
  });
});
