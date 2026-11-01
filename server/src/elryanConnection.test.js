import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { decryptApiKey, encryptApiKey } from "./utils/partnerAuth.js";
import { applyCommissionRate } from "./utils/commission.js";
import { taxonomyFieldsFor, isTaxonomyComplete } from "./utils/platformTaxonomyFields.js";
import { interpretElryanSkuAvailability, validateElryanSku } from "./utils/elryanSku.js";
import { assessElryanSellableUnits } from "./utils/elryanVariations.js";
import { buildElryanProductPayload } from "./utils/elryanPayloadBuilder.js";
import { collectElryanImageUrls, resolveElryanImageUrl, verifyElryanPublicImages } from "./utils/elryanImages.js";
import { publicMediaUrl } from "./utils/commissionExcel.js";
import { elryanPreviewDecision, validateElryanPreviewParts } from "./utils/elryanValidator.js";
import { ELRYAN_READINESS, elryanProductWritesEnabled } from "./utils/elryanConstants.js";
import { joinElryanUrl, setElryanFetch, validateElryanBaseUrl } from "./services/elryanClient.js";
import { assertNoElryanSecretLeak, sanitizeElryanText } from "./utils/elryanRedact.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-connection-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-test-key-not-for-browser-9f3c";
const API_KEY_PROD = "elryan-prod-key-not-for-browser-aa11";
const TEMP_KEY = "elryan-temp-key-not-persisted-77";

let memory;
let server;
let token;
let productId;

function app() {
  const instance = express();
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin", adminRouter);
  return instance;
}

function listen(instance) {
  return new Promise((resolve) => {
    const running = instance.listen(0, "127.0.0.1", () => resolve(running));
  });
}

async function call(method, urlPath, { body } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, raw: JSON.stringify(json) };
}

function mockResponse(status, body = {}) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get() {
        return "application/json";
      },
    },
    async text() {
      return text;
    },
  };
}

function mockElryanRouter(handlers = {}) {
  setElryanFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`Unexpected write: ${method} ${target}`);
    }
    if (target.includes("/v1/health-check")) {
      return handlers.health ? handlers.health(url, options) : mockResponse(200, { data: { status: "ok" } });
    }
    if (target.includes("/v1/categories")) {
      return handlers.categories
        ? handlers.categories(url, options)
        : mockResponse(200, { data: [{ id: "c1", Name: "Demo" }] });
    }
    if (handlers.other) return handlers.other(url, options);
    return mockResponse(200, { data: { ok: true } });
  });
}

describe("Elryan constants and pure helpers", () => {
  it("keeps product writes disabled by default", () => {
    assert.equal(elryanProductWritesEnabled(), false);
  });

  it("validates official base URLs only", () => {
    assert.equal(validateElryanBaseUrl("https://staging-marketplace-api.elryan.com/api").ok, true);
    assert.equal(validateElryanBaseUrl("https://marketplace-api.elryan.com/api").ok, true);
    assert.equal(validateElryanBaseUrl("https://merchant.elryan.com/api").ok, false);
  });

  it("builds /v1 paths on the official base", () => {
    const url = joinElryanUrl("https://staging-marketplace-api.elryan.com/api", "/v1/health-check");
    assert.equal(url, "https://staging-marketplace-api.elryan.com/api/v1/health-check");
  });

  it("redacts secrets", () => {
    const text = sanitizeElryanText(`Authorization: Bearer ${API_KEY} and ${API_KEY}`, [API_KEY]);
    assert.equal(text.includes(API_KEY), false);
  });

  it("validates SKU rules and blocks multi-size", () => {
    assert.equal(validateElryanSku("AB-12_3/4").ok, true);
    assert.equal(
      assessElryanSellableUnits({
        sku: "SKU1",
        sellingPrice: 1000,
        variants: [{ color: { en: "Red" }, sizes: [{ stockQuantity: 1 }, { stockQuantity: 2 }] }],
      }).ok,
      false
    );
  });

  it("preserves 250 IQD rounding and elryan taxonomy fields", () => {
    assert.equal(applyCommissionRate(1000, 10), 1250);
    assert.ok(taxonomyFieldsFor("elryan").some((f) => f.key === "categoryId"));
    assert.ok(taxonomyFieldsFor("miswag").length > 0);
    assert.ok(taxonomyFieldsFor("gini").length > 0);
    assert.equal(isTaxonomyComplete("elryan", { categoryId: "cat-1" }), true);
  });

  it("omits cost from payload", () => {
    const payload = buildElryanProductPayload({
      resolved: {
        name: { en: "Lamp", ar: "مصباح" },
        description: { en: "Desk lamp" },
        variants: [{ images: [{ url: "https://cdn.example.com/a.jpg" }] }],
        outOfStock: false,
      },
      sku: "LAMP-1",
      mapping: { categoryId: "c1" },
      brand: { elryanId: "b1" },
      color: { elryanId: "col1" },
      warranty: { elryanCode: "W1" },
      pricing: { proposedElryanPrice: 1250 },
      origin: "https://brownstore.test",
      quantity: 3,
    });
    assert.equal(payload.price, 1250);
    assert.equal("cost" in payload, false);
  });

  it("resolves BrownStore images to the public media URL and checks image content", async () => {
    const relative = "/uploads/products/img-1788957353512-732082698.webp";
    const expected = publicMediaUrl(relative);
    const resolved = {
      variants: [{ images: [{ url: relative }] }],
      image: relative,
    };
    assert.equal(expected, "https://api.brownstore.net/api/media/uploads/products/img-1788957353512-732082698.webp");
    assert.equal(resolveElryanImageUrl(relative), expected);
    assert.equal(resolveElryanImageUrl(`/api/media${relative}`), expected);
    assert.equal(resolveElryanImageUrl(`http://localhost:5173${relative}`), expected);
    assert.equal(resolveElryanImageUrl(expected), expected);
    assert.equal(resolveElryanImageUrl("https://cdn.example.com/lamp.jpg"), "https://cdn.example.com/lamp.jpg");
    assert.equal(resolveElryanImageUrl(""), "");
    assert.equal(resolveElryanImageUrl("/not-a-product/file.webp"), "");

    const payload = buildElryanProductPayload({
      resolved,
      sku: "OWCH180002",
      origin: "http://localhost:5173",
      pricing: { proposedElryanPrice: 66250 },
      quantity: 3,
    });
    assert.equal(payload.images[0].fileUrl, expected);
    assert.equal(payload.images[0].fileUrl, collectElryanImageUrls(resolved)[0]);
    assert.equal(payload.images[0].fileUrl.includes("localhost"), false);
    assert.equal("cost" in payload, false);

    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("VP8 ")]);
    const imageResponse = (status, type, body) => ({
      status,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) },
      async arrayBuffer() {
        return body;
      },
    });
    assert.equal((await verifyElryanPublicImages([expected], async () => imageResponse(200, "image/webp", webp))).length, 0);
    assert.equal(
      (await verifyElryanPublicImages([expected], async () => imageResponse(404, "text/plain", Buffer.from("missing"))))[0].code,
      "image_unreachable"
    );
    assert.equal(
      (await verifyElryanPublicImages([expected], async () => imageResponse(200, "text/html", Buffer.from("<html>no</html>"))))[0]
        .code,
      "image_unreachable"
    );
    assert.equal(
      (await verifyElryanPublicImages(["https://cdn.example.com/lamp.jpg"], async () => {
        throw new Error("external images are preserved without a fetch");
      })).length,
      0
    );

    const missing = validateElryanPreviewParts({
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "OWCH180002",
      mapping: { categoryId: "340" },
      brand: { elryanId: "276" },
      color: { elryanId: "59" },
      warranty: { elryanCode: "rlbo35igt4" },
      warrantyCatalog: { checked: true, codes: ["rlbo35igt4"], empty: false, message: "" },
      attributes: {},
      requiredAttributeCodes: [],
      variation: { ok: true, reasons: [] },
      pricing: { proposedElryanPrice: 66250 },
      images: [],
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.blockers.some((blocker) => blocker.code === "missing_image"), true);
  });

  it("accepts a resolved BrownStore price and still blocks an ambiguous one", () => {
    const resolved = validateElryanPreviewParts({
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "SKU-1",
      mapping: { categoryId: "c1" },
      brand: { elryanId: "b1" },
      color: { elryanId: "c1" },
      warranty: { elryanCode: "W1" },
      warrantyCatalog: { checked: true, codes: ["W1"], empty: false, message: "" },
      attributes: {},
      requiredAttributeCodes: [],
      variation: { ok: true, reasons: [] },
      pricing: { proposedElryanPrice: 1000, pricingNote: "resolved" },
      images: ["https://cdn.example.com/a.jpg"],
    });
    assert.equal(resolved.readiness, ELRYAN_READINESS.READY);
    assert.equal(resolved.ready, true);
    assert.equal(resolved.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);

    const ambiguous = validateElryanPreviewParts({
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "SKU-1",
      mapping: { categoryId: "c1" },
      brand: { elryanId: "b1" },
      color: { elryanId: "c1" },
      warranty: { elryanCode: "W1" },
      warrantyCatalog: { checked: true, codes: ["W1"], empty: false, message: "" },
      attributes: {},
      requiredAttributeCodes: [],
      variation: { ok: true, reasons: [] },
      pricing: { proposedElryanPrice: null, priceReview: true },
      images: ["https://cdn.example.com/a.jpg"],
    });
    assert.equal(ambiguous.ready, false);
    assert.equal(ambiguous.blockers.some((blocker) => blocker.code === "price_needs_review"), true);
  });

  it("keeps READY impossible while any mandatory blocker remains", () => {
    const priced = elryanPreviewDecision({
      readiness: ELRYAN_READINESS.READY,
      blockers: [{ code: "pricing_unverified", status: ELRYAN_READINESS.PRICING_UNVERIFIED }],
    });
    assert.equal(priced.ready, false);
    assert.equal(priced.readiness, ELRYAN_READINESS.PRICING_UNVERIFIED);

    const mapped = elryanPreviewDecision({
      blockers: [
        { code: "missing_brand_mapping", status: ELRYAN_READINESS.MISSING_MAPPING },
        { code: "pricing_unverified", status: ELRYAN_READINESS.PRICING_UNVERIFIED },
      ],
    });
    assert.equal(mapped.ready, false);
    assert.equal(mapped.readiness, ELRYAN_READINESS.MISSING_MAPPING);

    const clear = elryanPreviewDecision({ readiness: ELRYAN_READINESS.READY, blockers: [] });
    assert.equal(clear.ready, true);
    assert.equal(clear.readiness, ELRYAN_READINESS.READY);
  });

  it("treats data.available true as free and HTTP 409 as taken", () => {
    const free = interpretElryanSkuAvailability({
      httpStatus: 200,
      json: { success: true, data: { available: true }, exists: true },
    });
    assert.equal(free.available, true);
    assert.equal(free.exists, false);

    const taken = interpretElryanSkuAvailability({
      httpStatus: 409,
      json: { success: false, error: { code: "CONFLICT", message: "SKU already used" } },
    });
    assert.equal(taken.exists, true);
    assert.equal(taken.available, false);
    assert.equal(taken.conflict, true);
  });
});

describe("Elryan connection state and catalog reads", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-connection"));
    const user = await User.create({
      email: "elryan-admin@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Elryan Admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan" });
    server = await listen(app());
  });

  after(async () => {
    setElryanFetch(null);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setElryanFetch(null);
    await ElryanConnection.deleteMany({});
    await ElryanValueMapping.deleteMany({});
    await PlatformTaxonomyConfig.deleteMany({ partner: "elryan" });
    await Commission.deleteMany({});
    await Product.deleteMany({});
    const product = await Product.create({
      ibsherId: "ibs-elryan-1",
      itemCode: "EL-SKU-1",
      name: { en: "Elryan Test", ar: "اختبار" },
      description: { en: "Desc", ar: "وصف" },
      price: 10000,
      brand: { _id: "brand-1", name: { en: "Acme" } },
      category: { _id: "cat-1", name: { en: "Home" } },
      subCategory: { _id: "sub-1", name: { en: "Lighting" } },
      collectionName: { _id: "col-1", name: { en: "Lamps" } },
      variants: [
        {
          color: { en: "Black" },
          images: [{ url: "https://cdn.example.com/lamp.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 4 }],
        },
      ],
      isActive: true,
    });
    productId = String(product._id);
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "col-1",
      values: { categoryId: "elr-cat-9", categoryHierarchy: "Home : Lighting : Lamps" },
    });
    await ElryanValueMapping.create([
      { kind: "brand", brownKey: "brand-1", elryanId: "elr-brand-1", elryanLabel: "Acme" },
      { kind: "color", brownKey: "black", elryanId: "elr-color-1", elryanLabel: "Black" },
      {
        kind: "warranty",
        brownKey: "staging:brand:brand-1",
        environment: "staging",
        warrantyScope: "brand",
        elryanCode: "W-STD",
      },
    ]);
  });

  it("1. health succeeds without a key → reachable, not authenticated", async () => {
    mockElryanRouter();
    const tested = await call("POST", "/api/admin/platforms/elryan/connection/test", {
      body: { environment: "staging" },
    });
    assert.equal(tested.status, 200);
    assert.equal(tested.json.reachable, true);
    assert.equal(tested.json.authenticated, false);
    assert.equal(tested.json.status, "reachable");
    assert.equal(tested.json.keyPersisted, false);
    assert.notEqual(tested.json.status, "authenticated");
    assert.equal(tested.json.connection.hasApiKey, false);
  });

  it("2. test with temporary key does not persist the key", async () => {
    let categoriesKey = "";
    mockElryanRouter({
      categories(url, options) {
        categoriesKey = options.headers?.["x-api-key"] || "";
        return mockResponse(200, { data: [{ id: "c1" }] });
      },
    });

    const tested = await call("POST", "/api/admin/platforms/elryan/connection/test", {
      body: { environment: "staging", apiKey: TEMP_KEY },
    });
    assert.equal(tested.json.authenticated, true);
    assert.equal(tested.json.temporaryKey, true);
    assert.equal(tested.json.keyPersisted, false);
    assert.equal(categoriesKey, TEMP_KEY);

    const stored = await ElryanConnection.findOne({ singletonKey: "default" }).select(
      "+stagingApiKeyEnc +productionApiKeyEnc +apiKeyEnc"
    );
    assert.equal(stored?.stagingApiKeyEnc || "", "");
    assert.equal(stored?.apiKeyEnc || "", "");

    const cats = await call("GET", "/api/admin/platforms/elryan/categories?limit=1");
    assert.equal(cats.status, 409);
    assert.equal(cats.json.code, "api_access_pending");
    assert.equal(cats.raw.includes(TEMP_KEY), false);
  });

  it("3. save key → encrypted key persists and can be resolved", async () => {
    const saved = await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.hasApiKey, true);
    assert.equal(saved.json.keyStored, true);
    assert.equal(saved.json.status, "key_configured");
    assert.equal(saved.raw.includes(API_KEY), false);

    const stored = await ElryanConnection.findOne({ singletonKey: "default" }).select(
      "+stagingApiKeyEnc"
    );
    assert.equal(decryptApiKey(stored.stagingApiKeyEnc), API_KEY);
  });

  it("4. decryption failure → safe config error", async () => {
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: "not-a-valid-sealed-payload",
      hasApiKey: true,
    });

    const loaded = await call("GET", "/api/admin/platforms/elryan/connection");
    assert.equal(loaded.json.decryptionError, true);
    assert.equal(loaded.json.status, "config_error");
    assert.match(loaded.json.accessLabel, /Configuration error/i);

    const cats = await call("GET", "/api/admin/platforms/elryan/categories?limit=1");
    assert.equal(cats.status, 409);
    assert.equal(cats.json.code, "config_error");
    assert.equal(cats.raw.includes("not-a-valid"), false);
  });

  it("5. saved key → authorized categories read uses resolved key", async () => {
    let usedKey = "";
    let sawWrite = false;
    mockElryanRouter({
      categories(url, options) {
        usedKey = options.headers?.["x-api-key"] || "";
        assert.match(String(url), /limit=1/);
        return mockResponse(200, { data: [{ id: "c1", Name: "Home" }] });
      },
    });
    setElryanFetch(async (url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") sawWrite = true;
      if (String(url).includes("/v1/health-check")) return mockResponse(200, { data: { ok: true } });
      if (String(url).includes("/v1/categories")) {
        usedKey = options.headers?.["x-api-key"] || "";
        return mockResponse(200, { data: [{ id: "c1", Name: "Home" }] });
      }
      return mockResponse(200, {});
    });

    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });

    const tested = await call("POST", "/api/admin/platforms/elryan/connection/test", {
      body: { environment: "staging" },
    });
    assert.equal(tested.json.status, "authenticated");
    assert.equal(tested.json.keyPersisted, true);
    assert.equal(tested.json.temporaryKey, false);

    const cats = await call("GET", "/api/admin/platforms/elryan/categories?limit=1");
    assert.equal(cats.status, 200);
    assert.equal(usedKey, API_KEY);
    assert.equal(sawWrite, false);
    assert.equal(cats.raw.includes(API_KEY), false);
  });

  it("6. staging and production credentials remain isolated", async () => {
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "production", apiKey: API_KEY_PROD },
    });

    const stored = await ElryanConnection.findOne({ singletonKey: "default" }).select(
      "+stagingApiKeyEnc +productionApiKeyEnc"
    );
    assert.equal(decryptApiKey(stored.stagingApiKeyEnc), API_KEY);
    assert.equal(decryptApiKey(stored.productionApiKeyEnc), API_KEY_PROD);

    // Switch active env to staging without sending a key — must not erase production.
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging" },
    });
    const again = await ElryanConnection.findOne({ singletonKey: "default" }).select(
      "+stagingApiKeyEnc +productionApiKeyEnc"
    );
    assert.equal(decryptApiKey(again.stagingApiKeyEnc), API_KEY);
    assert.equal(decryptApiKey(again.productionApiKeyEnc), API_KEY_PROD);
  });

  it("7. product write gates remain disabled", async () => {
    assert.equal(elryanProductWritesEnabled(), false);
    mockElryanRouter();
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    const preview = await call("POST", "/api/admin/platforms/elryan/sync-one/preview", {
      body: { productId },
    });
    assert.equal(preview.json.productWritesEnabled, false);
    assert.equal(preview.json.liveWritesAllowed, false);
    assert.equal(preview.json.writesGate.productPostCalled, false);
    assert.notEqual(preview.json.readiness, ELRYAN_READINESS.READY);
    assert.equal(preview.json.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);
    assert.equal(preview.json.blockers.some((blocker) => blocker.code === "dimensions_unverified"), true);
    const send = await call("POST", "/api/admin/platforms/elryan/sync-one/send", {
      body: { productId, confirm: true, previewToken: preview.json.previewToken },
    });
    assert.equal(send.status, 403);
    assert.equal(send.json.code, "writes_disabled");
  });

  it("reads the writes gate without a product post when both flags are enabled", async () => {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
    const calls = [];
    setElryanFetch(async (url, options = {}) => {
      calls.push(`${String(options.method || "GET").toUpperCase()} ${url}`);
      throw new Error("writes-gate must not call Elryan");
    });
    try {
      const gate = await call("GET", "/api/admin/platforms/elryan/writes-gate");
      assert.equal(gate.status, 200);
      assert.equal(gate.json.productWritesEnabled, true);
      assert.equal(gate.json.liveWritesAllowed, true);
      assert.equal(gate.json.productPostCalled, false);
      assert.equal(calls.length, 0);
      const source = fs.readFileSync(
        new URL("../../client/src/components/admin/platform/ElryanSyncOneProduct.jsx", import.meta.url),
        "utf8"
      );
      const probeStart = source.indexOf("async function onProbeWritesGate");
      const probeEnd = source.indexOf("function onAskSend");
      const probe = source.slice(probeStart, probeEnd);
      assert.equal(probe.includes("elryanWritesGate"), true);
      assert.equal(probe.includes("elryanSyncOneSend"), false);
      assert.equal(probe.includes("confirm"), false);
      assert.equal(source.includes("/v1/products"), false);
      const confirmStart = source.indexOf("async function onConfirmSend");
      const confirmEnd = source.indexOf("async function onRefreshSendAttempt");
      const confirmFn = source.slice(confirmStart, confirmEnd);
      assert.equal(confirmFn.includes("elryanSyncOneSend"), true);
      assert.match(confirmFn, /confirm:\s*true/);
      assert.equal(confirmFn.includes("confirm: false"), false);
    } finally {
      delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
      delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
      setElryanFetch(null);
    }
  });

  it("does not mark authenticated from health alone when categories auth fails", async () => {
    mockElryanRouter({
      categories() {
        return mockResponse(401, { message: "unauthorized" });
      },
    });
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    const tested = await call("POST", "/api/admin/platforms/elryan/connection/test", {
      body: { environment: "staging" },
    });
    assert.equal(tested.json.reachable, true);
    assert.equal(tested.json.authenticated, false);
    assert.equal(tested.json.status, "auth_rejected");
  });

  it("save without a new key does not erase an existing encrypted key", async () => {
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging" },
    });
    const stored = await ElryanConnection.findOne({ singletonKey: "default" }).select(
      "+stagingApiKeyEnc"
    );
    assert.equal(decryptApiKey(stored.stagingApiKeyEnc), API_KEY);
  });

  it("sku-exists reports an available SKU as free and a 409 as taken", async () => {
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
    mockElryanRouter({
      other(url) {
        const target = String(url);
        if (!target.includes("/v1/products/sku-exists")) return mockResponse(200, { data: { ok: true } });
        if (target.includes("TAKEN-1")) {
          return mockResponse(409, {
            success: false,
            error: { code: "CONFLICT", message: "SKU already used" },
          });
        }
        return mockResponse(200, { success: true, data: { available: true }, exists: true });
      },
    });
    const free = await call("GET", "/api/admin/platforms/elryan/sku-exists?sku=OWCH180002");
    assert.equal(free.status, 200);
    assert.equal(free.json.available, true);
    assert.equal(free.json.exists, false);
    assert.equal(free.json.classification, "READ");
    const taken = await call("GET", "/api/admin/platforms/elryan/sku-exists?sku=TAKEN-1");
    assert.equal(taken.status, 200);
    assert.equal(taken.json.exists, true);
    assert.equal(taken.json.available, false);
    assert.equal(taken.json.httpStatus, 409);
  });

  it("refuses assertNoElryanSecretLeak when a raw key slips in", () => {
    assert.throws(() => assertNoElryanSecretLeak({ note: API_KEY }, API_KEY));
  });

  it("legacy apiKeyEnc still resolves for its environment", async () => {
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      apiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
    });
    let usedKey = "";
    setElryanFetch(async (url, options = {}) => {
      if (String(url).includes("/v1/categories")) {
        usedKey = options.headers?.["x-api-key"] || "";
        return mockResponse(200, { data: [] });
      }
      return mockResponse(200, { data: { ok: true } });
    });
    const cats = await call("GET", "/api/admin/platforms/elryan/categories?limit=1");
    assert.equal(cats.status, 200);
    assert.equal(usedKey, API_KEY);
  });
});
