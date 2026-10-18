import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MiswagVariationBarcode } from "./models/MiswagVariationBarcode.js";
import { Product } from "./models/Product.js";
import {
  ensureMiswagVariationBarcode,
  ensureProductVariationBarcodes,
  formatMiswagVariationBarcode,
  isGeneratedMiswagBarcode,
  loadMiswagVariationBarcodes,
} from "./services/miswagTestBarcodes.js";
import { buildMiswagTestPayload, miswagVariationExternalId } from "./services/miswagTestProduct.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;

function productDoc(overrides = {}) {
  return {
    ibsherId: "ibs-barcode-1",
    itemCode: "SKU-BC-1",
    name: { en: "Barcode Sample", ar: "عينة باركود كافية", ku: "نموونە" },
    description: { en: "desc", ar: "وصف عربي كافٍ للمنتج", ku: "وەسف" },
    price: 1000,
    discountPrice: 0,
    isActive: true,
    keyword: ["sample", "barcode"],
    brand: { _id: "brand-1", name: { en: "Philips" } },
    category: { _id: "cat-1", name: { en: "Home" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen" } },
    collectionName: { _id: "col-1", name: { en: "Blenders" } },
    variants: [
      {
        _id: "var-a",
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/a.jpg", isMain: true }],
        sizes: [
          { _id: "size-1", size: "S", stockQuantity: 2 },
          { _id: "size-2", size: "M", stockQuantity: 3 },
        ],
      },
      {
        _id: "var-b",
        color: { name: { en: "White" }, hex: "#FFFFFF" },
        images: [{ url: "/media/b.jpg", isMain: true }],
        sizes: [{ _id: "size-3", size: "One", stockQuantity: 1 }],
      },
    ],
    ...overrides,
  };
}

describe("Miswag Sync 1 variation barcodes", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
  });

  after(async () => {
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    await MiswagVariationBarcode.deleteMany({});
    await Product.deleteMany({});
  });

  it("uses BS + 12 digits format previously accepted by Miswag", () => {
    const barcode = formatMiswagVariationBarcode("123456");
    assert.equal(barcode, "BS000000123456");
    assert.equal(isGeneratedMiswagBarcode(barcode), true);
    assert.equal(isGeneratedMiswagBarcode("6291041500213"), false);
  });

  it("preserves an existing variation barcode", async () => {
    const doc = await Product.create(
      productDoc({
        variants: [
          {
            _id: "var-explicit",
            barcode: "6291041500213",
            color: { name: { en: "Black" }, hex: "#000000" },
            images: [{ url: "/media/a.jpg", isMain: true }],
            sizes: [{ _id: "size-1", size: "One", stockQuantity: 1 }],
          },
        ],
      })
    );
    const result = await ensureMiswagVariationBarcode({
      ibsherId: doc.ibsherId,
      variant: doc.variants[0],
    });
    assert.equal(result.barcode, "6291041500213");
    assert.equal(result.source, "explicit");
    assert.equal(result.created, true);

    const again = await ensureMiswagVariationBarcode({
      ibsherId: doc.ibsherId,
      variant: doc.variants[0],
    });
    assert.equal(again.barcode, "6291041500213");
    assert.equal(again.created, false);
    assert.equal(await MiswagVariationBarcode.countDocuments({}), 1);
  });

  it("generates a barcode when missing and persists it", async () => {
    const doc = await Product.create(productDoc());
    const first = await ensureMiswagVariationBarcode({
      ibsherId: doc.ibsherId,
      variant: doc.variants[0],
    });
    assert.equal(isGeneratedMiswagBarcode(first.barcode), true);
    assert.equal(first.source, "generated");
    assert.equal(first.created, true);

    const second = await ensureMiswagVariationBarcode({
      ibsherId: doc.ibsherId,
      variant: doc.variants[0],
    });
    assert.equal(second.barcode, first.barcode);
    assert.equal(second.created, false);
    assert.equal(await MiswagVariationBarcode.countDocuments({}), 1);
  });

  it("gives the same variation the same barcode later", async () => {
    const doc = await Product.create(productDoc());
    const a = await ensureProductVariationBarcodes(doc);
    const b = await ensureProductVariationBarcodes(doc);
    const ext = miswagVariationExternalId(doc.variants[0]);
    assert.equal(a.get(ext).barcode, b.get(ext).barcode);
  });

  it("gives different variations different barcodes", async () => {
    const doc = await Product.create(productDoc());
    const map = await ensureProductVariationBarcodes(doc);
    const a = map.get(miswagVariationExternalId(doc.variants[0])).barcode;
    const b = map.get(miswagVariationExternalId(doc.variants[1])).barcode;
    assert.notEqual(a, b);
    assert.equal(await MiswagVariationBarcode.countDocuments({}), 2);
  });

  it("does not create extra barcodes per size", async () => {
    const doc = await Product.create(productDoc());
    await ensureProductVariationBarcodes(doc);
    // Two variations, first has two sizes — still only two barcodes.
    assert.equal(doc.variants[0].sizes.length, 2);
    assert.equal(await MiswagVariationBarcode.countDocuments({}), 2);
  });

  it("preview payload uses generated barcode and no longer reports missing barcode", async () => {
    process.env.MEDIA_PUBLIC_ORIGIN = "https://api.brownstore.test";
    const doc = await Product.create(productDoc());
    const assignments = await ensureProductVariationBarcodes(doc);
    const built = buildMiswagTestPayload(doc, {
      categoryId: "L4-1",
      brandId: "42",
      barcodeAssignments: assignments,
    });
    assert.equal(built.errors.includes("missing_variation_barcode"), false);
    assert.equal(built.product.variants[0].barcodeSource, "generated");
    assert.equal(built.product.variants[0].barcodeLabel, "Auto-generated");
    assert.equal(isGeneratedMiswagBarcode(built.product.variants[0].barcode), true);
    assert.equal(built.payload.variations[0].barcode, built.product.variants[0].barcode);
    assert.equal("barcodeSource" in built.payload.variations[0], false);
  });

  it("does not restore the old Miswag barcode service module", () => {
    assert.equal(fs.existsSync(path.join(__dirname, "services/miswagBarcodes.js")), false);
    // New focused helper exists instead.
    assert.equal(fs.existsSync(path.join(__dirname, "services/miswagTestBarcodes.js")), true);
  });

  it("loadMiswagVariationBarcodes returns persisted rows", async () => {
    const doc = await Product.create(productDoc());
    await ensureProductVariationBarcodes(doc);
    const loaded = await loadMiswagVariationBarcodes(doc);
    assert.equal(loaded.size, 2);
  });
});
