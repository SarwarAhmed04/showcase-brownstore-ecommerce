import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanSyncOnePreview } from "./models/ElryanSyncOnePreview.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { Product } from "./models/Product.js";
import { setElryanFetch } from "./services/elryanClient.js";
import { previewElryanSyncOne } from "./services/elryanSyncOne.js";
import { evaluateElryanProductForSync } from "./services/elryanSyncAll.js";
import {
  listElryanWarrantyMappingPage,
  saveElryanBrandWarrantyMapping,
} from "./services/elryanWarrantyMapping.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import {
  collectElryanWarrantyRows,
  normalizeElryanWarrantyCatalog,
} from "./utils/elryanWarranty.js";
import {
  elryanWarrantyStorageKey,
  resolveElryanWarrantyFromRows,
} from "./utils/elryanWarrantyResolve.js";
import { elryanPlatformSectionEntries } from "../../client/src/utils/elryanCategoryMappingPage.js";
import {
  ELRYAN_WARRANTY_MAPPING_TAB,
  filterWarrantyBrands,
  officialWarrantiesForSearch,
  sharedWarrantyCounts,
  warrantyReview,
  warrantySaveReady,
} from "../../client/src/utils/elryanWarrantyMappingPage.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-warranty-mapping-test";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INGCO = "6ace1b33669f3bf0af2b55f2";
const TOTAL = "6ace1b33669f3bf0af2b55f3";
const KENWOOD = "6a7051ee6a1aacf1cc23be46";
const INGCO_CODE = "ingco-warranty";
const KENWOOD_CODE = "rlbo35igt4";
const API_KEY = "elryan-warranty-test-key";

function mockResponse(status, body = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "" },
    async text() {
      return text;
    },
  };
}

function warrantyBody(rows, meta) {
  return meta ? { data: rows, meta } : { data: rows };
}

function pageResult(status, body) {
  return {
    ok: status >= 200 && status < 300,
    httpStatus: status,
    json: body,
    message: status >= 200 && status < 300 ? "" : `HTTP ${status}`,
  };
}

describe("Elryan warranty list collection", () => {
  it("keeps a single response when pagination meta is absent", async () => {
    let calls = 0;
    const collected = await collectElryanWarrantyRows(async () => {
      calls += 1;
      return pageResult(200, warrantyBody([{ id: "w1", warranty_code: "INGCO-W", warranty_name: "INGCO Warranty" }]));
    });
    assert.equal(calls, 1);
    assert.equal(collected.pagination.mode, "single_response");
    assert.equal(collected.pagination.reason, "meta_absent");
    assert.equal(collected.pagination.complete, true);
    assert.equal(collected.rows.length, 1);
  });

  it("follows meta.total across pages and keeps supplied duration, terms, and status", async () => {
    const calls = [];
    const collected = await collectElryanWarrantyRows(async (query) => {
      calls.push(query || null);
      if (!query) {
        return pageResult(
          200,
          warrantyBody(
            [
              {
                id: "w1",
                warranty_code: INGCO_CODE,
                warranty_name: "INGCO Warranty",
                duration: "12",
                duration_unit: "months",
                terms: "Official INGCO terms",
                status: "active",
              },
            ],
            { page: 1, limit: 1, total: 2 }
          )
        );
      }
      assert.equal(query.page, 2);
      assert.equal(query.limit, 1);
      return pageResult(
        200,
        warrantyBody(
          [{ id: "w2", warranty_code: KENWOOD_CODE, warranty_name: "waranty kenwood" }],
          { page: 2, limit: 1, total: 2 }
        )
      );
    });
    assert.equal(calls.length, 2);
    assert.equal(collected.pagination.mode, "paged");
    assert.equal(collected.pagination.reason, "total_reached");
    assert.equal(collected.pagination.complete, true);
    const catalog = normalizeElryanWarrantyCatalog(collected.rows, 200);
    assert.deepEqual(catalog.codes, [INGCO_CODE, KENWOOD_CODE]);
    assert.equal(catalog.items[0].duration, "12 months");
    assert.equal(catalog.items[0].terms, "Official INGCO terms");
    assert.equal(catalog.items[0].status, "active");
    assert.equal(catalog.items[1].duration, null);
    const officialShape = normalizeElryanWarrantyCatalog(
      [
        {
          warranty_code: "rlbo35igt4",
          warranty_name: "waranty kenwood",
          warranty_provided: true,
          warranty_period: 1,
          warranty_period_type: "Years",
          return_policy: "Returns allowed within 7 days",
          description: "test description",
          warranted_provider: "test title",
          warranty_details_url: "",
        },
      ],
      200
    );
    assert.equal(officialShape.items[0].id, "");
    assert.equal(officialShape.items[0].duration, "1 Years");
    assert.equal(officialShape.items[0].terms, "test description");
    assert.equal(officialShape.items[0].returnPolicy, "Returns allowed within 7 days");
    assert.equal(officialShape.items[0].provider, "test title");
    assert.equal(officialShape.items[0].detailsUrl, null);
    assert.equal(officialShape.items[0].status, "provided");
    assert.equal(catalog.items[1].terms, null);
    assert.equal(catalog.items[1].status, null);
  });

  it("treats a repeated next page as the accessible list and rejects an empty next page", async () => {
    const repeated = await collectElryanWarrantyRows(async (query) =>
      pageResult(
        200,
        warrantyBody([{ warranty_code: "ONLY", warranty_name: "Only" }], {
          page: query?.page || 1,
          limit: 1,
          total: 4,
        })
      )
    );
    assert.equal(repeated.pagination.reason, "repeated_page");
    assert.equal(repeated.rows.length, 1);

    await assert.rejects(
      () =>
        collectElryanWarrantyRows(async (query) => {
          if (!query) {
            return pageResult(200, warrantyBody([{ warranty_code: "A", warranty_name: "A" }], { page: 1, limit: 1, total: 2 }));
          }
          return pageResult(200, warrantyBody([], { page: 2, limit: 1, total: 2 }));
        }),
      (error) => error.code === "warranty_list_incomplete"
    );
  });

  it("does not treat a failed request as an empty warranty list", async () => {
    await assert.rejects(
      () => collectElryanWarrantyRows(async () => pageResult(503, { message: "down" })),
      (error) => {
        assert.equal(error.code, "warranty_list_failed");
        assert.equal(error.httpStatus, 503);
        return true;
      }
    );
    const empty = normalizeElryanWarrantyCatalog([], 200);
    assert.equal(empty.empty, true);
    assert.equal(empty.checked, true);
    assert.equal(empty.codes.length, 0);
  });
});

describe("Elryan warranty mapping page helpers", () => {
  const brands = [
    {
      brownKey: INGCO,
      brownLabel: "INGCO",
      brandMapping: { mapped: true, elryanId: "10104", elryanLabel: "ingco" },
      warranty: { code: INGCO_CODE, label: "INGCO Warranty" },
    },
    {
      brownKey: TOTAL,
      brownLabel: "TOTAL",
      brandMapping: { mapped: false, elryanId: "", elryanLabel: "" },
      warranty: null,
    },
  ];

  it("searches by brand or warranty and filters mapped brands", () => {
    assert.equal(filterWarrantyBrands(brands, { q: "total" }).length, 1);
    assert.equal(filterWarrantyBrands(brands, { q: INGCO_CODE })[0].brownKey, INGCO);
    assert.equal(filterWarrantyBrands(brands, { q: "10104" })[0].brownLabel, "INGCO");
    assert.equal(filterWarrantyBrands(brands, { status: "unmapped" }).length, 1);
    assert.equal(filterWarrantyBrands(brands, { status: "mapped" })[0].brownKey, INGCO);
  });

  it("keeps the official list visible for a brand search that matches no warranty text", () => {
    const items = [{ code: KENWOOD_CODE, name: "waranty kenwood" }];
    assert.equal(officialWarrantiesForSearch(items, TOTAL).length, 1);
    assert.equal(officialWarrantiesForSearch(items, "kenwood")[0].code, KENWOOD_CODE);
  });

  it("requires coverage confirmation and a separate overwrite confirmation", () => {
    assert.equal(warrantySaveReady({ brandId: INGCO, code: INGCO_CODE, confirmCoverage: true, catalogOk: true }), true);
    assert.equal(warrantySaveReady({ brandId: INGCO, code: INGCO_CODE, confirmCoverage: false, catalogOk: true }), false);
    assert.equal(
      warrantySaveReady({
        brandId: INGCO,
        code: "other",
        confirmCoverage: true,
        needsOverwrite: true,
        confirmOverwrite: false,
        catalogOk: true,
      }),
      false
    );
    const review = warrantyReview({
      brand: brands[0],
      warranty: { code: "other-code", name: "Other" },
    });
    assert.equal(review.replaces, INGCO_CODE);
    assert.equal(sharedWarrantyCounts(brands).get(INGCO_CODE), 1);
  });

  it("adds a Warranty Mapping sidebar item without removing the other Elryan sections", () => {
    const ids = elryanPlatformSectionEntries().map(([id]) => id);
    assert.equal(ids.includes(ELRYAN_WARRANTY_MAPPING_TAB), true);
    assert.equal(ids.includes("elryanAttributes"), true);
    assert.equal(ids.includes("elryanDimensionsMapping"), true);
    assert.equal(ids.includes("syncOne"), true);
    assert.equal(ids.includes("syncAll"), true);
    const host = fs.readFileSync(path.join(root, "client/src/components/admin/platform/elryanPlatformHost.jsx"), "utf8");
    assert.match(host, /tab === "elryanWarrantyMapping"/);
    assert.match(host, /<ElryanWarrantyMapping t=\{t\} lang=\{lang\} \/>/);
    const ui = fs.readFileSync(path.join(root, "client/src/components/admin/platform/ElryanWarrantyMapping.jsx"), "utf8");
    assert.match(ui, /data-elryan-warranty-page="true"/);
    const service = fs.readFileSync(path.join(root, "server/src/services/elryanWarrantyMapping.js"), "utf8");
    assert.equal(/Product\.(update|findOneAndUpdate|create|delete|bulkWrite)/.test(service), false);
    assert.equal(service.includes("ElryanConfirmedSend.create"), false);
    assert.equal(service.includes('method: "POST"'), false);
    assert.equal(service.includes("batchCreate"), false);
    const syncAll = fs.readFileSync(path.join(root, "server/src/services/elryanSyncAll.js"), "utf8");
    assert.match(syncAll, /collectElryanWarrantyRows/);
    assert.match(syncAll, /resolveElryanWarrantyFromRows/);
  });
});

describe("Elryan brand warranty mapping", () => {
  let memory;
  const calls = [];

  function installFetch() {
    calls.length = 0;
    setElryanFetch(async (url, options = {}) => {
      const target = String(url);
      const method = String(options.method || "GET").toUpperCase();
      calls.push(`${method} ${target}`);
      assert.equal(target.includes("://marketplace-api.elryan.com"), false);
      if (method !== "GET") return mockResponse(500, { message: "product write blocked" });
      if (!target.includes("/v1/warranty")) return mockResponse(404, { message: "unexpected" });
      return mockResponse(200, {
        data: [
          {
            id: "w-ingco",
            warranty_code: INGCO_CODE,
            warranty_name: "INGCO Warranty",
            duration: "12",
            duration_unit: "months",
            terms: "Official INGCO terms",
            status: "active",
          },
          { id: "w-kenwood", warranty_code: KENWOOD_CODE, warranty_name: "waranty kenwood" },
          { id: "w-product", warranty_code: "PRODUCT-CODE", warranty_name: "Product warranty" },
        ],
      });
    });
  }

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-warranty-mapping"));
  });

  after(async () => {
    setElryanFetch(null);
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    installFetch();
    await Promise.all([
      Product.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      ElryanConnection.deleteMany({}),
      ElryanSyncOnePreview.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
    ]);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
    });
    await Product.create([
      {
        ibsherId: "ibs-ingco",
        itemCode: "INGCO-1",
        name: { en: "INGCO Drill" },
        price: 25000,
        brand: { _id: INGCO, name: { en: "INGCO" } },
        warranty: { duration: 1, unit: "years", description: "" },
      },
      {
        ibsherId: "ibs-total",
        itemCode: "TOTAL-1",
        name: { en: "TOTAL Drill" },
        price: 20000,
        brand: { _id: TOTAL, name: { en: "TOTAL" } },
        warranty: { duration: 1, unit: "years", description: "" },
      },
      {
        ibsherId: "ibs-kenwood",
        itemCode: "OWCH180002",
        name: { en: "Food Chopper" },
        price: 50000,
        brand: { _id: KENWOOD, name: { en: "Kenwood" } },
        warranty: { duration: 1, unit: "years", description: "" },
      },
    ]);
    await ElryanValueMapping.create({
      kind: "warranty",
      brownKey: elryanWarrantyStorageKey({ environment: "staging", scope: "brand", subject: KENWOOD }),
      environment: "staging",
      warrantyScope: "brand",
      elryanCode: KENWOOD_CODE,
      elryanLabel: "waranty kenwood",
      brownLabel: "Kenwood",
    });
    await ElryanValueMapping.create({
      kind: "brand",
      brownKey: `staging:${INGCO}`,
      environment: "staging",
      elryanId: "10104",
      elryanLabel: "ingco",
      brownLabel: "INGCO",
    });
  });

  it("shows brand mapping status, the Kenwood warranty, and an empty list separately from a failed request", async () => {
    const page = await listElryanWarrantyMappingPage();
    assert.equal(page.environment, "staging");
    assert.equal(page.autoAssigned, false);
    assert.equal(page.nameMatchApplied, false);
    assert.equal(page.warranties.failed, false);
    assert.equal(page.warranties.empty, false);
    assert.equal(page.warranties.items.length, 3);
    assert.equal(page.writes.productPostCalled, false);
    const kenwood = page.brands.find((row) => row.brownKey === KENWOOD);
    const ingco = page.brands.find((row) => row.brownKey === INGCO);
    assert.equal(kenwood.warranty.code, KENWOOD_CODE);
    assert.equal(kenwood.warranty.verified, true);
    assert.equal(ingco.warranty, null);
    assert.equal(ingco.brandMapping.mapped, true);
    assert.equal(ingco.brandMapping.elryanId, "10104");
    assert.equal(calls.every((line) => line.startsWith("GET ")), true);

    setElryanFetch(async () => mockResponse(200, { data: [] }));
    const empty = await listElryanWarrantyMappingPage();
    assert.equal(empty.warranties.ok, true);
    assert.equal(empty.warranties.empty, true);
    assert.equal(empty.warranties.failed, false);
    assert.equal(empty.warranties.items.length, 0);
    assert.equal(empty.brands.length, 3);

    setElryanFetch(async () => mockResponse(503, { message: "warranty down" }));
    const failed = await listElryanWarrantyMappingPage();
    assert.equal(failed.warranties.ok, false);
    assert.equal(failed.warranties.failed, true);
    assert.equal(failed.warranties.empty, false);
    assert.equal(failed.warranties.items.length, 0);
    assert.equal(failed.brands.some((row) => row.brownKey === KENWOOD), true);
    installFetch();
  });

  it("maps many brands to one official warranty and reads the row back", async () => {
    const ingco = await saveElryanBrandWarrantyMapping({
      brownKey: INGCO,
      elryanCode: INGCO_CODE,
      confirmCoverage: true,
    });
    assert.equal(ingco.readBack.ok, true);
    assert.equal(ingco.readBack.elryanCode, INGCO_CODE);
    assert.equal(ingco.readBack.brownKey, `staging:brand:${INGCO}`);
    assert.equal(ingco.readBack.environment, "staging");
    assert.equal(ingco.readBack.warrantyScope, "brand");
    assert.equal(ingco.official.duration, "12 months");
    assert.equal(ingco.official.terms, "Official INGCO terms");
    assert.equal(ingco.productPostCalled, false);

    const total = await saveElryanBrandWarrantyMapping({
      brownKey: TOTAL,
      elryanCode: INGCO_CODE,
      confirmCoverage: true,
    });
    assert.equal(total.readBack.elryanCode, INGCO_CODE);
    assert.notEqual(total.readBack.brownKey, ingco.readBack.brownKey);

    const rows = await ElryanValueMapping.find({ kind: "warranty", environment: "staging", warrantyScope: "brand" }).lean();
    assert.equal(rows.filter((row) => row.elryanCode === INGCO_CODE).length, 2);
    const kenwood = rows.find((row) => row.brownKey.endsWith(KENWOOD));
    assert.equal(kenwood.elryanCode, KENWOOD_CODE);

    const ingcoProduct = await Product.findOne({ ibsherId: "ibs-ingco" }).lean();
    assert.deepEqual(ingcoProduct.warranty, { duration: 1, unit: "years", description: "" });
    const resolvedIngco = resolveElryanWarrantyFromRows(rows, { environment: "staging", brandId: INGCO });
    const resolvedTotal = resolveElryanWarrantyFromRows(rows, { environment: "staging", brandId: TOTAL });
    const resolvedProduction = resolveElryanWarrantyFromRows(rows, { environment: "production", brandId: INGCO });
    assert.equal(resolvedIngco.mapping.elryanCode, INGCO_CODE);
    assert.equal(resolvedTotal.mapping.elryanCode, INGCO_CODE);
    assert.equal(resolvedProduction.mapping, null);
  });

  it("refuses a name, an unknown code, a missing confirmation, and an unconfirmed overwrite", async () => {
    await assert.rejects(
      () => saveElryanBrandWarrantyMapping({ brownKey: "INGCO", elryanCode: INGCO_CODE, confirmCoverage: true }),
      (error) => error.code === "unknown_brand"
    );
    await assert.rejects(
      () => saveElryanBrandWarrantyMapping({ brownKey: INGCO, elryanCode: "INGCO Warranty", confirmCoverage: true }),
      (error) => error.code === "invalid_warranty_code"
    );
    await assert.rejects(
      () => saveElryanBrandWarrantyMapping({ brownKey: INGCO, elryanCode: INGCO_CODE, confirmCoverage: false }),
      (error) => error.code === "coverage_confirmation_required"
    );
    await saveElryanBrandWarrantyMapping({ brownKey: INGCO, elryanCode: INGCO_CODE, confirmCoverage: true });
    await assert.rejects(
      () =>
        saveElryanBrandWarrantyMapping({
          brownKey: INGCO,
          elryanCode: KENWOOD_CODE,
          confirmCoverage: true,
          confirmOverwrite: false,
        }),
      (error) => error.code === "overwrite_confirmation_required"
    );
    const unchanged = await ElryanValueMapping.findOne({ brownKey: `staging:brand:${INGCO}` }).lean();
    assert.equal(unchanged.elryanCode, INGCO_CODE);
    const replaced = await saveElryanBrandWarrantyMapping({
      brownKey: INGCO,
      elryanCode: KENWOOD_CODE,
      confirmCoverage: true,
      confirmOverwrite: true,
    });
    assert.equal(replaced.readBack.elryanCode, KENWOOD_CODE);
    const kenwood = await ElryanValueMapping.findOne({ brownKey: `staging:brand:${KENWOOD}` }).lean();
    assert.equal(kenwood.elryanCode, KENWOOD_CODE);
  });

  it("resolves the brand warranty in Sync One and Sync All, keeps a product override, and expires stale previews", async () => {
    const ingco = await Product.findOne({ ibsherId: "ibs-ingco" }).lean();
    const total = await Product.findOne({ ibsherId: "ibs-total" }).lean();
    const beforePreview = await previewElryanSyncOne({ productId: ingco._id });
    assert.equal(beforePreview.proposedPayload.warrantyCode, undefined);
    assert.equal(beforePreview.blockers.some((item) => item.code === "missing_warranty_mapping"), true);
    const totalPreview = await previewElryanSyncOne({ productId: total._id });
    const confirmed = await ElryanConfirmedSend.create({
      environment: "staging",
      productId: String(ingco._id),
      sku: "INGCO-1",
      payloadHash: "confirmed-hash",
      elryanProductId: "elr-1",
      httpStatus: 200,
      confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await saveElryanBrandWarrantyMapping({
      brownKey: INGCO,
      elryanCode: INGCO_CODE,
      confirmCoverage: true,
    });
    const expired = await ElryanSyncOnePreview.findOne({ productId: String(ingco._id) }).lean();
    assert.ok(expired.expiresAt.getTime() <= Date.now());
    const untouched = await ElryanSyncOnePreview.findOne({ productId: String(total._id) }).lean();
    assert.ok(untouched.expiresAt.getTime() > Date.now());
    const ledger = await ElryanConfirmedSend.findById(confirmed._id).lean();
    assert.equal(ledger.payloadHash, "confirmed-hash");
    assert.equal(ledger.elryanProductId, "elr-1");
    assert.equal(String(ledger.confirmedAt.toISOString()), "2026-01-01T00:00:00.000Z");

    const afterPreview = await previewElryanSyncOne({ productId: ingco._id });
    assert.equal(afterPreview.warranty.source, "brand");
    assert.equal(afterPreview.warranty.elryanCode, INGCO_CODE);
    assert.equal(afterPreview.proposedPayload.warrantyCode, INGCO_CODE);
    assert.equal(afterPreview.blockers.some((item) => item.code === "missing_warranty_mapping"), false);
    assert.equal(afterPreview.blockers.some((item) => item.code === "warranty_unverified"), false);
    const fresh = await ElryanSyncOnePreview.find({
      productId: String(ingco._id),
      expiresAt: { $gt: new Date() },
    }).lean();
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].payloadHash, expired.payloadHash);

    await ElryanValueMapping.create({
      kind: "warranty",
      brownKey: "staging:product:2-year",
      environment: "staging",
      warrantyScope: "product",
      elryanCode: "PRODUCT-CODE",
      elryanLabel: "Product warranty",
    });
    await Product.updateOne({ _id: ingco._id }, { $set: { warranty: { code: "2-year", duration: 1, unit: "years" } } });
    const overridePreview = await previewElryanSyncOne({ productId: ingco._id });
    assert.equal(overridePreview.warranty.source, "product");
    assert.equal(overridePreview.proposedPayload.warrantyCode, "PRODUCT-CODE");

    const rows = await ElryanValueMapping.find({ kind: "warranty" }).lean();
    const catalog = normalizeElryanWarrantyCatalog(
      [
        { warranty_code: INGCO_CODE, warranty_name: "INGCO Warranty" },
        { warranty_code: "PRODUCT-CODE", warranty_name: "Product warranty" },
      ],
      200
    );
    const context = {
      environment: "staging",
      config: { hasApiKey: true, environment: "staging" },
      rules: [],
      eligibility: { partnerActive: true },
      brandRows: [],
      colorRows: [],
      warrantyRows: rows,
      warrantyCatalog: catalog,
      categoryIndex: new Map(),
      attributeSets: new Map(),
      collectionDimensions: new Map(),
    };
    const ingcoDoc = await Product.findById(ingco._id).lean();
    const totalDoc = await Product.findById(total._id).lean();
    const synced = await evaluateElryanProductForSync(ingcoDoc, context);
    const unmapped = await evaluateElryanProductForSync(totalDoc, context);
    assert.equal(synced.blockerCodes.includes("missing_warranty_mapping"), false);
    assert.equal(synced.blockerCodes.includes("warranty_unverified"), false);
    assert.equal(unmapped.blockerCodes.includes("missing_warranty_mapping"), true);
    assert.equal(calls.some((line) => line.startsWith("POST") || line.startsWith("PATCH") || line.startsWith("PUT")), false);
  });

  it("does not read or save warranties while the connection is Production", async () => {
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });
    calls.length = 0;
    await assert.rejects(() => listElryanWarrantyMappingPage(), (error) => error.code === "production_isolated");
    await assert.rejects(
      () => saveElryanBrandWarrantyMapping({ brownKey: INGCO, elryanCode: INGCO_CODE, confirmCoverage: true }),
      (error) => error.code === "production_isolated"
    );
    assert.equal(calls.length, 0);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "warranty" }), 1);
    const kenwood = await ElryanValueMapping.findOne({ kind: "warranty" }).lean();
    assert.equal(kenwood.elryanCode, KENWOOD_CODE);
    assert.equal(kenwood.environment, "staging");
  });
});
