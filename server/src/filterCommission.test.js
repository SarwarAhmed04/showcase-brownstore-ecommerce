import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Commission, COMMISSION_SCOPES } from "./models/Commission.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { Product } from "./models/Product.js";
import { buildMiswagTestPayload } from "./services/miswagTestProduct.js";
import {
  applyFilterChange,
  clearChildOptions,
  emptyFilterSelection,
  ensureOption,
  filterFieldsEnabled,
  filterOptionsQueryForChange,
  filterPreviewParams,
  filterSelectionComplete,
  filterSelectionIssue,
  selectionFromCommission,
} from "../../client/src/lib/filterCommissionForm.js";
import {
  applyCommissionRate,
  commissionMatchFilter,
  filterCommissionOptions,
  FILTER_COLLECTION_MESSAGE,
  FILTER_REQUIRED_MESSAGE,
  filterCommissionTargetId,
  filterIdsError,
  filterNoMatchMessage,
  filterSpecificity,
  findTarget,
  resolveCommissionRate,
  saveFilterCommission,
  sortCommissions,
  toAdminCommission,
  winningCommission,
} from "./utils/commission.js";
import { buildCommissionWorkbook } from "./utils/commissionExcel.js";
import { partnerPricePreview, toPartnerProduct } from "./utils/partnerCatalog.js";
import { GINI_HEADERS, giniExportForPartner } from "./utils/platformExcel/gini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ID = {
  v1: "vendor-1",
  v2: "vendor-2",
  zilan: "brand-zilan",
  other: "brand-other",
  solo: "brand-solo",
  home: "cat-home",
  electronics: "cat-electronics",
  garden: "cat-garden",
  kitchen: "sub-kitchen",
  laundry: "sub-laundry",
  phones: "sub-phones",
  plants: "sub-plants",
  fridge: "col-fridge",
  wash: "col-wash",
  dryers: "col-dryers",
  smartphones: "col-smartphones",
  ovens: "col-ovens",
  plantsCol: "col-plants",
};

const PATH = {
  vendorId: ID.v1,
  brandId: ID.zilan,
  categoryId: ID.home,
  subCategoryId: ID.kitchen,
  collectionId: ID.fridge,
};

function loc(en, ar = en, ku = en) {
  return { en, ar, ku };
}

const NAME = {
  zilan: loc("Zilan"),
  other: loc("Other Brand"),
  solo: loc("Solo"),
  home: loc("Home Appliances"),
  electronics: loc("Electronics"),
  garden: loc("Garden"),
  kitchen: loc("Kitchen Appliances"),
  laundry: loc("Laundry"),
  phones: loc("Phones"),
  plants: loc("Plants"),
  fridge: loc("Refrigerators"),
  wash: loc("Washing Machines"),
  dryers: loc("Dryers"),
  smartphones: loc("Smartphones"),
  ovens: loc("Ovens"),
};

function makeProduct(overrides = {}, price = 100000) {
  const ids = { ...PATH, ...overrides };
  return {
    _id: overrides._id || "product-1",
    price,
    discountPrice: 0,
    createdBy: { _id: ids.vendorId, name: "ABC" },
    brand: { _id: ids.brandId, name: NAME.zilan },
    category: { _id: ids.categoryId, name: NAME.home },
    subCategory: { _id: ids.subCategoryId, name: NAME.kitchen },
    collectionName: { _id: ids.collectionId, name: NAME.fridge },
  };
}

function rule(scope, targetId, percentage, extra = {}) {
  return { scope, targetId, percentage, isActive: true, ...extra };
}

const filterRule = { scope: "filter", ...PATH, percentage: 10, isActive: true };
const brandRule = rule("brand", ID.zilan, 15);
const allRule = rule("all", "*", 5);
const safetyRules = [allRule, brandRule, filterRule];

function byId(rows) {
  return new Map((rows || []).map((row) => [row.id, row]));
}

function catalogProduct(code, ids, names, price = 100000) {
  return {
    ibsherId: `fc-${code}`,
    itemCode: code,
    name: loc(`EN ${code}`, `عربي ${code}`, `KU ${code}`),
    description: loc(`Description ${code}`, `وصف ${code}`, `وەسف ${code}`),
    price,
    discountPrice: 0,
    isActive: true,
    category: { _id: ids.categoryId, name: names.category },
    subCategory: { _id: ids.subCategoryId, name: names.subCategory },
    collectionName: { _id: ids.collectionId, name: names.collection },
    brand: { _id: ids.brandId, name: names.brand },
    createdBy: { _id: ids.vendorId, name: names.vendor },
    variants: [
      {
        color: { en: "Black" },
        images: [{ url: "/uploads/products/gini-test.webp" }],
        sizes: [{ stockQuantity: 4 }],
      },
    ],
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

describe("filter commission rules", () => {
  it("adds filter without reordering the existing scopes", () => {
    assert.deepEqual(COMMISSION_SCOPES, [
      "all",
      "category",
      "subcategory",
      "collection",
      "brand",
      "vendor",
      "filter",
    ]);
  });

  it("keeps a five-id target key and requires only vendor, brand, and category", () => {
    const key = filterCommissionTargetId(PATH);
    assert.equal(filterCommissionTargetId(PATH), key);
    assert.equal(key.includes("_ALL_"), false);
    assert.equal(
      key,
      [PATH.vendorId, PATH.brandId, PATH.categoryId, PATH.subCategoryId, PATH.collectionId]
        .map((part) => encodeURIComponent(part))
        .join("|")
    );
    assert.notEqual(
      filterCommissionTargetId({ ...PATH, vendorId: "a|b", brandId: "c" }),
      filterCommissionTargetId({ ...PATH, vendorId: "a", brandId: "b|c" })
    );
    const broad = { vendorId: ID.v1, brandId: ID.zilan, categoryId: ID.home };
    const mid = { ...broad, subCategoryId: ID.kitchen };
    assert.equal(filterCommissionTargetId(broad), `${ID.v1}|${ID.zilan}|${ID.home}|_ALL_|_ALL_`);
    assert.equal(filterCommissionTargetId(mid), `${ID.v1}|${ID.zilan}|${ID.home}|${ID.kitchen}|_ALL_`);
    assert.equal(new Set([filterCommissionTargetId(broad), filterCommissionTargetId(mid), key]).size, 3);
    assert.equal(filterSpecificity(broad), 3);
    assert.equal(filterSpecificity(mid), 4);
    assert.equal(filterSpecificity(PATH), 5);
    assert.equal(filterSpecificity({ ...broad, collectionId: ID.fridge }), 0);
    assert.equal(filterIdsError({ vendorId: ID.v1 }), FILTER_REQUIRED_MESSAGE);
    assert.equal(filterIdsError({ vendorId: ID.v1, brandId: ID.zilan }), FILTER_REQUIRED_MESSAGE);
    assert.equal(filterIdsError({ vendorId: ID.v1, categoryId: ID.home }), FILTER_REQUIRED_MESSAGE);
    assert.equal(filterIdsError({ ...broad, collectionId: ID.fridge }), FILTER_COLLECTION_MESSAGE);
    assert.equal(filterIdsError(broad), "");
    assert.equal(filterIdsError(PATH), "");
    assert.equal(filterSelectionComplete(PATH), true);
    assert.equal(filterSelectionComplete({ ...PATH, collectionId: "" }), true);
    assert.equal(filterSelectionComplete({ ...PATH, subCategoryId: "", collectionId: "" }), true);
    assert.equal(filterSelectionComplete({ ...PATH, vendorId: "  " }), false);
    assert.equal(filterSelectionComplete({ vendorId: ID.v1, brandId: ID.zilan }), false);
    assert.equal(filterSelectionComplete({ vendorId: ID.v1, categoryId: ID.home }), false);
    assert.equal(filterSelectionIssue({ ...broad, collectionId: ID.fridge }), "collection");
    assert.equal(filterSelectionIssue({ vendorId: ID.v1 }), "required");
    assert.equal(filterSelectionIssue(broad), "");
    assert.deepEqual(selectionFromCommission({ scope: "filter", ...broad, subCategoryId: null, collectionId: null }), {
      ...broad,
      subCategoryId: "",
      collectionId: "",
    });
    const restoredMid = selectionFromCommission({ scope: "filter", ...mid, collectionId: null });
    assert.equal(restoredMid.subCategoryId, ID.kitchen);
    assert.equal(restoredMid.collectionId, "");
    assert.equal(filterFieldsEnabled(restoredMid).subCategory, true);
    assert.equal(filterFieldsEnabled(restoredMid).collection, true);
    assert.equal(filterFieldsEnabled({ ...broad, subCategoryId: "", collectionId: "" }).subCategory, true);
    assert.equal(filterFieldsEnabled({ ...broad, subCategoryId: "", collectionId: "" }).collection, false);
    assert.deepEqual(selectionFromCommission({ scope: "filter", ...PATH }), PATH);
  });

  it("clears every child when a parent filter changes", () => {
    const start = { ...PATH };
    const vendorChange = applyFilterChange(start, "vendorId", ID.v2);
    assert.deepEqual(vendorChange, {
      vendorId: ID.v2,
      brandId: "",
      categoryId: "",
      subCategoryId: "",
      collectionId: "",
    });
    const brandChange = applyFilterChange(start, "brandId", ID.other);
    assert.equal(brandChange.vendorId, ID.v1);
    assert.equal(brandChange.brandId, ID.other);
    assert.equal(brandChange.categoryId, "");
    assert.equal(brandChange.subCategoryId, "");
    assert.equal(brandChange.collectionId, "");
    const categoryChange = applyFilterChange(start, "categoryId", ID.electronics);
    assert.equal(categoryChange.brandId, ID.zilan);
    assert.equal(categoryChange.subCategoryId, "");
    assert.equal(categoryChange.collectionId, "");
    const subChange = applyFilterChange(start, "subCategoryId", ID.laundry);
    assert.equal(subChange.categoryId, ID.home);
    assert.equal(subChange.collectionId, "");
    const collectionChange = applyFilterChange(start, "collectionId", ID.wash);
    assert.equal(collectionChange.subCategoryId, ID.kitchen);
    assert.equal(collectionChange.collectionId, ID.wash);
    assert.equal(applyFilterChange(start, "vendorId", ID.v1), start);

    const options = {
      brands: [{ id: "b" }],
      categories: [{ id: "c" }],
      subcategories: [{ id: "s" }],
      collections: [{ id: "col" }],
    };
    const cleared = clearChildOptions(options, "brandId");
    assert.equal(cleared.brands.length, 1);
    assert.deepEqual(cleared.categories, []);
    assert.deepEqual(cleared.subcategories, []);
    assert.deepEqual(cleared.collections, []);
    assert.equal(options.categories.length, 1);
    assert.deepEqual(clearChildOptions(options, "vendorId").brands, []);
  });

  it("enables dropdowns in vendor, brand, category, sub-category, collection order", () => {
    assert.deepEqual(filterFieldsEnabled(emptyFilterSelection()), {
      vendor: true,
      brand: false,
      category: false,
      subCategory: false,
      collection: false,
    });
    assert.equal(filterFieldsEnabled({ ...emptyFilterSelection(), vendorId: ID.v1 }).brand, true);
    assert.equal(
      filterFieldsEnabled({ ...emptyFilterSelection(), vendorId: ID.v1, brandId: ID.zilan }).category,
      true
    );
    assert.equal(filterFieldsEnabled({ ...PATH, collectionId: "" }).collection, true);
    assert.equal(filterFieldsEnabled({ ...PATH, subCategoryId: "" }).collection, false);
    assert.deepEqual(filterPreviewParams({ ...PATH, collectionId: "", subCategoryId: "" }), {
      vendor: ID.v1,
      brand: ID.zilan,
      category: ID.home,
    });
    assert.deepEqual(filterPreviewParams({ ...PATH, collectionId: "" }), {
      vendor: ID.v1,
      brand: ID.zilan,
      category: ID.home,
      subCategory: ID.kitchen,
    });
    assert.deepEqual(filterPreviewParams(PATH), {
      vendor: ID.v1,
      brand: ID.zilan,
      category: ID.home,
      subCategory: ID.kitchen,
      collection: ID.fridge,
    });
    assert.deepEqual(filterOptionsQueryForChange(PATH, "subCategoryId")?.subCategoryId, ID.kitchen);
    assert.equal(filterOptionsQueryForChange({ ...PATH, brandId: "" }, "brandId"), null);
    const pinned = ensureOption([], ID.zilan, NAME.zilan);
    assert.equal(pinned[0].id, ID.zilan);
    assert.equal(ensureOption(pinned, ID.zilan, NAME.zilan).length, 1);
  });

  it("uses only the filter percentage when all five ids match", () => {
    const exact = makeProduct();
    assert.equal(winningCommission(exact, safetyRules).scope, "filter");
    assert.equal(resolveCommissionRate(exact, safetyRules), 10);
    assert.equal(applyCommissionRate(100000, resolveCommissionRate(exact, safetyRules)), 110000);
    assert.notEqual(applyCommissionRate(100000, 10), 115000);
    assert.notEqual(applyCommissionRate(100000, 10), 125000);
    assert.equal(partnerPricePreview(exact, safetyRules).customPrice, false);

    const higher = [
      rule("vendor", ID.v1, 40),
      rule("collection", ID.fridge, 35),
      rule("subcategory", ID.kitchen, 30),
      brandRule,
      rule("category", ID.home, 12),
      allRule,
      filterRule,
    ];
    assert.equal(resolveCommissionRate(exact, higher), 10);
    assert.equal(applyCommissionRate(100000, 10), 110000);
    assert.equal(
      resolveCommissionRate(
        exact,
        higher.map((item) => (item.scope === "filter" ? { ...item, isActive: false } : item))
      ),
      40
    );
  });

  it("ignores a partial filter match and keeps the existing precedence", () => {
    const rate = (overrides) => resolveCommissionRate(makeProduct(overrides), safetyRules);
    assert.equal(rate({ collectionId: ID.wash }), 15);
    assert.equal(rate({ vendorId: ID.v2 }), 15);
    assert.equal(rate({ categoryId: ID.electronics }), 15);
    assert.equal(rate({ subCategoryId: ID.laundry }), 15);
    assert.equal(rate({ collectionId: "" }), 15);
    assert.equal(rate({ brandId: ID.other }), 5);
    assert.equal(resolveCommissionRate(makeProduct({ brandId: ID.other }), [filterRule]), 0);

    const inactive = [{ ...filterRule, isActive: false }, brandRule, allRule];
    assert.equal(resolveCommissionRate(makeProduct(), inactive), 15);

    const zero = [{ ...filterRule, percentage: 0 }, brandRule];
    assert.equal(resolveCommissionRate(makeProduct(), zero), 0);
    assert.equal(applyCommissionRate(100000, 0), 100000);

    const ranked = [
      rule("vendor", ID.v1, 40),
      rule("collection", ID.fridge, 35),
      rule("subcategory", ID.kitchen, 30),
      brandRule,
      rule("category", ID.home, 12),
      allRule,
    ];
    assert.equal(resolveCommissionRate(makeProduct(), ranked), 40);
    assert.equal(resolveCommissionRate(makeProduct({ vendorId: "other-vendor" }), ranked), 35);
    assert.equal(
      resolveCommissionRate(makeProduct({ vendorId: "other-vendor", collectionId: "other-col" }), ranked),
      30
    );
    assert.equal(
      resolveCommissionRate(
        makeProduct({
          vendorId: "other-vendor",
          collectionId: "other-col",
          subCategoryId: "other-sub",
        }),
        ranked
      ),
      15
    );
    assert.equal(
      resolveCommissionRate(
        makeProduct({
          vendorId: "other-vendor",
          collectionId: "other-col",
          subCategoryId: "other-sub",
          brandId: "other-brand",
        }),
        ranked
      ),
      12
    );
    assert.equal(
      resolveCommissionRate(
        makeProduct({
          vendorId: "other-vendor",
          collectionId: "other-col",
          subCategoryId: "other-sub",
          brandId: "other-brand",
          categoryId: "other-cat",
        }),
        ranked
      ),
      5
    );
    assert.equal(resolveCommissionRate(makeProduct(), []), 0);
  });

  it("rounds up to the next 250 IQD after the single winning rate", () => {
    const small = makeProduct({}, 7001);
    const preview = partnerPricePreview(small, safetyRules);
    assert.equal(preview.storePrice, 7001);
    assert.equal(preview.rate, 10);
    assert.equal(preview.price, 7750);
    assert.equal(preview.customPrice, false);
    assert.equal(small.price, 7001);
    assert.equal(applyCommissionRate(7001, 10), 7750);
    assert.equal(applyCommissionRate(100000, 10), 110000);
    const published = toPartnerProduct(
      { ...makeProduct(), name: loc("Fridge", "ثلاجة", "سارد") },
      safetyRules,
      "http://localhost"
    );
    assert.equal(published.price, 110000);
  });

  it("uses the most specific matching filter and never stacks percentages", () => {
    const broad = {
      scope: "filter",
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      percentage: 10,
      isActive: true,
    };
    const mid = { ...broad, subCategoryId: ID.kitchen, percentage: 12 };
    const exact = { scope: "filter", ...PATH, percentage: 15, isActive: true };
    const brand = rule("brand", ID.zilan, 20);
    const rules = [broad, mid, exact, brand];
    const fridge = makeProduct();
    const wash = makeProduct({ collectionId: ID.wash });
    const otherSub = makeProduct({ subCategoryId: ID.laundry, collectionId: ID.dryers });
    const otherCategory = makeProduct({
      categoryId: ID.electronics,
      subCategoryId: ID.phones,
      collectionId: ID.smartphones,
    });

    assert.equal(winningCommission(fridge, rules).percentage, 15);
    assert.equal(resolveCommissionRate(fridge, rules), 15);
    assert.equal(resolveCommissionRate(wash, rules), 12);
    assert.equal(resolveCommissionRate(otherSub, rules), 10);
    assert.equal(resolveCommissionRate(otherCategory, rules), 20);
    assert.equal(applyCommissionRate(100000, resolveCommissionRate(fridge, rules)), 115000);
    assert.notEqual(resolveCommissionRate(fridge, rules), 10 + 12 + 15);
    assert.notEqual(resolveCommissionRate(fridge, rules), 15 + 20);
    assert.equal(applyCommissionRate(7001, 10), 7750);

    const reversed = [brand, exact, mid, broad];
    assert.equal(resolveCommissionRate(fridge, reversed), 15);
    assert.equal(resolveCommissionRate(wash, reversed), 12);
    assert.equal(resolveCommissionRate(otherSub, reversed), 10);

    assert.equal(resolveCommissionRate(fridge, [{ ...exact, isActive: false }, mid, broad, brand]), 12);
    assert.equal(
      resolveCommissionRate(fridge, [
        { ...exact, isActive: false },
        { ...mid, isActive: false },
        broad,
        brand,
      ]),
      10
    );
    assert.equal(
      resolveCommissionRate(fridge, [
        { ...exact, isActive: false },
        { ...mid, isActive: false },
        { ...broad, isActive: false },
        brand,
      ]),
      20
    );

    const illegal = {
      scope: "filter",
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      collectionId: ID.fridge,
      percentage: 99,
      isActive: true,
    };
    assert.equal(resolveCommissionRate(fridge, [illegal, brand]), 20);

    const ladder = [
      broad,
      rule("vendor", ID.v1, 40),
      rule("collection", ID.smartphones, 35),
      rule("subcategory", ID.phones, 30),
      brand,
      rule("category", ID.electronics, 12),
      rule("all", "*", 5),
    ];
    assert.equal(resolveCommissionRate(fridge, ladder), 10);
    assert.equal(resolveCommissionRate(otherCategory, ladder), 40);
    assert.equal(
      resolveCommissionRate(
        makeProduct({
          vendorId: "other-vendor",
          categoryId: ID.electronics,
          subCategoryId: ID.phones,
          collectionId: ID.smartphones,
        }),
        ladder
      ),
      35
    );
  });

  it("matches a filter rule when the product id is an ObjectId", () => {
    const vendorObjectId = new mongoose.Types.ObjectId();
    const product = makeProduct({ vendorId: vendorObjectId });
    const matched = {
      scope: "filter",
      ...PATH,
      vendorId: String(vendorObjectId),
      percentage: 10,
      isActive: true,
    };
    assert.equal(resolveCommissionRate(product, [matched, brandRule]), 10);
    assert.equal(
      resolveCommissionRate(product, [{ ...matched, collectionId: ID.wash }, brandRule]),
      15
    );
  });

  it("sorts filter rules above the existing scopes and does not look them up as collections", () => {
    const sorted = sortCommissions([
      { scope: "brand", updatedAt: "2024-01-01" },
      { scope: "filter", updatedAt: "2020-01-01" },
      { scope: "vendor", updatedAt: "2023-01-01" },
      { scope: "all", updatedAt: "2025-01-01" },
    ]);
    assert.deepEqual(
      sorted.map((item) => item.scope),
      ["filter", "vendor", "brand", "all"]
    );
    assert.equal(findTarget({ collections: [{ id: ID.fridge }] }, "filter", ID.fridge), null);
    assert.deepEqual(selectionFromCommission({ scope: "filter", ...PATH }), PATH);
    assert.equal(selectionFromCommission({ scope: "brand", targetId: ID.zilan }), null);
  });

  it("does not put filter logic into IBSHER, Gini, Miswag large product, or category mapping", () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
    const admin = read("routes/admin.js");
    const commission = read("utils/commission.js");
    const ibsher = read("services/ibsher.js");
    const gini = read("utils/platformExcel/gini.js");
    const miswag = read("services/miswagTestProduct.js");
    const syncAll = read("services/miswagSyncAll.js");
    const mapping = read("services/miswagCategoryMapping.js");
    const fields = read("utils/platformTaxonomyFields.js");
    const ui = read("../../client/src/pages/admin/Commissions.jsx");
    const i18n = read("../../client/src/i18n.js");

    assert.match(admin, /export function syncFromIbsher/);
    assert.match(admin, /Per-product platform prices have been removed/);
    assert.match(admin, /if \(scope === "filter"\)/);
    assert.match(admin, /filterCommissionOptions/);
    assert.match(admin, /saveFilterCommission/);
    assert.match(admin, /matchId\("createdBy\._id", query\.vendor\)/);
    assert.match(admin, /matchId\("brand\._id", brand\)/);
    assert.match(admin, /matchId\("category\._id", category\)/);
    assert.match(admin, /matchId\("subCategory\._id", query\.subCategory\)/);
    assert.match(admin, /matchId\("collectionName\._id", query\.collection\)/);
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategoryMapping.js")), false);

    assert.match(commission, /scope === "filter"/);
    assert.equal(commission.includes("isLarge"), false);
    assert.equal(commission.includes("is_large"), false);
    assert.equal(ibsher.includes("COMMISSION_SCOPES"), false);
    assert.equal(ibsher.includes("filterCommission"), false);
    assert.match(gini, /partnerPricePreview/);
    assert.equal(gini.includes('scope === "filter"'), false);
    assert.match(miswag, /partnerPricePreview/);
    assert.match(miswag, /is_large: miswagIsLargeFlag/);
    assert.equal(miswag.includes('scope === "filter"'), false);
    assert.match(syncAll, /buildMiswagTestPayload/);
    assert.equal(syncAll.includes('scope === "filter"'), false);
    assert.equal(mapping.includes("winningCommission"), false);
    assert.equal(mapping.includes("resolveCommissionRate"), false);
    assert.equal(mapping.includes('scope === "filter"'), false);
    assert.match(fields, /export function miswagIsLargeFlag/);
    assert.equal(fields.includes("winningCommission"), false);
    assert.match(ui, /applyFilterChange/);
    assert.match(ui, /filterSelectionIssue/);
    assert.match(ui, /allSubCategories/);
    assert.match(ui, /allCollections/);
    assert.match(ui, /filterPreviewParams/);
    assert.match(i18n, /filterCommission: "Filter Commission"/);
    assert.match(i18n, /allSubCategories: "All Sub-categories"/);
    assert.match(i18n, /allCollections: "All Collections"/);
    assert.match(i18n, /filterCommission: "کۆمەیشنی فلتەر"/);
    assert.match(i18n, /filterCommission: "عمولة الفلتر"/);
  });
});

describe("filter commission catalog", { concurrency: 1, timeout: 180000 }, () => {
  let memory;

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("filter-commission"));
    await Partner.create([
      { slug: "miswag", name: "Miswag", isActive: true },
      { slug: "gini", name: "Gini", isActive: true },
      { slug: "elryan", name: "Elryan", isActive: true },
      { slug: "ibazzar", name: "Ibazzar", isActive: true },
    ]);
    const giniValues = {
      categoryName: "الجمال والعناية",
      categoryId: "7",
      subcategoryName: "العناية بالبشرة",
      subcategoryId: "31",
    };
    await PlatformTaxonomyConfig.create([
      { partner: "gini", brownCollectionId: ID.fridge, values: giniValues },
      { partner: "gini", brownCollectionId: ID.wash, values: giniValues },
    ]);
    await Product.insertMany([
      catalogProduct("FC-FRIDGE", PATH, {
        vendor: "ABC",
        brand: NAME.zilan,
        category: NAME.home,
        subCategory: NAME.kitchen,
        collection: NAME.fridge,
      }),
      catalogProduct(
        "FC-FRIDGE-7001",
        PATH,
        {
          vendor: "ABC",
          brand: NAME.zilan,
          category: NAME.home,
          subCategory: NAME.kitchen,
          collection: NAME.fridge,
        },
        7001
      ),
      catalogProduct(
        "FC-WASH",
        { ...PATH, collectionId: ID.wash },
        {
          vendor: "ABC",
          brand: NAME.zilan,
          category: NAME.home,
          subCategory: NAME.kitchen,
          collection: NAME.wash,
        }
      ),
      catalogProduct(
        "FC-DRY",
        { ...PATH, subCategoryId: ID.laundry, collectionId: ID.dryers },
        {
          vendor: "ABC",
          brand: NAME.zilan,
          category: NAME.home,
          subCategory: NAME.laundry,
          collection: NAME.dryers,
        }
      ),
      catalogProduct(
        "FC-OTHER-FRIDGE",
        { ...PATH, brandId: ID.other },
        {
          vendor: "ABC",
          brand: NAME.other,
          category: NAME.home,
          subCategory: NAME.kitchen,
          collection: NAME.fridge,
        }
      ),
      catalogProduct(
        "FC-PHONE",
        {
          ...PATH,
          categoryId: ID.electronics,
          subCategoryId: ID.phones,
          collectionId: ID.smartphones,
        },
        {
          vendor: "ABC",
          brand: NAME.zilan,
          category: NAME.electronics,
          subCategory: NAME.phones,
          collection: NAME.smartphones,
        }
      ),
      catalogProduct(
        "FC-GARDEN",
        {
          vendorId: ID.v1,
          brandId: ID.other,
          categoryId: ID.garden,
          subCategoryId: ID.plants,
          collectionId: ID.plantsCol,
        },
        {
          vendor: "ABC",
          brand: NAME.other,
          category: NAME.garden,
          subCategory: NAME.plants,
          collection: NAME.plants,
        }
      ),
      catalogProduct(
        "FC-V2-FRIDGE",
        { ...PATH, vendorId: ID.v2 },
        {
          vendor: "DEF",
          brand: NAME.zilan,
          category: NAME.home,
          subCategory: NAME.kitchen,
          collection: NAME.fridge,
        }
      ),
      catalogProduct(
        "FC-OVEN",
        { ...PATH, vendorId: ID.v2, collectionId: ID.ovens },
        {
          vendor: "DEF",
          brand: NAME.zilan,
          category: NAME.home,
          subCategory: NAME.kitchen,
          collection: NAME.ovens,
        }
      ),
      catalogProduct(
        "FC-SOLO",
        {
          vendorId: ID.v2,
          brandId: ID.solo,
          categoryId: ID.electronics,
          subCategoryId: ID.phones,
          collectionId: ID.smartphones,
        },
        {
          vendor: "DEF",
          brand: NAME.solo,
          category: NAME.electronics,
          subCategory: NAME.phones,
          collection: NAME.smartphones,
        }
      ),
    ]);
  });

  after(async () => {
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  async function setRules(partner, { filter = 10, brand = 15, all = 5 } = {}) {
    await Commission.deleteMany({ partner });
    await saveFilterCommission({ partner, ...PATH, percentage: filter });
    await Commission.create({
      partner,
      scope: "brand",
      targetId: ID.zilan,
      targetName: NAME.zilan,
      percentage: brand,
      isActive: true,
    });
    await Commission.create({
      partner,
      scope: "all",
      targetId: "*",
      percentage: all,
      isActive: true,
    });
    return Commission.find({ partner, isActive: { $ne: false } });
  }

  it("requires vendor, brand, and category, and rejects a collection without a sub-category", async () => {
    await assert.rejects(
      () =>
        Commission.create({
          partner: "miswag",
          scope: "filter",
          targetId: "incomplete",
          percentage: 10,
        }),
      /Select a vendor, brand, and category/
    );
    await assert.rejects(
      () =>
        Commission.create({
          partner: "miswag",
          scope: "filter",
          targetId: filterCommissionTargetId({
            vendorId: ID.v1,
            brandId: ID.zilan,
            categoryId: ID.home,
            collectionId: ID.fridge,
          }),
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          collectionId: ID.fridge,
          percentage: 10,
        }),
      /sub-category before a collection/
    );
    await assert.rejects(
      () =>
        Commission.create({
          partner: "miswag",
          scope: "filter",
          targetId: "wrong-key",
          ...PATH,
          percentage: 10,
        }),
      /does not match/
    );
    const canonical = filterCommissionTargetId(PATH);
    const schemaOnly = await Commission.create({
      partner: "schema-check",
      scope: "filter",
      targetId: canonical,
      ...PATH,
      percentage: 10,
    });
    assert.equal(schemaOnly.scope, "filter");
    await schemaOnly.deleteOne();

    const broadKey = filterCommissionTargetId({
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
    });
    const broadSchema = await Commission.create({
      partner: "schema-check",
      scope: "filter",
      targetId: broadKey,
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      percentage: 10,
    });
    assert.equal(broadSchema.targetId, broadKey);
    await broadSchema.deleteOne();

    await assert.rejects(
      () => saveFilterCommission({ partner: "miswag", vendorId: ID.v1, percentage: 10 }),
      (err) => err.message === FILTER_REQUIRED_MESSAGE
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          vendorId: ID.v1,
          brandId: ID.zilan,
          percentage: 10,
        }),
      (err) => err.message === FILTER_REQUIRED_MESSAGE
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          vendorId: ID.v1,
          categoryId: ID.home,
          percentage: 10,
        }),
      (err) => err.message === FILTER_REQUIRED_MESSAGE
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          collectionId: ID.fridge,
          percentage: 10,
        }),
      (err) => err.message === FILTER_COLLECTION_MESSAGE
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          ...PATH,
          collectionId: ID.dryers,
          percentage: 10,
        }),
      (err) => err.message === filterNoMatchMessage({ ...PATH, collectionId: ID.dryers })
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          subCategoryId: ID.phones,
          percentage: 10,
        }),
      (err) =>
        err.message ===
        filterNoMatchMessage({
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          subCategoryId: ID.phones,
        })
    );
    await assert.rejects(
      () =>
        saveFilterCommission({
          partner: "miswag",
          vendorId: ID.v1,
          brandId: ID.solo,
          categoryId: ID.home,
          percentage: 10,
        }),
      (err) =>
        err.message ===
        filterNoMatchMessage({ vendorId: ID.v1, brandId: ID.solo, categoryId: ID.home })
    );
    assert.equal(await Commission.countDocuments({ partner: "miswag", scope: "filter" }), 0);
    await assert.rejects(
      () => filterCommissionOptions({ brandId: ID.zilan }),
      /Select a vendor before a brand/
    );
  });

  it("builds each dropdown from products on the selected path", async () => {
    const vendors = byId((await filterCommissionOptions({})).vendors);
    assert.equal(vendors.get(ID.v1).products, 7);
    assert.equal(vendors.get(ID.v1).name.en, "ABC");
    assert.equal(vendors.get(ID.v2).products, 3);
    assert.equal(vendors.get(ID.v2).name.en, "DEF");

    const v1Brands = byId((await filterCommissionOptions({ vendorId: ID.v1 })).brands);
    assert.equal(v1Brands.size, 2);
    assert.equal(v1Brands.get(ID.zilan).products, 5);
    assert.equal(v1Brands.get(ID.other).products, 2);
    assert.equal(v1Brands.has(ID.solo), false);
    assert.deepEqual(
      [...v1Brands.values()].map((row) => row.name.en),
      ["Other Brand", "Zilan"]
    );

    const v2Brands = byId((await filterCommissionOptions({ vendorId: ID.v2 })).brands);
    assert.equal(v2Brands.get(ID.zilan).products, 2);
    assert.equal(v2Brands.get(ID.solo).products, 1);
    assert.equal(v2Brands.has(ID.other), false);

    const zilanCategories = byId(
      (await filterCommissionOptions({ vendorId: ID.v1, brandId: ID.zilan })).categories
    );
    assert.equal(zilanCategories.get(ID.home).products, 4);
    assert.equal(zilanCategories.get(ID.electronics).products, 1);
    assert.equal(zilanCategories.has(ID.garden), false);

    const otherCategories = byId(
      (await filterCommissionOptions({ vendorId: ID.v1, brandId: ID.other })).categories
    );
    assert.equal(otherCategories.get(ID.home).products, 1);
    assert.equal(otherCategories.get(ID.garden).products, 1);
    assert.equal(otherCategories.has(ID.electronics), false);

    const subs = byId(
      (
        await filterCommissionOptions({
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
        })
      ).subcategories
    );
    assert.equal(subs.get(ID.kitchen).products, 3);
    assert.equal(subs.get(ID.laundry).products, 1);
    assert.equal(subs.has(ID.phones), false);

    const collections = byId(
      (
        await filterCommissionOptions({
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          subCategoryId: ID.kitchen,
        })
      ).collections
    );
    assert.equal(collections.get(ID.fridge).products, 2);
    assert.equal(collections.get(ID.wash).products, 1);
    assert.equal(collections.has(ID.ovens), false);
    assert.equal(collections.has(ID.dryers), false);

    const laundry = byId(
      (
        await filterCommissionOptions({
          vendorId: ID.v1,
          brandId: ID.zilan,
          categoryId: ID.home,
          subCategoryId: ID.laundry,
        })
      ).collections
    );
    assert.deepEqual([...laundry.keys()], [ID.dryers]);
  });

  it("saves, updates, reloads, edits, toggles, and deletes one filter rule per path", async () => {
    await Commission.deleteMany({ partner: { $in: ["miswag", "gini", "legacy-raw"] } });
    const created = await saveFilterCommission({ partner: "miswag", ...PATH, percentage: 10 });
    const updated = await saveFilterCommission({ partner: "miswag", ...PATH, percentage: 12 });
    assert.equal(String(created._id), String(updated._id));
    assert.equal(await Commission.countDocuments({ partner: "miswag", scope: "filter" }), 1);

    const gini = await saveFilterCommission({ partner: "gini", ...PATH, percentage: 8 });
    assert.notEqual(String(gini._id), String(created._id));
    assert.equal(gini.percentage, 8);

    const reloaded = await Commission.findById(created._id);
    assert.equal(reloaded.percentage, 12);
    assert.equal(reloaded.vendorId, ID.v1);
    assert.equal(reloaded.brandId, ID.zilan);
    assert.equal(reloaded.categoryId, ID.home);
    assert.equal(reloaded.subCategoryId, ID.kitchen);
    assert.equal(reloaded.collectionId, ID.fridge);
    assert.equal(reloaded.targetId, filterCommissionTargetId(PATH));
    const dto = toAdminCommission(reloaded);
    assert.deepEqual(selectionFromCommission(dto), PATH);
    assert.equal(dto.filterPath.vendor.en, "ABC");
    assert.equal(dto.filterPath.brand.en, "Zilan");
    assert.equal(dto.filterPath.category.en, "Home Appliances");
    assert.equal(dto.filterPath.subCategory.en, "Kitchen Appliances");
    assert.equal(dto.filterPath.collection.en, "Refrigerators");
    assert.equal(
      dto.targetName.en,
      "ABC → Zilan → Home Appliances → Kitchen Appliances → Refrigerators"
    );

    const edited = await saveFilterCommission({ partner: "miswag", ...PATH, percentage: 10 });
    assert.equal(String(edited._id), String(created._id));
    assert.equal((await Commission.findById(created._id)).percentage, 10);

    edited.isActive = false;
    await edited.save();
    const inactive = await Commission.findById(created._id);
    assert.equal(inactive.isActive, false);
    const fridge = await Product.findOne({ itemCode: "FC-FRIDGE" });
    assert.equal(
      resolveCommissionRate(fridge, [toAdminCommission(inactive), brandRule, allRule]),
      15
    );
    inactive.isActive = true;
    await inactive.save();
    assert.equal((await Commission.findById(created._id)).isActive, true);

    await inactive.deleteOne();
    assert.equal(await Commission.findById(created._id), null);

    await Commission.collection.insertOne({
      partner: "legacy-raw",
      scope: "brand",
      targetId: ID.zilan,
      percentage: 15,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacy = await Commission.findOne({ partner: "legacy-raw" });
    assert.equal(legacy.scope, "brand");
    assert.equal(toAdminCommission(legacy).filterPath, null);
    assert.equal(toAdminCommission(legacy).vendorId, "");
    assert.equal(resolveCommissionRate(fridge, [toAdminCommission(legacy), allRule]), 15);
    legacy.isActive = false;
    await legacy.save();
    const lean = await Commission.findOne({ partner: "legacy-raw" }).lean();
    assert.equal(lean.scope, "brand");
    assert.equal(lean.targetId, ID.zilan);
    assert.equal(lean.percentage, 15);
    assert.equal(Object.prototype.hasOwnProperty.call(lean, "vendorId"), false);
  });

  it("matches only the exact five-id path in product queries", async () => {
    const narrow = commissionMatchFilter([{ scope: "filter", ...PATH, percentage: 10, isActive: true }]);
    const codes = (await Product.find(narrow).select("itemCode")).map((row) => row.itemCode).sort();
    assert.deepEqual(codes, ["FC-FRIDGE", "FC-FRIDGE-7001"]);
    assert.deepEqual(
      commissionMatchFilter([
        { scope: "filter", ...PATH, isActive: true },
        { scope: "all", targetId: "*", isActive: true },
      ]),
      {}
    );
    assert.deepEqual(commissionMatchFilter([{ scope: "all", targetId: "*", isActive: true }]), {});
  });

  it("prices Miswag, Gini, Elryan, and Ibazzar from the shared filter rule", async () => {
    await setRules("gini", { filter: 10, brand: 15, all: 5 });
    await setRules("miswag", { filter: 99, brand: 15, all: 3 });
    const giniBook = await giniExportForPartner(await Partner.findOne({ slug: "gini" }));
    const giniRows = sheetRows(giniBook.workbook, "Sheet1");
    const giniPrice = (sku) => {
      const row = giniRows.find((item) => String(item[GINI_HEADERS[2]]) === sku);
      assert.ok(row, sku);
      return Number(row[GINI_HEADERS[3]]);
    };
    assert.equal(giniPrice("FC-FRIDGE"), 110000);
    assert.equal(giniPrice("FC-FRIDGE-7001"), 7750);
    assert.equal(giniPrice("FC-WASH"), 115000);
    assert.equal(giniPrice("FC-OTHER-FRIDGE"), 105000);
    assert.equal(giniPrice("FC-V2-FRIDGE"), 115000);
    assert.equal(giniRows.some((row) => String(row[GINI_HEADERS[2]]) === "FC-DRY"), false);

    const miswagRules = await setRules("miswag", { filter: 10, brand: 15, all: 3 });
    const fridge = await Product.findOne({ itemCode: "FC-FRIDGE" });
    const wash = await Product.findOne({ itemCode: "FC-WASH" });
    const other = await Product.findOne({ itemCode: "FC-OTHER-FRIDGE" });
    const small = await Product.findOne({ itemCode: "FC-FRIDGE-7001" });
    const built = buildMiswagTestPayload(fridge, {
      rules: miswagRules,
      categoryId: "L3-1",
      brandId: 9,
    });
    assert.equal(built.pricing.rate, 10);
    assert.equal(built.pricing.price, 110000);
    assert.equal(built.payload.price, 110000);
    assert.equal(built.payload.is_large, false);
    assert.equal(built.pricing.customPrice, false);
    assert.equal(fridge.price, 100000);
    assert.equal(
      toPartnerProduct(fridge, miswagRules, "http://localhost").price,
      built.payload.price
    );
    assert.equal(
      buildMiswagTestPayload(wash, { rules: miswagRules, categoryId: "L3-1", brandId: 9 }).pricing.rate,
      15
    );
    assert.equal(
      buildMiswagTestPayload(wash, { rules: miswagRules, categoryId: "L3-1", brandId: 9 }).payload.price,
      115000
    );
    assert.equal(
      buildMiswagTestPayload(other, { rules: miswagRules, categoryId: "L3-1", brandId: 9 }).pricing.rate,
      3
    );
    assert.equal(
      buildMiswagTestPayload(small, { rules: miswagRules, categoryId: "L3-1", brandId: 9 }).payload.price,
      7750
    );
    const stored = await Product.findOne({ itemCode: "FC-FRIDGE" });
    assert.equal(stored.price, 100000);
    assert.equal(stored.discountPrice, 0);

    async function excelPrice(slug, sku) {
      const rules = await setRules(
        slug,
        slug === "ibazzar" ? { filter: 8, brand: 15, all: 4 } : { filter: 10, brand: 15, all: 5 }
      );
      const { workbook } = await buildCommissionWorkbook(await Partner.findOne({ slug }), rules);
      const rows = sheetRows(workbook, "Excel");
      const row = rows.find((item) => String(item.SKU) === sku);
      assert.ok(row, `${slug} ${sku}`);
      return { price: Number(row.Price), rate: Number(row["Commission %"]) };
    }

    const elryanFridge = await excelPrice("elryan", "FC-FRIDGE");
    assert.equal(elryanFridge.price, 110000);
    assert.equal(elryanFridge.rate, 10);
    const elryanWash = await excelPrice("elryan", "FC-WASH");
    assert.equal(elryanWash.price, 115000);
    assert.equal(elryanWash.rate, 15);
    const elryanOther = await excelPrice("elryan", "FC-OTHER-FRIDGE");
    assert.equal(elryanOther.price, 105000);
    assert.equal(elryanOther.rate, 5);
    const elryanSmall = await excelPrice("elryan", "FC-FRIDGE-7001");
    assert.equal(elryanSmall.price, 7750);
    assert.equal(elryanSmall.rate, 10);

    const ibazzarFridge = await excelPrice("ibazzar", "FC-FRIDGE");
    assert.equal(ibazzarFridge.price, 108000);
    assert.equal(ibazzarFridge.rate, 8);
    const ibazzarOther = await excelPrice("ibazzar", "FC-OTHER-FRIDGE");
    assert.equal(ibazzarOther.price, 104000);
    assert.equal(ibazzarOther.rate, 4);
    const ibazzarWash = await excelPrice("ibazzar", "FC-WASH");
    assert.equal(ibazzarWash.price, 115000);
    assert.equal(ibazzarWash.rate, 15);
  });

  it("saves optional filter depths as separate rules and updates each path in place", async () => {
    const partner = "filter-levels";
    await Commission.deleteMany({ partner });
    const broadIds = { vendorId: ID.v1, brandId: ID.zilan, categoryId: ID.home };
    const midIds = { ...broadIds, subCategoryId: ID.kitchen };
    const createdBroad = await saveFilterCommission({ partner, ...broadIds, percentage: 10 });
    const updatedBroad = await saveFilterCommission({ partner, ...broadIds, percentage: 11 });
    assert.equal(String(createdBroad._id), String(updatedBroad._id));
    assert.equal(createdBroad.subCategoryId, null);
    assert.equal(createdBroad.collectionId, null);
    assert.equal(createdBroad.targetId, filterCommissionTargetId(broadIds));
    assert.equal(
      createdBroad.targetName.en,
      "ABC → Zilan → Home Appliances → All Sub-categories → All Collections"
    );

    const createdMid = await saveFilterCommission({ partner, ...midIds, percentage: 12 });
    const updatedMid = await saveFilterCommission({ partner, ...midIds, percentage: 13 });
    assert.equal(String(createdMid._id), String(updatedMid._id));
    assert.notEqual(String(createdMid._id), String(createdBroad._id));
    assert.equal(createdMid.subCategoryId, ID.kitchen);
    assert.equal(createdMid.collectionId, null);
    assert.equal(
      createdMid.targetName.en,
      "ABC → Zilan → Home Appliances → Kitchen Appliances → All Collections"
    );

    const createdExact = await saveFilterCommission({ partner, ...PATH, percentage: 15 });
    const updatedExact = await saveFilterCommission({ partner, ...PATH, percentage: 16 });
    assert.equal(String(createdExact._id), String(updatedExact._id));
    assert.equal(createdExact.collectionId, ID.fridge);
    assert.equal(createdExact.targetId, filterCommissionTargetId(PATH));
    assert.equal(
      createdExact.targetName.en,
      "ABC → Zilan → Home Appliances → Kitchen Appliances → Refrigerators"
    );
    assert.equal(await Commission.countDocuments({ partner, scope: "filter" }), 3);
    assert.equal(new Set([createdBroad.targetId, createdMid.targetId, createdExact.targetId]).size, 3);

    const broadDto = toAdminCommission(await Commission.findById(createdBroad._id));
    assert.deepEqual(selectionFromCommission(broadDto), {
      ...broadIds,
      subCategoryId: "",
      collectionId: "",
    });
    assert.equal(broadDto.filterPath.subCategory.en, "All Sub-categories");
    assert.equal(broadDto.filterPath.collection.en, "All Collections");
    assert.equal(broadDto.percentage, 11);
    assert.equal(filterFieldsEnabled(selectionFromCommission(broadDto)).collection, false);

    const midDto = toAdminCommission(await Commission.findById(createdMid._id));
    assert.equal(selectionFromCommission(midDto).subCategoryId, ID.kitchen);
    assert.equal(selectionFromCommission(midDto).collectionId, "");
    assert.equal(midDto.filterPath.subCategory.en, "Kitchen Appliances");
    assert.equal(midDto.filterPath.collection.en, "All Collections");
    assert.equal(midDto.percentage, 13);
    assert.equal(filterFieldsEnabled(selectionFromCommission(midDto)).collection, true);

    const exactDto = toAdminCommission(updatedExact);
    assert.deepEqual(selectionFromCommission(exactDto), PATH);
    assert.equal(exactDto.percentage, 16);

    updatedBroad.isActive = false;
    await updatedBroad.save();
    const reloaded = await Commission.findById(createdBroad._id).lean();
    assert.equal(reloaded.isActive, false);
    assert.equal(reloaded.subCategoryId, null);
    assert.equal(reloaded.collectionId, null);
    assert.equal(reloaded.targetId, filterCommissionTargetId(broadIds));
    await Commission.deleteMany({ partner });
  });

  it("applies 15 then 12 then 10 and keeps an existing five-part filter", async () => {
    const partner = "filter-rank";
    await Commission.deleteMany({ partner });
    const legacy = await Commission.collection.insertOne({
      partner,
      scope: "filter",
      targetId: filterCommissionTargetId(PATH),
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      subCategoryId: ID.kitchen,
      collectionId: ID.fridge,
      percentage: 15,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await saveFilterCommission({
      partner,
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      percentage: 10,
    });
    await saveFilterCommission({
      partner,
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      subCategoryId: ID.kitchen,
      percentage: 12,
    });
    await Commission.create({
      partner,
      scope: "brand",
      targetId: ID.zilan,
      targetName: NAME.zilan,
      percentage: 20,
      isActive: true,
    });
    const rules = await Commission.find({ partner });
    const load = (code) => Product.findOne({ itemCode: code });
    const fridge = await load("FC-FRIDGE");
    const wash = await load("FC-WASH");
    const dry = await load("FC-DRY");
    const phone = await load("FC-PHONE");
    assert.equal(resolveCommissionRate(fridge, rules), 15);
    assert.equal(resolveCommissionRate(wash, rules), 12);
    assert.equal(resolveCommissionRate(dry, rules), 10);
    assert.equal(resolveCommissionRate(phone, rules), 20);
    assert.equal(applyCommissionRate(fridge.price, 15), 115000);
    assert.notEqual(applyCommissionRate(fridge.price, 15), applyCommissionRate(fridge.price, 47));
    assert.equal(fridge.price, 100000);

    const updated = await saveFilterCommission({ partner, ...PATH, percentage: 15 });
    assert.equal(String(updated._id), String(legacy.insertedId));
    assert.equal(await Commission.countDocuments({ partner, scope: "filter" }), 3);

    updated.isActive = false;
    await updated.save();
    const after = await Commission.find({ partner });
    assert.equal(resolveCommissionRate(await load("FC-FRIDGE"), after), 12);
    assert.equal(applyCommissionRate(7001, 10), 7750);

    const broadMatch = commissionMatchFilter([
      {
        scope: "filter",
        vendorId: ID.v1,
        brandId: ID.zilan,
        categoryId: ID.home,
        isActive: true,
      },
    ]);
    const broadCodes = (await Product.find(broadMatch).select("itemCode")).map((row) => row.itemCode).sort();
    assert.deepEqual(broadCodes, ["FC-DRY", "FC-FRIDGE", "FC-FRIDGE-7001", "FC-WASH"]);
    const midMatch = commissionMatchFilter([
      {
        scope: "filter",
        vendorId: ID.v1,
        brandId: ID.zilan,
        categoryId: ID.home,
        subCategoryId: ID.kitchen,
        isActive: true,
      },
    ]);
    const midCodes = (await Product.find(midMatch).select("itemCode")).map((row) => row.itemCode).sort();
    assert.deepEqual(midCodes, ["FC-FRIDGE", "FC-FRIDGE-7001", "FC-WASH"]);
    const preview = filterPreviewParams({
      vendorId: ID.v1,
      brandId: ID.zilan,
      categoryId: ID.home,
      subCategoryId: "",
      collectionId: "",
    });
    assert.deepEqual(preview, { vendor: ID.v1, brand: ID.zilan, category: ID.home });
    const previewCodes = (
      await Product.find({
        "createdBy._id": preview.vendor,
        "brand._id": preview.brand,
        "category._id": preview.category,
      }).select("itemCode")
    )
      .map((row) => row.itemCode)
      .sort();
    assert.deepEqual(previewCodes, broadCodes);
    await Commission.deleteMany({ partner });
  });

  it("prices Miswag and Gini from the most specific optional filter", async () => {
    async function loadSpecific(partner) {
      await Commission.deleteMany({ partner });
      await saveFilterCommission({
        partner,
        vendorId: ID.v1,
        brandId: ID.zilan,
        categoryId: ID.home,
        percentage: 10,
      });
      await saveFilterCommission({
        partner,
        vendorId: ID.v1,
        brandId: ID.zilan,
        categoryId: ID.home,
        subCategoryId: ID.kitchen,
        percentage: 12,
      });
      await saveFilterCommission({ partner, ...PATH, percentage: 15 });
      await Commission.create({
        partner,
        scope: "brand",
        targetId: ID.zilan,
        targetName: NAME.zilan,
        percentage: 20,
        isActive: true,
      });
      await Commission.create({
        partner,
        scope: "all",
        targetId: "*",
        percentage: 5,
        isActive: true,
      });
      return Commission.find({ partner, isActive: { $ne: false } });
    }

    const giniRules = await loadSpecific("gini");
    const giniBook = await giniExportForPartner(await Partner.findOne({ slug: "gini" }));
    const giniRows = sheetRows(giniBook.workbook, "Sheet1");
    const giniPrice = (sku) => {
      const row = giniRows.find((item) => String(item[GINI_HEADERS[2]]) === sku);
      assert.ok(row, sku);
      return Number(row[GINI_HEADERS[3]]);
    };
    assert.equal(giniPrice("FC-FRIDGE"), 115000);
    assert.equal(giniPrice("FC-WASH"), 112000);
    assert.equal(giniPrice("FC-FRIDGE-7001"), 8250);
    assert.equal(giniPrice("FC-V2-FRIDGE"), 120000);
    assert.equal(giniPrice("FC-OTHER-FRIDGE"), 105000);
    assert.equal(resolveCommissionRate(await Product.findOne({ itemCode: "FC-DRY" }), giniRules), 10);
    assert.equal(resolveCommissionRate(await Product.findOne({ itemCode: "FC-PHONE" }), giniRules), 20);

    const miswagRules = await loadSpecific("miswag");
    const payloadFor = async (code) =>
      buildMiswagTestPayload(await Product.findOne({ itemCode: code }), {
        rules: miswagRules,
        categoryId: "L3-1",
        brandId: 9,
      });
    const fridge = await payloadFor("FC-FRIDGE");
    assert.equal(fridge.pricing.rate, 15);
    assert.equal(fridge.pricing.price, 115000);
    assert.equal(fridge.payload.price, 115000);
    assert.equal(fridge.payload.is_large, false);
    assert.equal(fridge.pricing.customPrice, false);
    const wash = await payloadFor("FC-WASH");
    assert.equal(wash.pricing.rate, 12);
    assert.equal(wash.payload.price, 112000);
    const dry = await payloadFor("FC-DRY");
    assert.equal(dry.pricing.rate, 10);
    assert.equal(dry.payload.price, 110000);
    const phone = await payloadFor("FC-PHONE");
    assert.equal(phone.pricing.rate, 20);
    assert.equal(phone.payload.price, 120000);
    assert.equal((await Product.findOne({ itemCode: "FC-FRIDGE" })).price, 100000);
    assert.equal((await Product.findOne({ itemCode: "FC-FRIDGE-7001" })).price, 7001);
    assert.equal(
      toPartnerProduct(await Product.findOne({ itemCode: "FC-WASH" }), miswagRules, "http://localhost").price,
      112000
    );

    const { workbook } = await buildCommissionWorkbook(
      await Partner.findOne({ slug: "elryan" }),
      await loadSpecific("elryan")
    );
    const rows = sheetRows(workbook, "Excel");
    const excel = (sku) => rows.find((item) => String(item.SKU) === sku);
    assert.equal(Number(excel("FC-FRIDGE").Price), 115000);
    assert.equal(Number(excel("FC-FRIDGE")["Commission %"]), 15);
    assert.equal(Number(excel("FC-WASH").Price), 112000);
    assert.equal(Number(excel("FC-WASH")["Commission %"]), 12);
  });
});
