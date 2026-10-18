import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Commission } from "./models/Commission.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { buildCommissionWorkbook } from "./utils/commissionExcel.js";
import { evaluatePlatformEligibility } from "./utils/platformEligibility.js";
import { loadEligibilityContext, saveCategorySetup } from "./utils/platformTaxonomy.js";
import { buildGiniExport, GINI_HEADERS, GINI_SHEET_NAME, GINI_SAFETY_STOCK } from "./utils/platformExcel/gini.js";
import { summarizeDuplicateSkus } from "./utils/platformExcel/duplicateSkus.js";

const PRODUCT_FILE = "C:/Users/Hp/Downloads/Gini_BrownStore_Completed.xlsx";
const GINI_VALUES = {
  categoryName: "الجمال والعناية",
  categoryId: "7",
  subcategoryName: "العناية بالبشرة",
  subcategoryId: "31",
};

let memory;

function product(id, extra = {}) {
  return {
    ibsherId: `gini-${id}`,
    itemCode: id,
    name: { en: `EN ${id}`, ar: `عربي ${id}`, ku: `KU ${id}` },
    description: { ar: `وصف ${id}`, en: `Description ${id}` },
    price: 100000,
    discountPrice: 0,
    isActive: true,
    category: { _id: "cat-1", name: { en: "Electronics" } },
    subCategory: { _id: "sub-1", name: { en: "Mobile Phones" } },
    collectionName: { _id: "col-1", name: { en: "Smartphones" } },
    brand: { _id: "brand-1", name: { en: "Philips" } },
    createdBy: { _id: "vendor-1", name: "Vendor A" },
    ...extra,
    variants: extra.variants || [
      {
        color: extra.color === null ? {} : { en: extra.color || "Black" },
        images: extra.images === null ? [] : [{ url: "/uploads/products/gini-test.webp" }],
        sizes: [{ stockQuantity: extra.stock ?? 4 }],
      },
    ],
  };
}

function sheetRows(workbook) {
  const sheet = workbook.getWorksheet(GINI_SHEET_NAME);
  const headers = sheet.getRow(1).values.slice(1);
  const body = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values.slice(1);
    if (values.some((value) => value != null && value !== "")) {
      body.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
    }
  }
  return { sheet, headers, body };
}

describe("gini platform adapter", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-adapter"));
    await Partner.create([
      { slug: "gini", name: "Gini", isActive: true },
      { slug: "miswag", name: "Miswag", isActive: true },
    ]);
  });

  after(async () => {
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  it("exports eligible Gini rows from manual category ids", async () => {
    await Product.insertMany([
      product("HR7778"),
      product("NO-COLOR", { color: null }),
      product("ZERO", { stock: 0 }),
      product("OTHER", {
        collectionName: { _id: "col-new", name: { en: "New Collection" } },
        brand: { _id: "brand-2", name: { en: "Apple" } },
        price: 5000,
      }),
      product("OFF-CAT", { category: { _id: "cat-off", name: { en: "Fashion" } } }),
      product("OFF-SUB", { subCategory: { _id: "sub-off", name: { en: "Off" } } }),
      product("OFF-COL", { collectionName: { _id: "col-off", name: { en: "Off" } } }),
      product("OFF-BRAND", { brand: { _id: "brand-off", name: { en: "Off" } } }),
      product("OFF-VENDOR", { createdBy: { _id: "vendor-off", name: "Off" } }),
      product("OFF-SELF"),
      product("PARTIAL", { collectionName: { _id: "col-partial", name: { en: "Partial" } } }),
    ]);
    await PlatformTaxonomyConfig.create([
      { partner: "gini", brownCollectionId: "col-1", values: GINI_VALUES },
      { partner: "gini", brownCollectionId: "col-off", values: GINI_VALUES },
      {
        partner: "gini",
        brownCollectionId: "col-partial",
        values: { categoryName: "الجمال والعناية", categoryId: "7", subcategoryName: "", subcategoryId: "" },
      },
      {
        partner: "miswag",
        brownCollectionId: "col-1",
        values: { categoryId: "999", subcategoryId: "999" },
      },
    ]);
    await PlatformVisibilityRule.create([
      { partner: "gini", scope: "category", targetId: "cat-off", isActive: false },
      { partner: "gini", scope: "subcategory", targetId: "sub-off", isActive: false },
      { partner: "gini", scope: "collection", targetId: "col-off", isActive: false },
      { partner: "gini", scope: "brand", targetId: "brand-off", isActive: false },
      { partner: "gini", scope: "vendor", targetId: "vendor-off", isActive: false },
      { partner: "gini", scope: "product", targetId: String((await Product.findOne({ itemCode: "OFF-SELF" }))._id), isActive: false },
    ]);
    await Commission.create({
      partner: "gini",
      scope: "brand",
      targetId: "brand-1",
      percentage: 10,
      isActive: true,
    });

    const partner = await Partner.findOne({ slug: "gini" });
    const rules = await Commission.find({ partner: "gini" });
    const { workbook, report } = await buildGiniExport(partner, rules);
    const { headers, body } = sheetRows(workbook);
    assert.deepEqual(headers, GINI_HEADERS);
    assert.equal(workbook.getWorksheet(GINI_SHEET_NAME).name, GINI_SHEET_NAME);
    const skus = body.map((row) => row[GINI_HEADERS[2]]);
    assert.deepEqual(skus.sort(), ["HR7778", "ZERO"]);
    const ready = body.find((row) => row[GINI_HEADERS[2]] === "HR7778");
    assert.equal(ready[GINI_HEADERS[0]], "| Philips | عربي HR7778 / EN HR7778");
    assert.equal(ready[GINI_HEADERS[1]], "وصف HR7778");
    assert.equal(ready[GINI_HEADERS[3]], 110000);
    assert.equal(ready[GINI_HEADERS[4]], 4);
    assert.equal(ready[GINI_HEADERS[5]], GINI_SAFETY_STOCK);
    assert.equal(ready[GINI_HEADERS[6]], "Black");
    assert.equal(ready[GINI_HEADERS[7]], 7);
    assert.equal(ready[GINI_HEADERS[8]], 31);
    let imageCell = null;
    workbook.getWorksheet(GINI_SHEET_NAME).eachRow((row, rowNumber) => {
      if (rowNumber > 1 && String(row.getCell(3).value) === "HR7778") imageCell = row.getCell(10);
    });
    assert.equal(imageCell.value.text, imageCell.value.hyperlink);
    assert.match(imageCell.value.hyperlink, /\/uploads\/products\/gini-test\.webp$/);
    assert.equal(ready["Image 2"], "");
    const zero = body.find((row) => row[GINI_HEADERS[2]] === "ZERO");
    assert.equal(zero[GINI_HEADERS[4]], 0);
    assert.equal(report.missingRequired >= 1, true);
    assert.equal(report.blockedUnmapped >= 1, true);
    assert.equal(report.blockedInactive >= 5, true);

    const stored = await PlatformTaxonomyConfig.findOne({ partner: "gini", brownCollectionId: "col-1" }).lean();
    assert.equal(stored.values.categoryName, "الجمال والعناية");
    assert.equal(stored.values.subcategoryName, "العناية بالبشرة");
    const miswagValues = await PlatformTaxonomyConfig.findOne({ partner: "miswag", brownCollectionId: "col-1" }).lean();
    assert.equal(miswagValues.values.categoryId, "999");
    assert.notEqual(miswagValues.values.categoryId, stored.values.categoryId);

    const updated = await saveCategorySetup("gini", "col-1", {
      ...GINI_VALUES,
      subcategoryId: "32",
    });
    assert.equal(updated.values.subcategoryId, "32");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "gini", brownCollectionId: "col-1" }), 1);
    const again = sheetRows((await buildGiniExport(partner, rules)).workbook).body;
    const changed = again.find((row) => row[GINI_HEADERS[2]] === "HR7778");
    assert.equal(changed[GINI_HEADERS[7]], 7);
    assert.equal(changed[GINI_HEADERS[8]], 32);
    await saveCategorySetup("gini", "col-1", GINI_VALUES);

    await Product.create(product("PLAIN", {
      brand: { _id: "brand-2", name: { en: "Apple" } },
      price: 5000,
      collectionName: { _id: "col-1", name: { en: "Smartphones" } },
    }));
    const priced = sheetRows((await buildGiniExport(partner, rules)).workbook).body;
    const apple = priced.find((row) => row[GINI_HEADERS[2]] === "PLAIN");
    assert.equal(apple[GINI_HEADERS[3]], 5000);

    const blender = await Product.create(product("BLENDER", {
      price: 7000,
      name: { ar: "خلاط كهربائي", en: "Electric Blender", ku: "خڵات" },
      brand: { _id: "brand-1", name: { en: "Philips" } },
    }));
    await Product.create(product("ZERO-RATE", {
      price: 7001,
      brand: { _id: "brand-2", name: { en: "Apple" } },
      collectionName: { _id: "col-1", name: { en: "Smartphones" } },
    }));
    const roundedRows = sheetRows((await buildGiniExport(partner, rules)).workbook);
    assert.deepEqual(roundedRows.headers, GINI_HEADERS);
    const blenderRow = roundedRows.body.find((row) => row[GINI_HEADERS[2]] === "BLENDER");
    assert.equal(blenderRow[GINI_HEADERS[0]], "| Philips | خلاط كهربائي / Electric Blender");
    assert.equal(blenderRow[GINI_HEADERS[3]], 7750);
    assert.equal((await Product.findById(blender._id).lean()).price, 7000);
    const zeroRate = roundedRows.body.find((row) => row[GINI_HEADERS[2]] === "ZERO-RATE");
    assert.equal(zeroRate[GINI_HEADERS[0]], "| Apple | عربي ZERO-RATE / EN ZERO-RATE");
    assert.equal(zeroRate[GINI_HEADERS[3]], 7250);
    assert.equal((await Product.findOne({ itemCode: "ZERO-RATE" }).lean()).price, 7001);

    const freshCollection = await Product.create(product("FRESH-COL", {
      collectionName: { _id: "col-unmapped", name: { en: "Unmapped" } },
    }));
    const context = await loadEligibilityContext("gini");
    const missing = evaluatePlatformEligibility(freshCollection, context);
    assert.equal(missing.eligible, false);
    assert.equal(missing.reasons.some((reason) => reason.code === "taxonomy_config_missing"), true);
    assert.match(missing.reasons.find((reason) => reason.code === "taxonomy_config_missing").message, /Gini/);
    const partial = evaluatePlatformEligibility(await Product.findOne({ itemCode: "PARTIAL" }), context);
    assert.equal(partial.eligible, false);
    assert.equal(partial.reasons.some((reason) => reason.code === "taxonomy_config_missing"), true);
    for (const code of ["OFF-CAT", "OFF-SUB", "OFF-COL", "OFF-BRAND", "OFF-VENDOR", "OFF-SELF"]) {
      const blocked = evaluatePlatformEligibility(await Product.findOne({ itemCode: code }), context);
      assert.equal(blocked.eligible, false);
      assert.equal(blocked.reasons.some((reason) => reason.code === "taxonomy_config_missing"), false);
    }

    const miswagBook = await buildCommissionWorkbook(await Partner.findOne({ slug: "miswag" }), []);
    assert.equal(miswagBook.workbook.getWorksheet("Excel") != null, true);
    assert.equal(miswagBook.workbook.getWorksheet(GINI_SHEET_NAME), undefined);

    if (fs.existsSync(PRODUCT_FILE)) {
      const real = new ExcelJS.Workbook();
      await real.xlsx.readFile(PRODUCT_FILE);
      const realHeaders = real.worksheets[0].getRow(1).values.slice(1).map((value) => String(value));
      assert.deepEqual(realHeaders, GINI_HEADERS);
      assert.equal(real.worksheets[0].name, GINI_SHEET_NAME);
    }
  });

  it("warns on a shared SKU and still exports both products unchanged", async () => {
    const first = await Product.create(product("DUP-A", {
      itemCode: "SHARED-1",
      ibsherId: "ibs-dup-a",
      price: 10000,
      name: { en: "First serum", ar: "أول", ku: "یەکەم" },
    }));
    const second = await Product.create(product("DUP-B", {
      itemCode: "SHARED-1",
      ibsherId: "ibs-dup-b",
      price: 20000,
      brand: { _id: "brand-2", name: { en: "Apple" } },
      name: { en: "Second serum", ar: "ثان", ku: "دووەم" },
    }));
    const unique = await Product.create(product("DUP-UNIQUE", {
      itemCode: "UNIQUE-1",
      price: 30000,
      name: { en: "Unique phone", ar: "فريد", ku: "تاقانە" },
    }));
    await Product.create(product("DUP-BLOCKED", {
      itemCode: "SHARED-1",
      ibsherId: "ibs-dup-blocked",
      collectionName: { _id: "col-unmapped-dup", name: { en: "Unmapped" } },
      name: { en: "Blocked twin", ar: "محجوب", ku: "بلۆک" },
    }));

    const partner = await Partner.findOne({ slug: "gini" });
    const rules = await Commission.find({ partner: "gini" });
    const { workbook, report } = await buildGiniExport(partner, rules);
    const sharedRows = [];
    const uniqueRows = [];
    const sheet = workbook.getWorksheet(GINI_SHEET_NAME);
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const sku = String(row.getCell(3).value || "");
      if (sku === "SHARED-1") sharedRows.push(sku);
      if (sku === "UNIQUE-1") uniqueRows.push(sku);
    });
    assert.deepEqual(sharedRows, ["SHARED-1", "SHARED-1"]);
    assert.deepEqual(uniqueRows, ["UNIQUE-1"]);

    const warning = report.duplicateSkus;
    const group = warning.duplicates.find((item) => item.sku === "SHARED-1");
    assert.ok(group);
    assert.equal(group.rows, 2);
    assert.equal(warning.duplicateSkuValues >= 1, true);
    assert.equal(warning.extraDuplicateRows >= 1, true);
    assert.equal(warning.uniqueSkus < warning.exportRows, true);
    const ids = group.products.map((item) => item.productId).sort();
    assert.deepEqual(ids, [String(first._id), String(second._id)].sort());
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(
      group.products.map((item) => item.sellingPrice).sort((a, b) => a - b),
      [10000, 20000]
    );
    assert.equal(group.products.some((item) => item.ibsherId === "ibs-dup-blocked"), false);
    assert.equal(warning.duplicates.some((item) => item.sku === "UNIQUE-1"), false);

    const stored = await Product.find({ itemCode: "SHARED-1" }).select("itemCode").lean();
    assert.equal(stored.length, 3);
    assert.equal(stored.every((item) => item.itemCode === "SHARED-1"), true);
    assert.equal(unique.itemCode, "UNIQUE-1");
  });
});

describe("duplicate sku summary", () => {
  it("counts shared SKUs without merging product ids", () => {
    const summary = summarizeDuplicateSkus([
      { sku: "SHARED-1", productId: "a", ibsherId: "ia", name: "First", brand: "Philips", collection: "Smartphones", sellingPrice: 10000 },
      { sku: "UNIQUE-1", productId: "b", ibsherId: "ib", name: "Unique", brand: "Philips", collection: "Smartphones", sellingPrice: 30000 },
      { sku: "SHARED-1", productId: "c", ibsherId: "ic", name: "Second", brand: "Apple", collection: "Smartphones", sellingPrice: 20000 },
    ]);
    assert.equal(summary.exportRows, 3);
    assert.equal(summary.uniqueSkus, 2);
    assert.equal(summary.duplicateSkuValues, 1);
    assert.equal(summary.extraDuplicateRows, 1);
    assert.equal(summary.duplicates[0].sku, "SHARED-1");
    assert.deepEqual(summary.duplicates[0].products.map((item) => item.productId), ["a", "c"]);
    assert.equal(summary.duplicates.some((item) => item.sku === "UNIQUE-1"), false);
  });
});
