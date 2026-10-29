import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { upsertProducts } from "./routes/admin.js";
import { Commission } from "./models/Commission.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { Product } from "./models/Product.js";
import { mapIbsherProduct } from "./services/ibsher.js";
import { buildMiswagTestPayload } from "./services/miswagTestProduct.js";
import { applyCommissionRate } from "./utils/commission.js";
import { buildCommissionWorkbook } from "./utils/commissionExcel.js";
import { buildElryanProductPayload } from "./utils/elryanPayloadBuilder.js";
import { buildElryanPricingView } from "./utils/elryanPricing.js";
import { validateElryanPreviewParts } from "./utils/elryanValidator.js";
import { assessSimpleProduct } from "./utils/giniSyncOnePlan.js";
import { brownStoreSellingPriceExpr, resolveBrownStorePrice } from "./utils/ibsherPrice.js";
import { partnerPricePreview, toPartnerProduct } from "./utils/partnerCatalog.js";
import { buildGiniExport, GINI_HEADERS, GINI_SHEET_NAME } from "./utils/platformExcel/gini.js";
import { toAdminProduct, toResolvedProduct } from "./utils/productView.js";

const VENDOR = "vendor-hfp";
const RULES = [
  { scope: "all", targetId: "*", percentage: 5, isActive: true },
  { scope: "vendor", targetId: VENDOR, percentage: 10, isActive: true },
];

function hfp(extra = {}) {
  return {
    _id: extra._id || "hfp-legacy",
    ibsherId: extra.ibsherId || "hfp-legacy",
    itemCode: "HFP90.000BK",
    name: { en: "Fan", ar: "مروحة", ku: "پەنکە" },
    description: { en: "Fan", ar: "مروحة تبريد", ku: "پەنکە" },
    price: 333000,
    discountPrice: 273000,
    isActive: true,
    createdBy: { _id: VENDOR, name: "Vendor" },
    brand: { _id: "brand-hfp", name: { en: "Brown" } },
    category: { _id: "cat-hfp", name: { en: "Home" } },
    subCategory: { _id: "sub-hfp", name: { en: "Cooling" } },
    collectionName: { _id: "col-hfp", name: { en: "Fans" } },
    variants: [
      {
        _id: "var-hfp",
        color: { en: "Black" },
        images: [{ url: "/uploads/products/hfp.webp", isMain: true }],
        sizes: [{ _id: "size-hfp", size: "M", stockQuantity: 4, price: 333000, discountPrice: 273000 }],
      },
    ],
    ...extra,
  };
}

function sheetRows(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? ""));
  const body = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values.slice(1);
    if (!values.some((value) => value != null && value !== "")) continue;
    body.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  return body;
}

describe("IBSHER regular price", () => {
  it("prices HFP90.000BK from 333,000 IQD and ignores the 273,000 IQD promotion", async () => {
    const product = hfp();
    const snapshot = structuredClone(product);
    const resolved = toResolvedProduct(product);
    const preview = partnerPricePreview(product, RULES);
    const partner = toPartnerProduct(product, RULES, "http://localhost");
    const miswag = buildMiswagTestPayload(product, { rules: RULES, categoryId: "L3-1", brandId: 9 });
    const elryan = await buildElryanPricingView(product, { commissionRules: RULES });
    const elryanPayload = buildElryanProductPayload({
      resolved,
      sku: "HFP90.000BK",
      pricing: elryan,
      quantity: 4,
    });

    assert.deepEqual(product, snapshot);
    assert.equal(resolved.sellingPrice, 333000);
    assert.equal(resolved.price, 333000);
    assert.equal(resolved.discountPrice, 0);
    assert.equal(resolved.priceReview, false);
    assert.equal(resolved.variants[0].sizes[0].stockQuantity, 4);
    assert.equal(resolved.variants[0].sizes[0].discountPrice, 273000);
    assert.equal(preview.storePrice, 333000);
    assert.equal(preview.rate, 10);
    assert.equal(preview.rawPrice, 366300);
    assert.equal(preview.price, 366500);
    assert.equal(partner.price, 366500);
    assert.equal(miswag.payload.price, 366500);
    assert.equal(miswag.pricing.storePrice, 333000);
    assert.equal(miswag.errors.includes("price_needs_review"), false);
    assert.equal(elryan.storeSellingPrice, 333000);
    assert.equal(elryan.rawPrice, 366300);
    assert.equal(elryan.platformPrice, 366500);
    assert.equal(elryan.proposedElryanPrice, 366500);
    assert.equal(elryan.proposedElryanCost, null);
    assert.equal(elryanPayload.price, 366500);
    assert.equal(applyCommissionRate(333000, 10), 366500);
    assert.equal(product.discountPrice, 273000);
  });

  it("keeps an undiscounted regular price and the existing rounding rule", () => {
    const product = hfp({ _id: "plain", ibsherId: "plain", itemCode: "PLAIN-7000", price: 7000, discountPrice: 0 });
    const preview = partnerPricePreview(product, RULES);
    assert.equal(preview.storePrice, 7000);
    assert.equal(preview.rawPrice, 7700);
    assert.equal(preview.price, 7750);
    assert.equal(preview.rate, 10);
  });

  it("keeps an independent manual price and an independent manual discount", () => {
    const manualPrice = hfp({
      overrides: { price: 400000, discountPrice: null },
    });
    const priced = partnerPricePreview(manualPrice, RULES);
    assert.equal(priced.storePrice, 400000);
    assert.equal(priced.rawPrice, 440000);
    assert.equal(priced.price, 440000);

    const manualDiscount = hfp({
      overrides: { discountPrice: 300000 },
    });
    const discounted = partnerPricePreview(manualDiscount, RULES);
    assert.equal(discounted.storePrice, 300000);
    assert.equal(discounted.rawPrice, 330000);
    assert.equal(discounted.price, 330000);
    assert.equal(toResolvedProduct(manualDiscount).discountPrice, 300000);
  });

  it("ignores a manual discount that only repeats the imported IBSHER promotion", () => {
    const product = hfp({ overrides: { price: 350000, discountPrice: 273000 } });
    const resolved = toResolvedProduct(product);
    assert.equal(resolved.sellingPrice, 350000);
    assert.equal(resolved.discountPrice, 0);
    assert.equal(partnerPricePreview(hfp({ overrides: { discountPrice: 273000 } }), RULES).storePrice, 333000);
  });

  it("flags a missing or ambiguous regular price and does not use the promotion", async () => {
    const missing = hfp({ price: null });
    const ambiguous = hfp({ price: "333,000" });
    const missingPreview = partnerPricePreview(missing, RULES);
    const ambiguousResolved = resolveBrownStorePrice(ambiguous);
    const miswag = buildMiswagTestPayload(missing, { rules: RULES, categoryId: "L3-1", brandId: 9 });
    const elryan = await buildElryanPricingView(missing, { commissionRules: RULES });
    const validation = validateElryanPreviewParts({
      hasApiKey: true,
      sku: "HFP90.000BK",
      pricing: elryan,
      variation: { ok: true, reasons: [] },
      images: ["https://cdn.example/hfp.webp"],
    });

    assert.equal(toResolvedProduct(missing).sellingPrice, null);
    assert.equal(toResolvedProduct(missing).priceReview, true);
    assert.equal(toResolvedProduct(missing).priceReviewReason, "missing_regular_price");
    assert.equal(missingPreview.price, null);
    assert.equal(missingPreview.storePrice, null);
    assert.equal(missingPreview.priceReview, true);
    assert.equal(miswag.payload.price, undefined);
    assert.equal(miswag.errors.includes("price_needs_review"), true);
    assert.equal(elryan.proposedElryanPrice, null);
    assert.equal(elryan.platformPrice, null);
    assert.equal(validation.blockers.some((item) => item.code === "price_needs_review"), true);
    assert.equal(ambiguousResolved.priceReview, true);
    assert.equal(ambiguousResolved.priceReviewReason, "ambiguous_regular_price");
    assert.equal(ambiguousResolved.sellingPrice, null);
    assert.equal(resolveBrownStorePrice({ _id: "text", price: "333000", discountPrice: 273000 }).sellingPrice, 333000);
  });

  it("does not let a variant promotion change GINI's simple-product check", () => {
    const simple = assessSimpleProduct({
      itemCode: "HFP90.000BK",
      sellingPrice: 333000,
      variants: hfp().variants,
    });
    assert.equal(simple.simple, true);
    const ownPrice = assessSimpleProduct({
      itemCode: "HFP90.000BK",
      sellingPrice: 333000,
      variants: [{ color: { en: "Black" }, price: 200000, sizes: [{ size: "M", stockQuantity: 1 }] }],
    });
    assert.equal(ownPrice.simple, false);
  });

  it("maps a future IBSHER payload without copying the promotion into the selling price", () => {
    const remote = {
      _id: "hfp-remote",
      itemCode: "HFP90.000BK",
      price: 333000,
      discountPrice: 273000,
      name: { en: "Fan" },
      brand: { _id: "brand-hfp", name: { en: "Brown" } },
      category: { _id: "cat-hfp", name: { en: "Home" } },
      variants: hfp().variants,
    };
    const snapshot = structuredClone(remote);
    const mapped = mapIbsherProduct(remote);
    mapped._id = "hfp-remote";
    const resolved = toResolvedProduct(mapped);

    assert.deepEqual(remote, snapshot);
    assert.equal(mapped.price, 333000);
    assert.equal(mapped.discountPrice, 0);
    assert.equal(mapped.ibsherDiscountPrice, 273000);
    assert.equal(mapped.variants, remote.variants);
    assert.equal(mapped.brand, remote.brand);
    assert.equal(mapped.category, remote.category);
    assert.equal(resolved.sellingPrice, 333000);
    assert.equal(resolved.discountPrice, 0);
  });
});

describe("stored IBSHER discounts", { concurrency: 1 }, () => {
  let memory;

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("ibsher-regular-price"));
    await Partner.create([
      { slug: "miswag", name: "Miswag", isActive: true },
      { slug: "gini", name: "Gini", isActive: true },
      { slug: "elryan", name: "Elryan", isActive: true },
    ]);
    await Commission.create(
      ["miswag", "gini", "elryan"].flatMap((partner) => [
        { partner, scope: "all", targetId: "*", percentage: 5, isActive: true },
        { partner, scope: "vendor", targetId: VENDOR, percentage: 10, isActive: true },
      ])
    );
    await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "col-hfp",
      values: { categoryId: "7", categoryName: "Home", subcategoryId: "31", subcategoryName: "Fans" },
    });
    const rows = [
      hfp(),
      hfp({
        ibsherId: "plain",
        itemCode: "PLAIN-7000",
        price: 7000,
        discountPrice: 0,
      }),
      hfp({
        ibsherId: "manual",
        itemCode: "MANUAL-300",
        overrides: { discountPrice: 300000, sku: "MANUAL-SKU" },
      }),
      hfp({
        ibsherId: "echo",
        itemCode: "ECHO-273",
        overrides: { discountPrice: 273000, price: 350000, sku: "ECHO-SKU" },
      }),
      hfp({
        ibsherId: "low",
        itemCode: "LOW-200",
        price: 200000,
        discountPrice: 150000,
      }),
      hfp({
        ibsherId: "missing",
        itemCode: "MISSING-PRICE",
        price: 0,
        discountPrice: 273000,
      }),
    ];
    await Product.create(rows.map((row) => {
      const doc = { ...row };
      delete doc._id;
      return doc;
    }));
  });

  after(async () => {
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  it("resolves stored promotions to the regular price without rewriting those rows", async () => {
    const before = await Product.findOne({ itemCode: "HFP90.000BK" }).lean();
    const admin = toAdminProduct(before);
    assert.equal(admin.sellingPrice, 333000);
    assert.equal(admin.discountPrice, 0);
    assert.equal(admin.priceReview, false);
    assert.equal(admin.source.discountPrice, 273000);
    assert.equal(before.discountPrice, 273000);
    assert.equal(before.price, 333000);

    const after = await Product.findOne({ itemCode: "HFP90.000BK" }).lean();
    assert.equal(after.discountPrice, before.discountPrice);
    assert.equal(after.price, before.price);
    assert.equal(after.variants[0].sizes[0].stockQuantity, 4);
  });

  it("filters admin prices by the regular price", async () => {
    const listed = await Product.find({
      $expr: {
        $and: [
          { $gte: [brownStoreSellingPriceExpr(), 300000] },
          { $lte: [brownStoreSellingPriceExpr(), 400000] },
        ],
      },
    }).select("itemCode");
    assert.deepEqual(
      listed.map((item) => item.itemCode).sort(),
      ["ECHO-273", "HFP90.000BK", "MANUAL-300"]
    );

    const promoted = await Product.findOne({
      itemCode: "LOW-200",
      $expr: { $eq: [brownStoreSellingPriceExpr(), 200000] },
    }).lean();
    const hiddenDiscount = await Product.findOne({
      itemCode: "LOW-200",
      $expr: { $lte: [brownStoreSellingPriceExpr(), 180000] },
    }).lean();
    const missing = await Product.findOne({
      itemCode: "MISSING-PRICE",
      $expr: { $gte: [brownStoreSellingPriceExpr(), 1] },
    }).lean();
    assert.ok(promoted);
    assert.equal(hiddenDiscount, null);
    assert.equal(missing, null);
    assert.equal(toResolvedProduct(await Product.findOne({ itemCode: "MISSING-PRICE" }).lean()).priceReview, true);
  });

  it("exports marketplace prices from the regular price", async () => {
    const rules = await Commission.find({ partner: "miswag", isActive: { $ne: false } });
    const { workbook } = await buildCommissionWorkbook(await Partner.findOne({ slug: "miswag" }), rules);
    const rows = sheetRows(workbook, "Excel");
    const row = (sku) => rows.find((item) => String(item.SKU) === sku);
    assert.equal(Number(row("HFP90.000BK").Price), 366500);
    assert.equal(Number(row("HFP90.000BK")["Discount price"]), 0);
    assert.equal(Number(row("HFP90.000BK")["Platform price"]), 366500);
    assert.equal(Number(row("HFP90.000BK")["Commission %"]), 10);
    assert.equal(Number(row("PLAIN-7000").Price), 7750);
    assert.equal(Number(row("MANUAL-SKU").Price), 330000);
    assert.equal(Number(row("MANUAL-SKU")["Discount price"]), 330000);
    assert.equal(Number(row("ECHO-SKU").Price), 385000);
    assert.equal(Number(row("ECHO-SKU")["Discount price"]), 0);
    assert.equal(row("MISSING-PRICE").Price, "");
    assert.equal(row("MISSING-PRICE")["Discount price"], "");
    assert.equal(row("MISSING-PRICE")["Platform price"], "");

    const gini = await buildGiniExport(await Partner.findOne({ slug: "gini" }), await Commission.find({ partner: "gini" }));
    const giniRows = sheetRows(gini.workbook, GINI_SHEET_NAME);
    const giniPrice = (sku) => {
      const match = giniRows.find((item) => String(item[GINI_HEADERS[2]]) === sku);
      return match ? Number(match[GINI_HEADERS[3]]) : null;
    };
    assert.equal(giniPrice("HFP90.000BK"), 366500);
    assert.equal(giniPrice("PLAIN-7000"), 7750);
    assert.equal(giniPrice("MISSING-PRICE"), null);
    assert.equal(gini.report.missing.some((item) => item.code === "price_needs_review"), true);
  });

  it("keeps the regular price across a later refresh and drops only an imported discount override", async () => {
    const echoBefore = await Product.findOne({ ibsherId: "echo" }).lean();
    const manualBefore = await Product.findOne({ ibsherId: "manual" }).lean();
    const remoteEcho = {
      _id: "echo",
      itemCode: "ECHO-273",
      price: 333000,
      discountPrice: 250000,
      name: echoBefore.name,
      description: echoBefore.description,
      brand: echoBefore.brand,
      category: echoBefore.category,
      subCategory: echoBefore.subCategory,
      collectionName: echoBefore.collectionName,
      createdBy: echoBefore.createdBy,
      variants: echoBefore.variants,
    };
    const remoteManual = {
      ...remoteEcho,
      _id: "manual",
      itemCode: "MANUAL-300",
      discountPrice: 273000,
    };
    const untouched = structuredClone(remoteEcho);
    await upsertProducts([remoteEcho, remoteManual], new Date());
    assert.equal(remoteEcho.discountPrice, 250000);

    const echo = await Product.findOne({ ibsherId: "echo" }).lean();
    const manual = await Product.findOne({ ibsherId: "manual" }).lean();
    const legacy = await Product.findOne({ itemCode: "HFP90.000BK" }).lean();
    assert.equal(echo.price, 333000);
    assert.equal(echo.discountPrice, 0);
    assert.equal(echo.ibsherDiscountPrice, 250000);
    assert.equal(echo.overrides.discountPrice, null);
    assert.equal(echo.overrides.price, 350000);
    assert.equal(echo.overrides.sku, "ECHO-SKU");
    assert.equal(echo.variants[0].sizes[0].stockQuantity, 4);
    assert.equal(toResolvedProduct(echo).sellingPrice, 350000);

    assert.equal(manual.discountPrice, 0);
    assert.equal(manual.ibsherDiscountPrice, 273000);
    assert.equal(manual.overrides.discountPrice, 300000);
    assert.equal(manual.overrides.sku, "MANUAL-SKU");
    assert.equal(toResolvedProduct(manual).sellingPrice, 300000);
    assert.equal(manualBefore.overrides.discountPrice, 300000);

    assert.equal(legacy.discountPrice, 273000);
    assert.equal(legacy.price, 333000);
    assert.equal(toResolvedProduct(legacy).sellingPrice, 333000);
    assert.deepEqual(
      { price: remoteEcho.price, discountPrice: remoteEcho.discountPrice, variants: remoteEcho.variants },
      { price: untouched.price, discountPrice: untouched.discountPrice, variants: untouched.variants }
    );
  });
});
