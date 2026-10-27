import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { CatalogBlock } from "./models/CatalogBlock.js";
import { Product } from "./models/Product.js";
import { Partner } from "./models/Partner.js";
import {
  isCatalogBlocked,
  loadCatalogBlocks,
  mergeCatalogBlocksIntoFilter,
  setVendorBlock,
  setVendorBrandBlock,
  vendorBrandKey,
} from "./utils/catalogBlocks.js";
import { loadPublicProductFilter, isPubliclyVisible, publicProductFilter } from "./utils/productView.js";
import { evaluatePlatformEligibility } from "./utils/platformEligibility.js";
import { loadEligibilityContext } from "./utils/platformTaxonomy.js";

let memory;

function loc(en) {
  return { en, ar: en, ku: en };
}

function sampleProduct(code, vendorId, brandId) {
  return {
    ibsherId: `cb-${code}`,
    itemCode: code,
    name: loc(code),
    description: loc(code),
    price: 10000,
    isActive: true,
    createdBy: { _id: vendorId, name: vendorId },
    brand: { _id: brandId, name: loc(brandId) },
    category: { _id: "cat-1", name: loc("Cat") },
    subCategory: { _id: "sub-1", name: loc("Sub") },
    collectionName: { _id: "col-1", name: loc("Col") },
  };
}

describe("catalog vendor/brand blocks", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("catalog-blocks"));
    await Partner.create({ slug: "miswag", name: "Miswag", isActive: true });
  });

  after(async () => {
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    await Promise.all([CatalogBlock.deleteMany({}), Product.deleteMany({})]);
  });

  it("blocks an entire vendor and keeps other vendors visible", async () => {
    await Product.insertMany([
      sampleProduct("A1", "vendor-a", "brand-a"),
      sampleProduct("A2", "vendor-a", "brand-b"),
      sampleProduct("B1", "vendor-b", "brand-a"),
    ]);
    await setVendorBlock("vendor-a", false);
    const blocks = await loadCatalogBlocks({ force: true });
    assert.equal(blocks.vendors.has("vendor-a"), true);
    assert.equal(isCatalogBlocked(sampleProduct("A1", "vendor-a", "brand-a"), blocks), true);
    assert.equal(isCatalogBlocked(sampleProduct("B1", "vendor-b", "brand-a"), blocks), false);

    const filter = await loadPublicProductFilter();
    const visible = await Product.find(filter).lean();
    assert.equal(visible.length, 1);
    assert.equal(visible[0].itemCode, "B1");
    assert.equal(isPubliclyVisible(sampleProduct("A2", "vendor-a", "brand-b"), undefined, blocks), false);
  });

  it("blocks selected brands under a vendor without removing the vendor", async () => {
    await Product.insertMany([
      sampleProduct("A1", "vendor-a", "brand-a"),
      sampleProduct("A2", "vendor-a", "brand-b"),
      sampleProduct("A3", "vendor-a", "brand-c"),
    ]);
    await setVendorBrandBlock("vendor-a", "brand-a", false);
    await setVendorBrandBlock("vendor-a", "brand-b", false);

    const blocks = await loadCatalogBlocks({ force: true });
    assert.equal(blocks.vendors.has("vendor-a"), false);
    assert.equal(blocks.vendorBrands.has(vendorBrandKey("vendor-a", "brand-a")), true);
    assert.equal(blocks.vendorBrands.has(vendorBrandKey("vendor-a", "brand-c")), false);

    const filter = mergeCatalogBlocksIntoFilter(publicProductFilter(), blocks);
    const visible = await Product.find(filter).sort({ itemCode: 1 }).lean();
    assert.deepEqual(
      visible.map((row) => row.itemCode),
      ["A3"]
    );
  });

  it("applies global blocks to platform eligibility for every partner", async () => {
    await Product.insertMany([
      sampleProduct("A1", "vendor-a", "brand-a"),
      sampleProduct("A3", "vendor-a", "brand-c"),
    ]);
    await setVendorBrandBlock("vendor-a", "brand-a", false);
    const context = await loadEligibilityContext("miswag");
    const blocked = evaluatePlatformEligibility(sampleProduct("A1", "vendor-a", "brand-a"), context);
    const kept = evaluatePlatformEligibility(sampleProduct("A3", "vendor-a", "brand-c"), context);
    assert.equal(blocked.eligible, false);
    assert.equal(
      blocked.reasons.some((reason) => reason.code === "vendor_brand_inactive"),
      true
    );
    assert.equal(kept.eligible, true);

    await setVendorBlock("vendor-a", false);
    const afterVendor = await loadEligibilityContext("miswag");
    const allGone = evaluatePlatformEligibility(sampleProduct("A3", "vendor-a", "brand-c"), afterVendor);
    assert.equal(allGone.eligible, false);
    assert.equal(allGone.reasons.some((reason) => reason.code === "vendor_inactive"), true);
  });

  it("refuses brand changes while the vendor is fully inactive", async () => {
    await setVendorBlock("vendor-a", false);
    await assert.rejects(
      () => setVendorBrandBlock("vendor-a", "brand-a", false),
      (err) => err.code === "vendor_inactive"
    );
  });
});
