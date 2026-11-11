import fs from "fs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildGiniPlanFromParts } from "./utils/giniSyncEvaluate.js";
import { buildGiniCreateForm } from "./services/giniSyncOne.js";
import { canConfirmGiniVariantTest } from "../../client/src/components/admin/platform/giniVariantTestDisplay.js";
import {
  GINI_VARIANT_TEST_EXCLUDED_PRODUCT_ID,
  GINI_VARIANT_TEST_PRICE,
  GINI_VARIANT_TEST_PRODUCT_ID,
  GINI_VARIANT_TEST_VARIATIONS,
  buildVariantTestPreview,
  classifyRemoteVariants,
  executeVariantRecovery,
  explicitRemoteAttributeId,
  giniVariantTestWritesEnabled,
  planVariantRecovery,
  variantTestDuplicateException,
} from "./utils/giniVariantTestContract.js";
import { previewGiniVariantTest, runGiniVariantTestStage, sendGiniVariantTest } from "./services/giniVariantTest.js";
import { canConfirmGiniVariantStage, describeGiniVariantStages } from "../../client/src/components/admin/platform/giniVariantTestDisplay.js";
import {
  createMemoryVariantOperation,
  executeStageA,
  executeStageB,
  executeVariantReadBack,
  sanitizedGiniResponse,
} from "./utils/giniVariantTestStages.js";

const IT_LOBBY = GINI_VARIANT_TEST_EXCLUDED_PRODUCT_ID;

function image(url, isMain = true) {
  return { url, isMain };
}

function variation(spec) {
  return {
    _id: spec.sourceVariantId,
    color: { en: spec.color },
    images: spec.images,
    sizes: [{ size: "large", stockQuantity: spec.stock ?? 10 }],
  };
}

function jawalProduct(overrides = {}) {
  const variants = GINI_VARIANT_TEST_VARIATIONS.map((spec, index) =>
    variation({
      ...spec,
      stock: overrides.stocks ? overrides.stocks[index] : 10,
      images:
        spec.color === "Blue"
          ? [image("/uploads/products/blue-main.webp"), image("/uploads/products/blue-extra.webp", false)]
          : [image(`/uploads/products/${spec.color.toLowerCase()}.webp`)],
    })
  );
  return {
    _id: GINI_VARIANT_TEST_PRODUCT_ID,
    ibsherId: "6adf9d38ef43bcf3ec7db6f7",
    itemCode: "75244",
    price: GINI_VARIANT_TEST_PRICE,
    name: { en: "17T Pro Smartphone", ar: "هاتف 17T برو الذكي", ku: "مۆبایل" },
    description: { ar: "هاتف اختبار" },
    brand: { name: "Xiaomi" },
    createdBy: { _id: "6ad326b8669f3bf0af58f970", name: "Jawal Flex" },
    variants,
    ...overrides,
    variants: overrides.variants || variants,
  };
}

function readyInput(overrides = {}) {
  const remoteBySku = {
    "75244": { exists: false },
    "75244-BLUE": { exists: false },
    "75244-BLACK": { exists: false },
    "75244-PURPLE": { exists: false },
  };
  return {
    product: jawalProduct(),
    localOwners: {
      "75244": [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY],
      "75244-blue": [],
      "75244-black": [],
      "75244-purple": [],
    },
    remoteBySku,
    attribute: { id: 3696, name: "Color", type: "color", values: ["Blue", "Black", "Purple"] },
    mapping: { saved: { categoryId: "3", subcategoryId: "3" }, blockers: [] },
    merchantMatches: true,
    writesEnabled: false,
    ...overrides,
  };
}

function matchedVariants(shape = "attribute_id") {
  return GINI_VARIANT_TEST_VARIATIONS.map((row) => ({
    sku: row.sku,
    quantity: 10,
    price: 1327000,
    attributes: [shape === "id" ? { id: 3696, name: "Color", value: row.color } : { attribute_id: "3696", value: row.color }],
  }));
}

test("duplicate SKU protection still blocks both owners in the global planner", () => {
  const plan = buildGiniPlanFromParts({
    doc: { _id: GINI_VARIANT_TEST_PRODUCT_ID, itemCode: "75244", name: { en: "17T Pro Smartphone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [] },
    resolved: { name: { en: "17T Pro Smartphone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [], stock: 30, isActive: true },
    priced: { price: 1327000, storePrice: 1327000 },
    duplicateProductIds: [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY],
    mapping: { blockers: [], category: { id: 3, name: "Electronics" }, subcategory: { id: 3, name: "Phones" } },
    existing: { exists: false },
  });
  assert.equal(plan.blockers.includes("duplicate_brownstore_sku"), true);
  const evaluate = fs.readFileSync(new URL("./utils/giniSyncEvaluate.js", import.meta.url), "utf8");
  const syncOne = fs.readFileSync(new URL("./services/giniSyncOne.js", import.meta.url), "utf8");
  const syncAll = fs.readFileSync(new URL("./services/giniSyncAll.js", import.meta.url), "utf8");
  assert.equal(evaluate.includes(GINI_VARIANT_TEST_PRODUCT_ID), false);
  assert.equal(syncOne.includes("giniVariantTest"), false);
  assert.equal(syncAll.includes("giniVariantTest"), false);
});

test("the variant exception is only the selected Jawal Flex product and excludes IT Lobby", () => {
  assert.equal(variantTestDuplicateException(GINI_VARIANT_TEST_PRODUCT_ID, [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY]).allowed, true);
  assert.equal(variantTestDuplicateException(IT_LOBBY, [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY]).allowed, false);
  assert.equal(
    variantTestDuplicateException(GINI_VARIANT_TEST_PRODUCT_ID, [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY, "other"]).allowed,
    false
  );
});

test("preview keeps three color labels, stock 10, and the extra Blue image unassigned", () => {
  const preview = buildVariantTestPreview(readyInput());
  assert.equal(preview.canSend, false);
  assert.equal(preview.readyForLiveTest, false);
  assert.equal(preview.writesEnabled, false);
  assert.equal(preview.blockers.includes("variant_sku_uniqueness_unproven"), true);
  assert.deepEqual(
    preview.variants.fields.filter((field) => field.key.endsWith("[value]")).map((field) => field.value),
    ["Blue", "Black", "Purple"]
  );
  assert.deepEqual(
    preview.variants.fields.filter((field) => field.key.endsWith("[quantity]")).map((field) => field.value),
    ["10", "10", "10"]
  );
  assert.deepEqual(
    preview.variants.fields.filter((field) => field.key.endsWith("[attribute_id]")).map((field) => field.value),
    ["3696", "3696", "3696"]
  );
  assert.equal(preview.preservedSourceImages.length, 1);
  assert.equal(preview.preservedSourceImages[0].sourceUrl, "/uploads/products/blue-extra.webp");
  assert.equal(preview.preservedSourceImages[0].color, "Blue");
  assert.equal(preview.preservedSourceImages[0].assignedTo, null);
  assert.equal(preview.variants.fields.some((field) => field.sourceUrl === "/uploads/products/blue-extra.webp"), false);
  assert.equal(preview.parent.fields.some((field) => field.sourceUrl === "/uploads/products/blue-extra.webp"), false);
  assert.equal(JSON.stringify(preview).includes(IT_LOBBY), true);
  assert.equal(preview.excludedProductId, IT_LOBBY);
  assert.equal(preview.parent.fields.find((field) => field.key === "is_visible").value, "0");
  assert.equal(preview.parent.fields.find((field) => field.key === "quantity").value, "0");
  assert.equal(preview.parent.payload.price, 1327000);
});

test("IT Lobby inventory is not added to the Jawal Flex quantities", () => {
  const preview = buildVariantTestPreview(readyInput());
  const quantities = preview.variants.fields.filter((field) => field.key.endsWith("[quantity]")).map((field) => Number(field.value));
  assert.equal(quantities.reduce((sum, value) => sum + value, 0), 30);
  const wrong = buildVariantTestPreview(readyInput({ product: jawalProduct({ stocks: [20, 10, 10] }) }));
  assert.equal(wrong.blockers.includes("variant_test_stock_mismatch"), true);
  assert.equal(wrong.variants, null);
});

test("local and remote SKU conflicts and unfinished lookups block the preview", () => {
  const local = buildVariantTestPreview(readyInput({ localOwners: { "75244": [GINI_VARIANT_TEST_PRODUCT_ID, IT_LOBBY], "75244-blue": ["other"] } }));
  assert.equal(local.blockers.includes("variant_sku_conflict"), true);
  const remote = buildVariantTestPreview(readyInput({ remoteBySku: { "75244": { exists: false }, "75244-BLUE": { exists: true, sku: "75244-BLUE" }, "75244-BLACK": { exists: false }, "75244-PURPLE": { exists: false } } }));
  assert.equal(remote.blockers.includes("variant_sku_conflict"), true);
  const incomplete = buildVariantTestPreview(readyInput({ remoteBySku: { "75244": { exists: false }, "75244-BLUE": { error: true }, "75244-BLACK": { exists: false }, "75244-PURPLE": { exists: false } } }));
  assert.equal(incomplete.blockers.includes("variant_sku_lookup_incomplete"), true);
  assert.equal(incomplete.canSend, false);
});

test("a missing image or wrong color makes the request incomplete", () => {
  const product = jawalProduct();
  product.variants[2].images = [];
  const missing = buildVariantTestPreview(readyInput({ product }));
  assert.equal(missing.blockers.includes("missing_variant_image"), true);
  assert.equal(missing.variants, null);
  const recolored = jawalProduct();
  recolored.variants[0].color = { en: "Green" };
  const wrong = buildVariantTestPreview(readyInput({ product: recolored }));
  assert.equal(wrong.blockers.includes("variant_source_identity_mismatch"), true);
});

test("parent create stays hidden and uses the existing multipart parent helper", () => {
  const preview = buildVariantTestPreview(readyInput());
  const form = buildGiniCreateForm(preview.parent.payload, []);
  const entries = [...form.entries()].map(([key, value]) => [key, String(value)]);
  assert.equal(entries.find((entry) => entry[0] === "is_visible")[1], "0");
  assert.equal(entries.find((entry) => entry[0] === "sku")[1], "75244");
  assert.equal(entries.find((entry) => entry[0] === "category_id")[1], "3");
  assert.equal(entries.find((entry) => entry[0] === "subcategory_id")[1], "3");
  assert.equal(preview.visibility.remainsHiddenUntilVariantsVerified, true);
  assert.equal(preview.requestOrder[1], "POST parent while hidden");
  assert.equal(preview.requestOrder[3], "PUT variants");
});

test("recovery never recreates a parent and never overwrites unrelated variants", async () => {
  assert.equal(planVariantRecovery({ parent: { state: "absent" }, variants: { state: "unread" } }).recreateParent, false);
  const methods = [];
  const perform = async (request) => {
    methods.push(request.method);
    if (request.method === "GET" && request.path.endsWith("/variants")) return { status: 200, json: { data: [{ sku: "OTHER", quantity: 1 }] } };
    if (request.method === "GET") return { status: 200, json: { data: { id: "9", sku: "75244" } } };
    throw new Error("write");
  };
  const partial = await executeVariantRecovery({
    perform,
    plan: { write: true, code: "save_variants_on_existing_parent" },
    parentFields: [],
    variantFields: [],
  });
  assert.equal(partial.code, "remote_variants_not_replaced");
  assert.equal(methods.includes("PUT"), false);
  assert.equal(methods.includes("POST"), false);

  const calls = [];
  const retry = await executeVariantRecovery({
    perform: async (request) => {
      calls.push(request.method);
      if (request.method === "POST") throw new Error("lost");
      if (request.method === "GET" && calls.filter((method) => method === "GET").length === 1) return { status: 404, json: {} };
      return { status: 200, json: { data: { id: "9", sku: "75244" } } };
    },
    plan: planVariantRecovery({ parent: { state: "absent" }, variants: { rows: [] } }),
    parentFields: [],
    variantFields: [],
  });
  assert.equal(retry.code, "parent_created_outcome_uncertain");
  assert.equal(retry.recreateParent, false);
  assert.equal(calls.filter((method) => method === "POST").length, 1);
});

test("complete success requires a verified read of all three variants", async () => {
  let variantReads = 0;
  const result = await executeVariantRecovery({
    perform: async (request) => {
      if (request.method === "POST") return { status: 201, json: { data: { id: "9", sku: "75244" } } };
      if (request.method === "PUT") return { status: 200, json: { data: matchedVariants() } };
      if (request.path.endsWith("/variants")) {
        variantReads += 1;
        return { status: 200, json: { data: variantReads === 1 ? [] : matchedVariants() } };
      }
      return { status: 404, json: {} };
    },
    plan: planVariantRecovery({ parent: { state: "absent" }, variants: { rows: [] } }),
    parentFields: [{ key: "sku", value: "75244" }],
    variantFields: [{ key: "variants[0][sku]", value: "75244-BLUE" }],
  });
  assert.equal(result.verified, true);
  assert.equal(result.code, "variants_verified");
  const unverified = await executeVariantRecovery({
    perform: async (request) => {
      if (request.method === "PUT") return { status: 200, json: {} };
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: [] } };
      if (request.method === "POST") return { status: 201, json: { data: { sku: "75244" } } };
      return { status: 404, json: {} };
    },
    plan: planVariantRecovery({ parent: { state: "absent" }, variants: { rows: [] } }),
    parentFields: [],
    variantFields: [],
  });
  assert.equal(unverified.verified, false);
  assert.equal(unverified.code, "variants_unverified");
});

test("the write gate is separate and off, including when other GINI gates are on", async () => {
  assert.equal(giniVariantTestWritesEnabled({}), false);
  assert.equal(
    giniVariantTestWritesEnabled({
      GINI_BULK_WRITES_ENABLED: "true",
      GINI_ALLOW_LIVE_BULK_WRITES: "true",
      GINI_SKU_CREATE_WRITES_ENABLED: "true",
      GINI_ALLOW_LIVE_SKU_CREATE: "true",
      GINI_SYNC_ONE_WRITES_ENABLED: "true",
      GINI_ALLOW_LIVE_SYNC_ONE_WRITES: "true",
    }),
    false
  );
  const calls = [];
  const disabled = await sendGiniVariantTest({ productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true }, { perform: async (request) => calls.push(request.method) });
  assert.equal(disabled.code, "variant_test_writes_disabled");
  assert.equal(calls.length, 0);
  const opened = await sendGiniVariantTest(
    { productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true },
    {
      env: { GINI_VARIANT_TEST_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_TEST: "true" },
      loadProduct: async () => jawalProduct(),
      localProducts: async () => [{ _id: IT_LOBBY, itemCode: "75244", createdBy: { name: "IT Lobby" }, variants: [] }],
      mapping: readyInput().mapping,
      attribute: readyInput().attribute,
      merchantMatches: true,
      findExisting: async () => ({ exists: false }),
      perform: async (request) => {
        calls.push(request.method);
        if (request.method !== "GET") throw new Error("live write");
        return { status: 404, json: {} };
      },
    }
  );
  assert.equal(opened.sent, false);
  assert.equal(opened.code, "variant_sku_uniqueness_unproven");
  assert.equal(calls.includes("POST"), false);
  assert.equal(calls.includes("PUT"), false);
  assert.equal(canConfirmGiniVariantTest({ preview: { canSend: true, writesEnabled: true, readyForLiveTest: true, productId: GINI_VARIANT_TEST_PRODUCT_ID }, confirmed: true, writesEnabled: false }), false);
  const routes = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
  assert.equal(routes.includes("/platforms/gini/variant-test/preview"), true);
  assert.equal(routes.includes("/platforms/gini/variant-test/stage-a"), true);
  assert.equal(routes.includes("/platforms/gini/variant-test/stage-b"), true);
  assert.equal(routes.includes("/platforms/gini/variant-test/send"), false);
});

test("preview service reads the selected product and does not write", async () => {
  const methods = [];
  const preview = await previewGiniVariantTest(
    { productId: GINI_VARIANT_TEST_PRODUCT_ID },
    {
      env: {},
      loadProduct: async () => jawalProduct(),
      localProducts: async () => [{ _id: IT_LOBBY, itemCode: "75244", variants: [{ sizes: [{ stockQuantity: 99 }] }] }],
      mapping: readyInput().mapping,
      attribute: readyInput().attribute,
      merchantMatches: true,
      findExisting: async () => ({ exists: false }),
      perform: async (request) => {
        methods.push(request.method);
        return { status: 200, json: { data: [] } };
      },
    }
  );
  assert.equal(methods.length, 0);
  assert.deepEqual(
    preview.variants.fields.filter((field) => field.key.endsWith("[quantity]")).map((field) => field.value),
    ["10", "10", "10"]
  );
  assert.equal(preview.readyForLiveTest, false);
});

const OPEN = { GINI_VARIANT_TEST_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_TEST: "true" };

function imageFiles() {
  const blob = new Blob([Uint8Array.from([1, 2, 3, 4])]);
  return ["Blue", "Black", "Purple"].map((color, index) => ({
    key: index === 0 ? "images[]" : `variants[${index}][image]`,
    color,
    byteLength: blob.size,
    verified: true,
    blob,
    filename: `${color}.webp`,
  }));
}

function hiddenParent(visible = 0, quantity = 0) {
  return { status: 200, json: { data: { sku: "75244", quantity, is_visible: visible } }, safeBodySnippet: "sku 75244" };
}

function stageDeps(operation, perform, extras = {}) {
  return {
    env: OPEN,
    operation,
    loadProduct: async () => jawalProduct(),
    localProducts: async () => [{ _id: IT_LOBBY, itemCode: "75244", variants: [] }],
    mapping: readyInput().mapping,
    attribute: readyInput().attribute,
    merchantMatches: true,
    findExisting: async () => ({ exists: false }),
    loadImageBytes: async (fields) => {
      const blob = new Blob([Uint8Array.from([1, 2, 3, 4])]);
      return fields.map((field, index) => ({
        key: field.key,
        color: field.color,
        sourceUrl: field.sourceUrl,
        byteLength: blob.size,
        verified: true,
        blob,
        filename: `image-${index}.webp`,
      }));
    },
    perform,
    ...extras,
  };
}

test("stage A does not create a parent that already exists and stops when creation is visible or rejected", async () => {
  const preview = buildVariantTestPreview(readyInput({ imageFiles: imageFiles() }));
  assert.equal(preview.canSend, false);
  assert.equal(preview.uniqueness.globalGuarantee, false);
  assert.equal(preview.stagePlan.parent.actionable, true);
  assert.equal(preview.stagePlan.parent.willCreate, true);
  assert.equal(preview.stagePlan.parent.blockers.includes("variant_sku_uniqueness_unproven"), false);
  assert.equal(preview.stagePlan.variants.uniquenessUnproven, true);
  assert.equal(preview.stagePlan.variants.actionable, false);
  assert.equal(preview.stagePlan.variants.blockers.includes("stage_b_parent_not_verified"), true);
  const described = describeGiniVariantStages({ preview: { ...preview, writesEnabled: true }, confirmParent: false, writesEnabled: true });
  assert.equal(described.parentBlockedByUniqueness, false);
  assert.equal(described.parentStatus, "ready, confirmation required");
  assert.deepEqual(described.parentBlockerMessages, []);
  assert.equal(described.variantStatus, "blocked");
  assert.equal(described.uniquenessMessage.includes("Stage A does not use this check"), true);
  const exists = createMemoryVariantOperation();
  const existing = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation: exists,
    perform: async (request) => {
      assert.equal(request.method, "GET");
      return hiddenParent();
    },
    buildForm: async () => { throw new Error("form"); },
  });
  assert.equal(existing.code, "parent_already_exists");
  assert.equal(existing.sent, false);
  assert.equal((await exists.read()).status, "parent_verified");

  const rejected = createMemoryVariantOperation();
  const methods = [];
  const failure = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation: rejected,
    perform: async (request) => {
      methods.push(request.method);
      if (request.method === "POST") return { status: 422, json: { message: "validation failed" }, safeBodySnippet: "validation failed" };
      return { status: 404, json: {} };
    },
    buildForm: async () => ({ marker: "parent" }),
  });
  assert.equal(failure.code, "parent_create_rejected");
  assert.equal(methods.filter((method) => method === "POST").length, 1);
  const again = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation: rejected,
    perform: async (request) => {
      methods.push(request.method);
      return { status: 404, json: {} };
    },
    buildForm: async () => ({ marker: "parent" }),
  });
  assert.equal(again.sent, false);
  assert.equal(methods.filter((method) => method === "POST").length, 1);

  const visible = createMemoryVariantOperation();
  let parentReads = 0;
  const shown = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation: visible,
    perform: async (request) => {
      if (request.method === "POST") return { status: 201, json: { data: { sku: "75244" } }, safeBodySnippet: "created" };
      parentReads += 1;
      return parentReads === 1 ? { status: 404, json: {} } : hiddenParent(1, 0);
    },
    buildForm: async () => ({ marker: "parent" }),
  });
  assert.equal(shown.code, "parent_visible_unexpected");
  assert.equal(shown.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(shown.calls.some((call) => call.method === "PUT" || call.method === "PATCH"), false);
  assert.equal((await visible.read()).status, "parent_stopped");
});

test("ambiguous parent creation and a restart do not repeat the POST", async () => {
  const preview = buildVariantTestPreview(readyInput());
  const operation = createMemoryVariantOperation();
  const calls = [];
  const ambiguous = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation,
    perform: async (request) => {
      calls.push(request.method);
      if (request.method === "POST") throw new Error("timeout");
      return { status: 404, json: {}, text: "clientSecret=hidden-secret" };
    },
    buildForm: async () => ({ marker: "parent" }),
    log: (entry) => assert.equal(JSON.stringify(entry).includes("hidden-secret"), false),
  });
  assert.equal(ambiguous.code, "parent_create_uncertain");
  assert.equal(calls.filter((method) => method === "POST").length, 1);
  assert.equal(JSON.stringify(await operation.read()).includes("hidden-secret"), false);
  const restarted = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation,
    perform: async (request) => {
      calls.push(request.method);
      assert.equal(request.method, "GET");
      return { status: 404, json: {} };
    },
    buildForm: async () => { throw new Error("must not build"); },
  });
  assert.equal(restarted.code, "operation_uncertain");
  assert.equal(calls.filter((method) => method === "POST").length, 1);
  assert.equal(sanitizedGiniResponse({ status: 500, text: "clientSecret=hidden-secret" }).snippet, "");
});

test("quantity zero rejection does not change the payload or retry", async () => {
  const preview = buildVariantTestPreview(readyInput());
  const sent = [];
  const result = await executeStageA({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    writesEnabled: true,
    parentFields: preview.parent.fields,
    imageFiles: imageFiles(),
    operation: createMemoryVariantOperation(),
    perform: async (request) => {
      if (request.method === "POST") {
        sent.push(preview.parent.fields.find((field) => field.key === "quantity").value);
        sent.push(preview.parent.fields.find((field) => field.key === "is_visible").value);
        return { status: 422, json: { errors: { quantity: ["must be greater than 0"] } }, safeBodySnippet: "quantity must be greater than 0" };
      }
      return { status: 404, json: {} };
    },
    buildForm: async () => ({ marker: "parent" }),
  });
  assert.equal(result.code, "quantity_zero_rejected");
  assert.deepEqual(sent, ["0", "0"]);
  assert.equal(result.calls.filter((call) => call.method === "POST").length, 1);
});

test("stage B blocks conflicts, unexpected variants, failed uploads, and partial results", async () => {
  const preview = buildVariantTestPreview(readyInput());
  const operation = createMemoryVariantOperation();
  await operation.update({ status: "parent_verified", parentQuantity: 0, parentVisibility: "hidden" });
  const unexpected = [];
  const blocked = await executeStageB({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    acceptUnprovenVariantSkuUniqueness: true,
    writesEnabled: true,
    variantFields: preview.variants.fields,
    imageFiles: imageFiles(),
    operation,
    perform: async (request) => {
      unexpected.push(request.method);
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: [{ sku: "OTHER", quantity: 1, attributes: [{ attribute_id: "1", value: "Red" }] }] } };
      return hiddenParent();
    },
    buildForm: async () => { throw new Error("form"); },
  });
  assert.equal(blocked.code, "remote_variants_not_replaced");
  assert.equal(unexpected.includes("PUT"), false);
  assert.equal((await operation.read()).status, "parent_verified");

  const failed = createMemoryVariantOperation();
  await failed.update({ status: "parent_verified" });
  const uploadCalls = [];
  const upload = await executeStageB({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    acceptUnprovenVariantSkuUniqueness: true,
    writesEnabled: true,
    variantFields: preview.variants.fields,
    imageFiles: imageFiles(),
    operation: failed,
    perform: async (request) => {
      uploadCalls.push(request.method);
      if (request.method === "PUT") throw new Error("multipart failed");
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: [] } };
      return hiddenParent();
    },
    buildForm: async () => ({ marker: "variants" }),
  });
  assert.equal(upload.code, "multipart_upload_failed");
  assert.equal((await failed.read()).status, "variants_uncertain");
  const uploadRetry = await executeStageB({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    acceptUnprovenVariantSkuUniqueness: true,
    writesEnabled: true,
    variantFields: preview.variants.fields,
    imageFiles: imageFiles(),
    operation: failed,
    perform: async (request) => {
      uploadCalls.push(request.method);
      if (request.method === "PUT") throw new Error("retry");
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: [] } };
      return hiddenParent();
    },
    buildForm: async () => { throw new Error("must not build"); },
  });
  assert.equal(uploadRetry.sent, false);
  assert.equal(uploadCalls.filter((method) => method === "PUT").length, 1);

  const partialStore = createMemoryVariantOperation();
  await partialStore.update({ status: "parent_verified" });
  let partialReads = 0;
  const partial = await executeStageB({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    acceptUnprovenVariantSkuUniqueness: true,
    writesEnabled: true,
    variantFields: preview.variants.fields,
    imageFiles: imageFiles(),
    operation: partialStore,
    perform: async (request) => {
      if (request.method === "PUT") return { status: 200, json: { data: [matchedVariants()[0]] }, safeBodySnippet: "partial" };
      if (request.path.endsWith("/variants")) {
        partialReads += 1;
        return { status: 200, json: { data: partialReads === 1 ? [] : [matchedVariants()[0]] } };
      }
      return hiddenParent();
    },
    buildForm: async () => ({ marker: "variants" }),
  });
  assert.equal(partial.verified, false);
  assert.equal(partial.code, "variants_unverified");
  assert.equal(partial.calls.filter((call) => call.method === "PUT").length, 1);
});

test("stage B verifies all three variants and does not publish the parent", async () => {
  const preview = buildVariantTestPreview(readyInput());
  const operation = createMemoryVariantOperation();
  await operation.update({ status: "parent_verified" });
  let variantReads = 0;
  const result = await executeStageB({
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    confirm: true,
    acceptUnprovenVariantSkuUniqueness: true,
    writesEnabled: true,
    variantFields: preview.variants.fields,
    imageFiles: imageFiles(),
    operation,
    perform: async (request) => {
      if (request.method === "PUT") return { status: 200, json: { data: matchedVariants() }, safeBodySnippet: "saved" };
      if (request.path.endsWith("/variants")) {
        variantReads += 1;
        return { status: 200, json: { data: variantReads === 1 ? [] : matchedVariants() } };
      }
      return hiddenParent(0, variantReads === 0 ? 0 : 30);
    },
    buildForm: async () => ({ marker: "variants" }),
  });
  assert.equal(result.verified, true);
  assert.equal((await operation.read()).parentQuantity, 30);
  assert.equal(result.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(result.calls.some((call) => call.method === "PATCH" || call.method === "DELETE"), false);
  assert.equal((await operation.read()).parentVisibility, "hidden");
  assert.equal(preview.preservedSourceImages.length, 1);
  assert.equal(preview.variants.fields.some((field) => field.sourceUrl === "/uploads/products/blue-extra.webp"), false);
});

test("IT Lobby and missing confirmations or write flags cannot start either stage", async () => {
  const calls = [];
  const perform = async (request) => {
    calls.push(request.method);
    throw new Error("live");
  };
  const lobby = await runGiniVariantTestStage({ stage: "parent", productId: IT_LOBBY, confirm: true }, { env: OPEN, perform });
  assert.equal(lobby.code, "variant_test_product_mismatch");
  const closed = await runGiniVariantTestStage({ stage: "parent", productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true }, { perform });
  assert.equal(closed.code, "variant_test_writes_disabled");
  const oneFlag = await runGiniVariantTestStage(
    { stage: "variants", productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true, acceptUnprovenVariantSkuUniqueness: true },
    { env: { GINI_VARIANT_TEST_WRITES_ENABLED: "true" }, perform }
  );
  assert.equal(oneFlag.code, "variant_test_writes_disabled");
  const unconfirmed = await runGiniVariantTestStage({ stage: "parent", productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: false }, { env: OPEN, perform });
  assert.equal(unconfirmed.code, "stage_a_confirm_required");
  const noAck = await runGiniVariantTestStage(
    { stage: "variants", productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true, acceptUnprovenVariantSkuUniqueness: false },
    { env: OPEN, perform }
  );
  assert.equal(noAck.code, "uniqueness_acknowledgement_required");
  assert.equal(calls.length, 0);
  const conflict = await runGiniVariantTestStage(
    { stage: "parent", productId: GINI_VARIANT_TEST_PRODUCT_ID, confirm: true },
    stageDeps(createMemoryVariantOperation(), perform, { findExisting: async (sku) => ({ exists: sku === "75244-BLUE", sku }) })
  );
  assert.equal(conflict.code, "variant_sku_conflict");
  assert.equal(calls.length, 0);
  assert.equal(canConfirmGiniVariantStage({ stage: "parent", preview: { writesEnabled: true, productId: GINI_VARIANT_TEST_PRODUCT_ID, stagePlan: { parent: { actionable: true } } }, confirmed: true, writesEnabled: false }), false);
  assert.equal(canConfirmGiniVariantStage({ stage: "variants", preview: { writesEnabled: true, productId: GINI_VARIANT_TEST_PRODUCT_ID, stagePlan: { variants: { actionable: true } } }, confirmed: true, acceptUniqueness: false, writesEnabled: true }), false);
  const service = fs.readFileSync(new URL("./services/giniVariantTest.js", import.meta.url), "utf8");
  assert.equal(service.includes("GiniSyncSendState"), false);
  assert.equal(service.includes("Product.update"), false);
  assert.equal(service.includes("miswag"), false);
  assert.equal(service.includes("elryan"), false);
});

test("observed GINI variant rows use attributes.id and do not invent a missing id", () => {
  const observed = matchedVariants("id");
  assert.equal(explicitRemoteAttributeId(observed[0]), "3696");
  assert.equal(explicitRemoteAttributeId({ attributes: [{ value: "Blue" }] }), "");
  assert.equal(classifyRemoteVariants(observed).state, "match");
  assert.equal(classifyRemoteVariants([{ ...observed[0], attributes: [{ value: "Blue" }] }]).state, "unrelated");
  assert.equal(classifyRemoteVariants([{ ...observed[0], attributes: [{ id: 1, value: "Blue" }] }]).state, "unrelated");
  assert.equal(classifyRemoteVariants(observed.map((row) => ({ ...row, price: 1 }))).state, "unrelated");
});

test("GET-only read-back verifies the Xiaomi variants when parent quantity is 30", async () => {
  const operation = createMemoryVariantOperation();
  await operation.update({ status: "variants_uncertain", lastCode: "variants_unverified", parentQuantity: 0, parentVisibility: "hidden" });
  const methods = [];
  const result = await executeVariantReadBack({
    operation,
    perform: async (request) => {
      methods.push(request.method);
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: matchedVariants("id") } };
      return hiddenParent(0, 30);
    },
  });
  assert.deepEqual(methods, ["GET", "GET"]);
  assert.equal(result.verified, true);
  assert.equal(result.code, "variants_verified");
  assert.equal((await operation.read()).status, "variants_verified");
  assert.equal((await operation.read()).parentQuantity, 30);
  const visibleOp = createMemoryVariantOperation();
  await visibleOp.update({ status: "variants_uncertain" });
  const visible = await executeVariantReadBack({
    operation: visibleOp,
    perform: async (request) => {
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: matchedVariants("id") } };
      return hiddenParent(1, 30);
    },
  });
  assert.equal(visible.verified, false);
  assert.equal(visible.code, "parent_visible_unexpected");
  assert.equal((await visibleOp.read()).status, "variants_uncertain");
});
