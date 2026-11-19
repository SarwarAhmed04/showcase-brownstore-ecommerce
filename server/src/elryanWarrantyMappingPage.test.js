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
  mergeVisibleBrandSnapshots,
  mergeWarrantySaveOutcomes,
  officialWarrantiesForSearch,
  removeWarrantyBrand,
  saveSelectedWarrantyBrands,
  sharedWarrantyCounts,
  toggleWarrantyBrand,
  warrantyBatchReview,
  warrantyMappingDescription,
  warrantyReadBackVerified,
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
    assert.equal(
      warrantySaveReady({ brandIds: [INGCO], code: INGCO_CODE, confirmCoverage: true, catalogOk: true, replacements: [] }),
      true
    );
    assert.equal(
      warrantySaveReady({ brandIds: [INGCO], code: INGCO_CODE, confirmCoverage: false, catalogOk: true, replacements: [] }),
      false
    );
    assert.equal(
      warrantySaveReady({
        brandIds: [INGCO, TOTAL],
        code: "other",
        confirmCoverage: true,
        replacements: [INGCO_CODE],
        confirmOverwrite: false,
        catalogOk: true,
      }),
      false
    );
    const review = warrantyBatchReview({
      brands,
      warranty: { code: "other-code", name: "Other", duration: "12 months", terms: "Official terms" },
    });
    assert.equal(review.brands.find((row) => row.brownKey === INGCO).replaces, INGCO_CODE);
    assert.equal(review.brands.find((row) => row.brownKey === TOTAL).replaces, "");
    assert.equal(review.duration, "12 months");
    assert.equal(sharedWarrantyCounts(brands).get(INGCO_CODE), 1);
  });

  it("keeps a multi-brand selection across searches and does not describe Production as Staging", () => {
    const extra = ["6ace1b33669f3bf0af2b55f4", "6ace1b33669f3bf0af2b55f5", "6ace1b33669f3bf0af2b55f6", "6ace1b33669f3bf0af2b55f7"];
    const catalog = [
      ...brands,
      ...extra.map((id, index) => ({
        brownKey: id,
        brownLabel: `Brand ${index + 1}`,
        warranty: index === 0 ? { code: "old-code", label: "Old" } : null,
      })),
    ];
    let selected = new Map();
    for (const row of filterWarrantyBrands(catalog, { q: "ingco" })) selected = toggleWarrantyBrand(selected, row);
    for (const row of filterWarrantyBrands(catalog, { q: "brand 2" })) selected = toggleWarrantyBrand(selected, row);
    for (const row of catalog.filter((row) => row.brownLabel === "Brand 3" || row.brownLabel === "Brand 4")) {
      selected = toggleWarrantyBrand(selected, row);
    }
    selected = toggleWarrantyBrand(selected, catalog.find((row) => row.brownKey === extra[0]));
    assert.equal(selected.size, 5);
    selected = mergeVisibleBrandSnapshots(selected, filterWarrantyBrands(catalog, { q: "brand 2" }));
    assert.equal(selected.size, 5);
    assert.equal(selected.has(INGCO), true);
    const removed = removeWarrantyBrand(selected, extra[1]);
    assert.equal(removed.has(extra[1]), false);
    assert.equal(removed.size, 4);
    assert.equal(selected.has(extra[1]), true);
    const review = warrantyBatchReview({
      brands: [...selected.values()],
      warranty: { code: INGCO_CODE, name: "INGCO Warranty" },
    });
    assert.equal(review.brands.find((row) => row.brownKey === extra[0]).replaces, "old-code");
    assert.equal(
      warrantySaveReady({
        brandIds: [...selected.keys()],
        code: INGCO_CODE,
        confirmCoverage: true,
        replacements: review.brands.map((row) => row.replaces),
        confirmOverwrite: false,
        catalogOk: true,
      }),
      false
    );

    const staleProduction = warrantyMappingDescription(
      "production",
      "Map each BrownStore brand to one official Elryan Staging warranty. Several brands may share one warranty. Nothing is saved until you review and confirm."
    );
    assert.equal(staleProduction.includes("Staging"), false);
    assert.match(staleProduction, /Elryan Production warranty/);
    const active = warrantyMappingDescription("production");
    assert.match(active, /Elryan Production warranty/);
    assert.equal(warrantyMappingDescription("staging").includes("{environment}"), false);
    assert.match(warrantyMappingDescription("staging"), /Elryan Staging warranty/);
    const ui = fs.readFileSync(path.join(root, "client/src/components/admin/platform/ElryanWarrantyMapping.jsx"), "utf8");
    const i18n = fs.readFileSync(path.join(root, "client/src/i18n.js"), "utf8");
    assert.equal(ui.includes("Elryan Staging warranty"), false);
    assert.equal(i18n.includes("Elryan Staging warranty"), false);
    assert.match(ui, /warrantyMappingDescription\(/);
    assert.match(ui, /removeWarrantyBrand\(/);
    assert.equal(ui.includes("deleteElryanValueMapping"), false);
  });

  it("confirms only read-back matches and retries the failed brands", async () => {
    const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
    const rows = ids.map((id) => ({
      brownKey: id,
      brownLabel: id.toUpperCase(),
      warranty: id === "b2" ? { code: "other-code" } : null,
    }));
    const calls = [];
    const first = await saveSelectedWarrantyBrands({
      brands: rows,
      warrantyCode: INGCO_CODE,
      environment: "staging",
      confirmOverwrite: true,
      save: async (body) => {
        calls.push(body.brownKey);
        assert.equal(body.confirmCoverage, true);
        assert.equal(body.elryanCode, INGCO_CODE);
        if (body.brownKey === "b2") assert.equal(body.confirmOverwrite, true);
        if (body.brownKey === "b1") assert.equal(body.confirmOverwrite, false);
        if (body.brownKey === "b3") {
          const error = new Error("warranty down");
          error.code = "warranty_list_failed";
          throw error;
        }
        if (body.brownKey === "b4") {
          return { readBack: { ok: true, elryanCode: "other", brownKey: `staging:brand:${body.brownKey}`, environment: "staging", warrantyScope: "brand" } };
        }
        return {
          readBack: {
            ok: true,
            elryanCode: INGCO_CODE,
            brownKey: `staging:brand:${body.brownKey}`,
            environment: "staging",
            warrantyScope: "brand",
          },
        };
      },
    });
    assert.deepEqual(calls, ids);
    assert.deepEqual(first.confirmed.map((row) => row.brownKey), ["b1", "b2", "b5", "b6"]);
    assert.equal(first.confirmed.every((row) => warrantyReadBackVerified(row.readBack, { brownKey: row.brownKey, code: INGCO_CODE, environment: "staging" })), true);
    assert.deepEqual(first.retryBrandIds, ["b3", "b4"]);
    assert.equal(first.failed.find((row) => row.brownKey === "b3").message, "warranty down");
    assert.equal(first.failed.find((row) => row.brownKey === "b4").code, "warranty_read_back_failed");
    assert.equal(warrantyReadBackVerified(first.failed.find((row) => row.brownKey === "b4"), { brownKey: "b4", code: INGCO_CODE }), false);

    const retryCalls = [];
    const retry = await saveSelectedWarrantyBrands({
      brands: rows.filter((row) => first.retryBrandIds.includes(row.brownKey)),
      warrantyCode: INGCO_CODE,
      environment: "staging",
      confirmOverwrite: false,
      save: async (body) => {
        retryCalls.push(body.brownKey);
        return {
          readBack: {
            ok: true,
            elryanCode: INGCO_CODE,
            brownKey: `staging:brand:${body.brownKey}`,
            environment: "staging",
            warrantyScope: "brand",
          },
        };
      },
    });
    assert.deepEqual(retryCalls, ["b3", "b4"]);
    const merged = mergeWarrantySaveOutcomes(first, retry);
    assert.equal(merged.confirmed.length, 6);
    assert.equal(merged.failed.length, 0);
  });

  it("adds a Warranty Mapping sidebar item without removing the other Elryan sections", () => {
    const ids = elryanPlatformSectionEntries().map(([id]) => id);
    assert.equal(ids.includes(ELRYAN_WARRANTY_MAPPING_TAB), true);
    assert.equal(ids.includes("elryanBrandMapping"), true);
    assert.equal(ids.includes("elryanColourMapping"), true);
    assert.equal(ids.includes("elryanAttributes"), false);
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

  it("keeps a Production warranty mapping separate from the Staging brand default", async () => {
    await ElryanConnection.updateOne(
      { singletonKey: "default" },
      { $set: { environment: "production", productionApiKeyEnc: encryptApiKey(API_KEY) } }
    );
    calls.length = 0;
    const page = await listElryanWarrantyMappingPage();
    assert.equal(page.environment, "production");
    assert.equal(page.fresh, true);
    assert.equal(calls.some((line) => line.includes("/v1/warranty") && line.includes("fresh=true")), true);
    assert.equal(page.brands.find((row) => row.brownKey === KENWOOD)?.warranty, null);
    const saved = await saveElryanBrandWarrantyMapping({
      brownKey: INGCO,
      elryanCode: INGCO_CODE,
      confirmCoverage: true,
    });
    assert.equal(saved.environment, "production");
    assert.equal(saved.readBack.elryanCode, INGCO_CODE);
    const rows = await ElryanValueMapping.find({ kind: "warranty" }).lean();
    assert.equal(rows.filter((row) => row.environment === "staging" && row.elryanCode === KENWOOD_CODE).length, 1);
    assert.equal(rows.filter((row) => row.environment === "production" && row.elryanCode === INGCO_CODE).length, 1);
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "staging" } });
    const staging = await listElryanWarrantyMappingPage();
    assert.equal(staging.environment, "staging");
    assert.equal(staging.brands.find((row) => row.brownKey === INGCO)?.warranty, null);
    assert.equal(staging.brands.find((row) => row.brownKey === KENWOOD)?.warranty?.code, KENWOOD_CODE);
  });

  it("saves one official warranty for five brands, reports a conflict, and reloads the saved counts", async () => {
    const bosch = "6ace1b33669f3bf0af2b55f4";
    const makita = "6ace1b33669f3bf0af2b55f5";
    await Product.create([
      {
        ibsherId: "ibs-bosch",
        itemCode: "BOSCH-1",
        name: { en: "Bosch Drill" },
        price: 30000,
        brand: { _id: bosch, name: { en: "Bosch" } },
        warranty: { duration: 2, unit: "years", description: "Bosch product terms" },
      },
      {
        ibsherId: "ibs-makita",
        itemCode: "MAKITA-1",
        name: { en: "Makita Drill" },
        price: 32000,
        brand: { _id: makita, name: { en: "Makita" } },
        warranty: { duration: 1, unit: "years", description: "" },
      },
    ]);
    await ElryanValueMapping.create({
      kind: "warranty",
      brownKey: "staging:product:2-year",
      environment: "staging",
      warrantyScope: "product",
      elryanCode: "PRODUCT-CODE",
      elryanLabel: "Product warranty",
    });

    let selected = new Map();
    for (const query of [{ status: "mapped" }, { status: "unmapped" }, { q: "bosch" }, { q: "makita" }, { q: "total" }]) {
      const listed = await listElryanWarrantyMappingPage(query);
      assert.equal(listed.brands.length > 0, true);
      for (const row of listed.brands) {
        if (!selected.has(row.brownKey)) selected = toggleWarrantyBrand(selected, row);
      }
    }
    assert.equal(selected.size, 5);
    const boschOnly = await listElryanWarrantyMappingPage({ q: "bosch", page: 1 });
    const makitaOnly = await listElryanWarrantyMappingPage({ q: "makita", page: 1 });
    assert.equal(boschOnly.brands.length, 1);
    assert.equal(makitaOnly.brands.length, 1);
    assert.equal(boschOnly.brands.some((row) => row.brownKey === INGCO), false);
    selected = mergeVisibleBrandSnapshots(selected, boschOnly.brands);
    selected = mergeVisibleBrandSnapshots(selected, makitaOnly.brands);
    assert.equal(selected.size, 5);
    assert.equal(selected.get(bosch).brownLabel, "Bosch");
    assert.equal(selected.get(KENWOOD).warranty.code, KENWOOD_CODE);

    const removed = removeWarrantyBrand(selected, TOTAL);
    assert.equal(removed.has(TOTAL), false);
    const kenwoodBefore = await ElryanValueMapping.findOne({ brownKey: `staging:brand:${KENWOOD}` }).lean();
    assert.equal(kenwoodBefore.elryanCode, KENWOOD_CODE);
    selected = toggleWarrantyBrand(removed, selected.get(TOTAL));

    const beforeProducts = await Product.find().sort({ ibsherId: 1 }).lean();
    const first = await saveSelectedWarrantyBrands({
      brands: [...selected.values()],
      warrantyCode: INGCO_CODE,
      environment: "staging",
      confirmOverwrite: false,
      save: (body) => saveElryanBrandWarrantyMapping(body),
    });
    assert.deepEqual(
      first.confirmed.map((row) => row.brownKey).sort(),
      [INGCO, TOTAL, bosch, makita].sort()
    );
    assert.deepEqual(first.retryBrandIds, [KENWOOD]);
    assert.equal(first.failed[0].code, "overwrite_confirmation_required");
    assert.equal(first.failed[0].message.includes(KENWOOD) || first.failed[0].brownKey === KENWOOD, true);
    assert.equal(
      first.confirmed.every((row) =>
        warrantyReadBackVerified(row.readBack, { brownKey: row.brownKey, code: INGCO_CODE, environment: "staging" })
      ),
      true
    );

    const reloaded = await listElryanWarrantyMappingPage();
    assert.equal(reloaded.counts.brands, 5);
    assert.equal(reloaded.counts.mapped, 5);
    assert.equal(reloaded.sharedWarrantyCounts[INGCO_CODE], 4);
    assert.equal(reloaded.sharedWarrantyCounts[KENWOOD_CODE], 1);
    assert.equal(reloaded.brands.find((row) => row.brownKey === KENWOOD).warranty.code, KENWOOD_CODE);
    assert.equal(reloaded.environment, "staging");

    const retry = await saveSelectedWarrantyBrands({
      brands: [...selected.values()].filter((brand) => first.retryBrandIds.includes(brand.brownKey)),
      warrantyCode: INGCO_CODE,
      environment: "staging",
      confirmOverwrite: true,
      save: (body) => saveElryanBrandWarrantyMapping(body),
    });
    assert.deepEqual(retry.retryBrandIds, []);
    assert.equal(retry.confirmed.length, 1);
    assert.equal(warrantyReadBackVerified(retry.confirmed[0].readBack, { brownKey: KENWOOD, code: INGCO_CODE, environment: "staging" }), true);
    const merged = mergeWarrantySaveOutcomes(first, retry);
    assert.equal(merged.confirmed.length, 5);
    assert.equal(merged.failed.length, 0);

    const again = await listElryanWarrantyMappingPage();
    assert.equal(again.counts.mapped, 5);
    assert.equal(again.counts.unmapped, 0);
    assert.equal(again.sharedWarrantyCounts[INGCO_CODE], 5);
    assert.equal(again.sharedWarrantyCounts[KENWOOD_CODE], undefined);
    assert.equal(again.brands.every((row) => row.warranty?.code === INGCO_CODE), true);

    const afterProducts = await Product.find().sort({ ibsherId: 1 }).lean();
    assert.deepEqual(
      afterProducts.map((row) => row.warranty),
      beforeProducts.map((row) => row.warranty)
    );
    const productOverride = await ElryanValueMapping.findOne({ brownKey: "staging:product:2-year" }).lean();
    assert.equal(productOverride.elryanCode, "PRODUCT-CODE");
    const warrantyRows = await ElryanValueMapping.find({ kind: "warranty" }).lean();
    const resolved = resolveElryanWarrantyFromRows(warrantyRows, {
      environment: "staging",
      explicitKey: "2-year",
      brandId: INGCO,
    });
    assert.equal(resolved.source, "product");
    assert.equal(resolved.mapping.elryanCode, "PRODUCT-CODE");

    const dropped = removeWarrantyBrand(selected, INGCO);
    assert.equal(dropped.has(INGCO), false);
    const kept = await ElryanValueMapping.findOne({ brownKey: `staging:brand:${INGCO}` }).lean();
    assert.equal(kept.elryanCode, INGCO_CODE);
    assert.equal(calls.some((line) => line.startsWith("POST") || line.startsWith("PATCH") || line.startsWith("PUT")), false);
  });
});
