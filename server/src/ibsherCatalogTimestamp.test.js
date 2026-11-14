import assert from "node:assert/strict";
import fs from "fs";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Product } from "./models/Product.js";
import { mapIbsherProduct } from "./services/ibsher.js";
import { productSyncTouchesContent, upsertProducts } from "./routes/admin.js";

const SOURCE_ITEM = "6adf9824ef43bcf3ec7d1ee4";

function remoteItem(extra = {}) {
  return {
    _id: SOURCE_ITEM,
    itemCode: "38104",
    name: { en: "Case", ar: "", ku: "" },
    description: { en: "", ar: "", ku: "" },
    price: 1000,
    discountPrice: 0,
    status: "published",
    isActive: true,
    createdBy: { _id: "it-lobby", name: "IT Lobby" },
    variants: [{
      _id: "color-black",
      color: { en: "Black" },
      sku: "38104-BLK",
      images: [],
      sizes: [{ _id: "size-one", size: "One", sku: "38104-BLK", stockQuantity: 7 }],
    }],
    updatedAt: "2026-11-13T17:25:05.946Z",
    ...extra,
  };
}

before(async () => {
  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  globalThis.__catalogMemory = memory;
});

after(async () => {
  await mongoose.disconnect();
  await globalThis.__catalogMemory.stop();
});

test("an unchanged catalog row refreshes lastSyncedAt and keeps updatedAt", async () => {
  const firstSync = new Date("2026-11-13T17:25:05.946Z");
  const inserted = await upsertProducts([remoteItem()], firstSync);
  assert.equal(inserted.inserted, 1);
  assert.equal(inserted.updated, 0);
  const stored = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondSync = new Date("2026-11-13T20:00:32.798Z");
  const refreshed = await upsertProducts([remoteItem()], secondSync);
  const after = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  assert.equal(refreshed.updated, 0);
  assert.equal(refreshed.refreshed, 1);
  assert.equal(refreshed.inserted, 0);
  assert.equal(after.updatedAt.toISOString(), stored.updatedAt.toISOString());
  assert.equal(after.lastSyncedAt.toISOString(), secondSync.toISOString());
  assert.equal(after.itemCode, "38104");
  assert.equal(after.createdBy.name, "IT Lobby");
  assert.equal(after.variants[0].color.en, "Black");
  assert.equal(after.variants[0].sku, "38104-BLK");
  assert.equal(after.variants[0].sizes[0].stockQuantity, 7);
  assert.equal(productSyncTouchesContent(stored, { ...stored, lastSyncedAt: secondSync }), false);
});

test("a real stock, color, vendor, or source-time change still moves updatedAt", async () => {
  const base = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  const stock = remoteItem();
  stock.variants[0].sizes[0].stockQuantity = 8;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stockWrite = await upsertProducts([stock], new Date("2026-11-13T20:05:00.000Z"));
  const stockAfter = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  assert.equal(stockWrite.updated, 1);
  assert.equal(stockWrite.refreshed, 0);
  assert.notEqual(stockAfter.updatedAt.toISOString(), base.updatedAt.toISOString());
  assert.equal(stockAfter.variants[0].sizes[0].stockQuantity, 8);

  const color = remoteItem();
  color.variants[0].color.en = "Blue";
  color.variants[0].sizes[0].stockQuantity = 8;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeColor = stockAfter.updatedAt;
  await upsertProducts([color], new Date("2026-11-13T20:06:00.000Z"));
  const colorAfter = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  assert.notEqual(colorAfter.updatedAt.toISOString(), beforeColor.toISOString());
  assert.equal(colorAfter.variants[0].color.en, "Blue");

  const vendor = remoteItem();
  vendor.createdBy = { _id: "jawal-flex", name: "Jawal Flex" };
  vendor.variants[0].color.en = "Blue";
  vendor.variants[0].sizes[0].stockQuantity = 8;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeVendor = colorAfter.updatedAt;
  await upsertProducts([vendor], new Date("2026-11-13T20:07:00.000Z"));
  const vendorAfter = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  assert.notEqual(vendorAfter.updatedAt.toISOString(), beforeVendor.toISOString());
  assert.equal(vendorAfter.createdBy.name, "Jawal Flex");

  const sourceTime = remoteItem();
  sourceTime.createdBy = { _id: "jawal-flex", name: "Jawal Flex" };
  sourceTime.variants[0].color.en = "Blue";
  sourceTime.variants[0].sizes[0].stockQuantity = 8;
  sourceTime.updatedAt = "2026-11-13T20:08:00.000Z";
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeSource = vendorAfter.updatedAt;
  const sourceWrite = await upsertProducts([sourceTime], new Date("2026-11-13T20:08:00.000Z"));
  const sourceAfter = await Product.findOne({ ibsherId: SOURCE_ITEM }).lean();
  assert.equal(sourceWrite.updated, 1);
  assert.notEqual(sourceAfter.updatedAt.toISOString(), beforeSource.toISOString());
  assert.equal(sourceAfter.sourceUpdatedAt.toISOString(), "2026-11-13T20:08:00.000Z");
});

test("price, stock, variants, vendor, source identity, and sourceUpdatedAt are content changes", () => {
  const mapped = mapIbsherProduct(remoteItem());
  assert.equal(productSyncTouchesContent(mapped, { ...mapped, lastSyncedAt: new Date() }), false);
  const expectChange = (patch) => assert.equal(productSyncTouchesContent(mapped, { ...mapped, ...patch }), true);
  expectChange({ price: mapped.price + 1 });
  expectChange({
    variants: [{
      ...mapped.variants[0],
      sizes: [{ ...mapped.variants[0].sizes[0], stockQuantity: 1 }],
    }],
  });
  expectChange({
    variants: [{ ...mapped.variants[0], color: { en: "Green" } }],
  });
  expectChange({ createdBy: { _id: "other-vendor", name: "Other" } });
  expectChange({ ibsherId: "different-source-item" });
  expectChange({ sourceUpdatedAt: new Date("2026-11-13T21:00:00.000Z") });
  expectChange({ itemCode: "38105" });
  expectChange({ name: { en: "Renamed", ar: "", ku: "" } });
  expectChange({ description: { en: "Changed", ar: "", ku: "" } });
  expectChange({ discountPrice: 50 });
  expectChange({ ibsherDiscountPrice: 50 });
  expectChange({ category: { _id: "cat" } });
  expectChange({ subCategory: { _id: "sub" } });
  expectChange({ collectionName: { _id: "col" } });
  expectChange({ brand: { _id: "brand" } });
  expectChange({ status: "draft" });
  expectChange({ warranty: { en: "1 year" } });
  expectChange({ keyword: ["case"] });
  expectChange({ is_featured: true });
  expectChange({ is_new_arrival: true });
  expectChange({ is_hot: true });
  expectChange({ is_best_seller: true });
  expectChange({ badge: "New" });
  expectChange({ isActive: false });
  expectChange({ rating: 4 });
  expectChange({ points: 3 });
  expectChange({ cashback: 2 });
});

test("manual BrownStore overrides survive a refresh and a real catalog change", async () => {
  const item = remoteItem({ _id: "manual-source" });
  await upsertProducts([item], new Date("2026-11-13T18:00:00.000Z"));
  await Product.updateOne({ ibsherId: "manual-source" }, {
    $set: {
      "overrides.price": 1500,
      "overrides.sku": "LOCAL-SKU",
      "overrides.outOfStock": true,
      "overrides.name": { en: "Shop title" },
    },
  });
  const before = await Product.findOne({ ibsherId: "manual-source" }).lean();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refreshed = await upsertProducts([item], new Date("2026-11-13T18:05:00.000Z"));
  const afterRefresh = await Product.findOne({ ibsherId: "manual-source" }).lean();
  assert.equal(refreshed.refreshed, 1);
  assert.equal(refreshed.updated, 0);
  assert.equal(afterRefresh.updatedAt.toISOString(), before.updatedAt.toISOString());
  assert.equal(afterRefresh.overrides.price, 1500);
  assert.equal(afterRefresh.overrides.sku, "LOCAL-SKU");
  assert.equal(afterRefresh.overrides.outOfStock, true);
  assert.equal(afterRefresh.overrides.name.en, "Shop title");
  assert.equal(afterRefresh.price, 1000);

  const changed = remoteItem({ _id: "manual-source", price: 1800 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const written = await upsertProducts([changed], new Date("2026-11-13T18:10:00.000Z"));
  const afterChange = await Product.findOne({ ibsherId: "manual-source" }).lean();
  assert.equal(written.updated, 1);
  assert.equal(afterChange.price, 1800);
  assert.notEqual(afterChange.updatedAt.toISOString(), afterRefresh.updatedAt.toISOString());
  assert.equal(afterChange.overrides.price, 1500);
  assert.equal(afterChange.overrides.sku, "LOCAL-SKU");
  assert.equal(afterChange.overrides.outOfStock, true);
  assert.equal(afterChange.overrides.name.en, "Shop title");
});

test("one bulk write can insert, refresh, and update separate products", async () => {
  const unchanged = remoteItem({ _id: "batch-same" });
  const changing = remoteItem({ _id: "batch-change", price: 1100 });
  await upsertProducts([unchanged, changing], new Date("2026-11-13T19:00:00.000Z"));
  const beforeSame = await Product.findOne({ ibsherId: "batch-same" }).lean();
  const beforeChange = await Product.findOne({ ibsherId: "batch-change" }).lean();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await upsertProducts([
    unchanged,
    remoteItem({ _id: "batch-change", price: 1200 }),
    remoteItem({ _id: "batch-new", itemCode: "38106" }),
  ], new Date("2026-11-13T19:05:00.000Z"));
  const afterSame = await Product.findOne({ ibsherId: "batch-same" }).lean();
  const afterChange = await Product.findOne({ ibsherId: "batch-change" }).lean();
  const created = await Product.findOne({ ibsherId: "batch-new" }).lean();
  assert.equal(result.refreshed, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);
  assert.equal(afterSame.updatedAt.toISOString(), beforeSame.updatedAt.toISOString());
  assert.equal(afterSame.lastSyncedAt.toISOString(), "2026-11-13T19:05:00.000Z");
  assert.equal(afterChange.price, 1200);
  assert.notEqual(afterChange.updatedAt.toISOString(), beforeChange.updatedAt.toISOString());
  assert.equal(created.itemCode, "38106");
  assert.ok(created.createdAt);
  assert.ok(created.updatedAt);
});

test("stale deletion is quarantined and runs only after a complete catalog sync", () => {
  const admin = fs.readFileSync(new URL("./routes/admin.js", import.meta.url), "utf8");
  const guard = fs.readFileSync(new URL("./utils/catalogStaleGuard.js", import.meta.url), "utf8");
  const incomplete = admin.indexOf("if (incomplete)");
  const deletion = admin.indexOf("applyCatalogAbsence", incomplete);
  assert.ok(incomplete > 0);
  assert.ok(deletion > incomplete);
  assert.equal(admin.includes("Product.deleteMany"), false);
  assert.equal(admin.includes("Category.deleteMany"), false);
  assert.equal(admin.includes("approveCategoryDeletions"), false);
  assert.match(admin, /Incomplete catalog sync:/);
  assert.match(admin, /Stale products were kept/);
  assert.match(admin, /removed: 0/);
  assert.match(guard, /CATALOG_DELETE_CONFIRMATIONS = 3/);
  assert.match(guard, /mode: "shrink_hold"/);
  assert.match(guard, /mode: "outage"/);
});

test("a refreshed product stays newer than the stale-catalog deletion cutoff", async () => {
  const syncedAt = new Date("2026-11-13T20:09:00.000Z");
  await Product.create({
    ibsherId: "left-behind",
    itemCode: "OLD",
    name: { en: "Old" },
    lastSyncedAt: new Date("2026-11-13T17:25:05.946Z"),
  });
  const kept = remoteItem();
  kept.createdBy = { _id: "jawal-flex", name: "Jawal Flex" };
  kept.variants[0].color.en = "Blue";
  kept.variants[0].sizes[0].stockQuantity = 8;
  kept.updatedAt = "2026-11-13T20:08:00.000Z";
  await upsertProducts([kept], syncedAt);
  const removed = await Product.deleteMany({
    ibsherId: { $in: [SOURCE_ITEM, "left-behind"] },
    $or: [{ lastSyncedAt: { $lt: syncedAt } }, { lastSyncedAt: { $exists: false } }],
  });
  assert.equal(removed.deletedCount, 1);
  assert.equal(await Product.countDocuments({ ibsherId: SOURCE_ITEM }), 1);
  assert.equal(await Product.countDocuments({ ibsherId: "left-behind" }), 0);
});
