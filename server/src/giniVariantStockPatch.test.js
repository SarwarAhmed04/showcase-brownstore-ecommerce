import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { performGiniJsonRequest, setGiniFetch } from "./services/giniConnection.js";
import { previewKe20StockPatch, runKe20StockPatch } from "./services/giniVariantStockPatch.js";
import { signGiniRequest } from "./utils/giniSigner.js";
import { KE20_STOCK_PATCH_RAW_BODY, KE20_STOCK_RESTORE_RAW_BODY } from "./utils/giniVariantStockPatchPlan.js";

const OPEN = { GINI_VARIANT_STOCK_PATCH_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_STOCK_PATCH: "true" };
const PATH = "/api/v2.0/third-party/products/KE20/stock";
const OWNER_PRODUCT = "6adc7938b3764a909f6929d6";

function parent(quantity, { price = 26500, visible = false, id = 618623 } = {}) {
  return { status: 200, json: { data: { id, sku: "KE20", quantity, price, is_visible: visible } } };
}

function variants(blackQuantity, blueQuantity = 10, { blackId = 164307, blueId = 164306, blackPrice = 26500, bluePrice = 26500 } = {}) {
  return {
    status: 200,
    json: {
      data: [
        { id: blueId, sku: "KE20-BLUE", quantity: blueQuantity, price: bluePrice },
        { id: blackId, sku: "KE20-BLACK", quantity: blackQuantity, price: blackPrice },
      ],
    },
  };
}

function records(overrides = {}) {
  return {
    owner: { status: "verified_remote", giniProductId: "618623", productId: OWNER_PRODUCT, ...overrides.owner },
    identities: overrides.identities || [
      { approvedSku: "KE20-BLACK", confirmedGiniVariantId: "164307", productId: OWNER_PRODUCT },
      { approvedSku: "KE20-BLUE", confirmedGiniVariantId: "164306", productId: OWNER_PRODUCT },
    ],
  };
}

function memory() {
  let doc = null;
  return {
    async read() { return doc; },
    async save(next) { doc = { ...(doc || {}), ...next }; return doc; },
    current() { return doc; },
  };
}

function remoteGets(sequence) {
  const calls = [];
  return {
    calls,
    async perform(request) {
      calls.push(request);
      const next = sequence.shift();
      if (!next) throw new Error("unexpected_get");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

after(() => setGiniFetch(null));

describe("KE20 one-variant stock PATCH", () => {
  it("prepares the exact quantity body and does not send while the gate is off", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(20), variants(10)]);
    const result = await runKe20StockPatch({
      confirm: true,
      env: {},
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: memory(),
      ...records(),
    });
    assert.equal(result.code, "variant_stock_patch_disabled");
    assert.equal(result.sent, false);
    assert.equal(jsonCalls.length, 0);
    assert.equal(gets.calls.length, 0);
    assert.equal(result.request.rawBody, KE20_STOCK_PATCH_RAW_BODY);
    assert.equal(result.intentionalDifference.includes("BrownStore stock stays at 10"), true);
    assert.equal(result.restorePlan.automatic, false);
    assert.equal(result.restorePlan.rawBody, KE20_STOCK_RESTORE_RAW_BODY);
  });

  it("signs and sends PATCH with the exact raw body when the gate and confirmation are on", async () => {
    const captured = [];
    setGiniFetch(async (_url, init) => {
      captured.push(init);
      return { status: 200, headers: { get: () => "application/json" }, text: async () => "{\"data\":{}}" };
    });
    const response = await performGiniJsonRequest({
      method: "PATCH",
      path: PATH,
      rawBody: KE20_STOCK_PATCH_RAW_BODY,
      resolvedConfig: { baseUrl: "https://merchant.gini.iq", clientId: "client", clientSecret: "secret" },
    });
    assert.equal(response.status, 200);
    assert.equal(captured[0].method, "PATCH");
    assert.equal(captured[0].body, KE20_STOCK_PATCH_RAW_BODY);
    const signed = signGiniRequest({ method: "PATCH", path: PATH, body: KE20_STOCK_PATCH_RAW_BODY, timestamp: captured[0].headers["X-TIMESTAMP"], clientSecret: "secret" });
    const empty = signGiniRequest({ method: "PATCH", path: PATH, body: "", timestamp: captured[0].headers["X-TIMESTAMP"], clientSecret: "secret" });
    const asPut = signGiniRequest({ method: "PUT", path: PATH, body: KE20_STOCK_PATCH_RAW_BODY, timestamp: captured[0].headers["X-TIMESTAMP"], clientSecret: "secret" });
    assert.equal(captured[0].headers["X-SIGNATURE"], signed.signature);
    assert.notEqual(signed.signature, empty.signature);
    assert.notEqual(signed.signature, asPut.signature);
    await assert.rejects(
      () => performGiniJsonRequest({ method: "POST", path: PATH, rawBody: KE20_STOCK_PATCH_RAW_BODY }),
      (err) => err.code === "update_method_rejected"
    );
  });

  it("verifies the black quantity change and leaves blue untouched", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(20), variants(10), parent(19), variants(9)]);
    const operation = memory();
    const result = await runKe20StockPatch({
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200, json: { data: {} } }; },
      operation,
      ...records(),
    });
    assert.equal(result.verified, true);
    assert.equal(result.code, "verified");
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].method, "PATCH");
    assert.equal(jsonCalls[0].rawBody, KE20_STOCK_PATCH_RAW_BODY);
    assert.equal(jsonCalls[0].rawBody.includes("164306"), false);
    assert.equal(jsonCalls[0].rawBody.includes("price"), false);
    assert.equal(jsonCalls[0].rawBody.includes("is_visible"), false);
    assert.equal(gets.calls.every((call) => call.method === "GET"), true);
    assert.equal(operation.current().status, "verified");
    assert.equal(result.restorePlan.rawBody, KE20_STOCK_RESTORE_RAW_BODY);
  });

  it("blocks a remote identity mismatch before PATCH", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(20), variants(10)]);
    const operation = memory();
    const result = await runKe20StockPatch({
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records({ identities: [
        { approvedSku: "KE20-BLACK", confirmedGiniVariantId: "999", productId: OWNER_PRODUCT },
        { approvedSku: "KE20-BLUE", confirmedGiniVariantId: "164306", productId: OWNER_PRODUCT },
      ] }),
    });
    assert.equal(result.code, "baseline_blocked");
    assert.equal(result.blockers.includes("black_identity_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
    assert.equal(operation.current().status, "baseline_blocked");
  });

  it("records a failed verification GET and does not retry", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(20), variants(10), new Error("read failed")]);
    const operation = memory();
    const shared = {
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records(),
    };
    const failed = await runKe20StockPatch(shared);
    assert.equal(failed.code, "verification_unread");
    assert.equal(operation.current().status, "uncertain");
    const again = await runKe20StockPatch(shared);
    assert.equal(again.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 1);
  });

  it("records a timeout as uncertain and does not retry", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(20), variants(10)]);
    const operation = memory();
    const shared = {
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async () => {
        jsonCalls.push("patch");
        const err = new Error("timed out");
        err.code = "update_timeout";
        err.status = 504;
        throw err;
      },
      operation,
      ...records(),
    };
    const timedOut = await runKe20StockPatch(shared);
    assert.equal(timedOut.code, "patch_uncertain");
    assert.equal(operation.current().lastCode, "update_timeout");
    const again = await runKe20StockPatch(shared);
    assert.equal(again.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 1);
  });

  it("records an uncertain HTTP response and does not retry", async () => {
    const jsonCalls = [];
    const operation = memory();
    const shared = {
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(20), variants(10)]).perform,
      performJson: async () => { jsonCalls.push("patch"); return { status: 502, json: {} }; },
      operation,
      ...records(),
    };
    const uncertain = await runKe20StockPatch(shared);
    assert.equal(uncertain.code, "patch_uncertain");
    assert.equal(operation.current().status, "uncertain");
    const again = await runKe20StockPatch({ ...shared, performGet: remoteGets([parent(20), variants(10)]).perform });
    assert.equal(again.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 1);
  });

  it("fails verification when the untouched blue variant changes", async () => {
    const operation = memory();
    const result = await runKe20StockPatch({
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(20), variants(10), parent(19), variants(9, 9)]).perform,
      performJson: async () => ({ status: 200 }),
      operation,
      ...records(),
    });
    assert.equal(result.code, "verification_failed");
    assert.equal(result.blockers.includes("blue_mismatch"), true);
    assert.equal(operation.current().status, "uncertain");
    assert.equal(KE20_STOCK_PATCH_RAW_BODY.includes("164306"), false);
  });

  it("shows the baseline preview without a PATCH", async () => {
    const preview = await previewKe20StockPatch({
      env: {},
      host: "merchant.gini.iq",
      remote: { parent: { state: "present", sku: "KE20", id: "618623", quantity: 20, price: 26500, visibility: "hidden" }, variants: null },
      operation: memory(),
      skipConnection: true,
      ...records(),
    });
    assert.equal(preview.writesEnabled, false);
    assert.equal(preview.readyForConfirmation, false);
    assert.equal(preview.sent, false);
    assert.equal(preview.request.rawBody, KE20_STOCK_PATCH_RAW_BODY);
    assert.equal(preview.baseline.ok, false);
  });
});
