import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { performGiniJsonRequest, setGiniFetch } from "./services/giniConnection.js";
import { previewKe20PricePatch, runKe20PricePatch } from "./services/giniVariantPricePatch.js";
import { applyCommissionRate } from "./utils/commission.js";
import { signGiniRequest } from "./utils/giniSigner.js";
import {
  KE20_BLACK_PRICE_PATCH_RAW_BODY,
  KE20_BLUE_PRICE_PATCH_RAW_BODY,
  KE20_PRICE_PATCH_PATH,
  ke20PricePatchWritesEnabled,
} from "./utils/giniVariantPricePatchPlan.js";

const OPEN = { GINI_KE20_PRICE_PATCH_ENABLED: "true", GINI_ALLOW_LIVE_KE20_PRICE_PATCH: "true" };
const OWNER_PRODUCT = "6adc7938b3764a909f6929d6";
const BLOCKING = ["in_progress", "uncertain", "verified", "rejected"];

function parent({ price = 26500, quantity = 20, visible = false, id = 618623 } = {}) {
  return { status: 200, json: { data: { id, sku: "KE20", quantity, price, is_visible: visible } } };
}

function variants({
  bluePrice = 26500,
  blackPrice = 26500,
  blueQty = 10,
  blackQty = 10,
  blueId = 164306,
  blackId = 164307,
} = {}) {
  return {
    status: 200,
    json: {
      data: [
        { id: blueId, sku: "KE20-BLUE", quantity: blueQty, price: bluePrice },
        { id: blackId, sku: "KE20-BLACK", quantity: blackQty, price: blackPrice },
      ],
    },
  };
}

function approved(variantId, rawBody) {
  return {
    parentSku: "KE20",
    variantId: String(variantId),
    status: "approved",
    baselinePrice: 26500,
    baselineQuantity: 10,
    proposedPrice: 28000,
    rawBody,
  };
}

function records(overrides = {}) {
  return {
    owner: { status: "verified_remote", giniProductId: "618623", productId: OWNER_PRODUCT, ...overrides.owner },
    identities: overrides.identities || [
      { approvedSku: "KE20-BLUE", confirmedGiniVariantId: "164306", productId: OWNER_PRODUCT },
      { approvedSku: "KE20-BLACK", confirmedGiniVariantId: "164307", productId: OWNER_PRODUCT },
    ],
    approvals: overrides.approvals || [
      approved(164306, KE20_BLUE_PRICE_PATCH_RAW_BODY),
      approved(164307, KE20_BLACK_PRICE_PATCH_RAW_BODY),
    ],
  };
}

function journal(seed = {}) {
  const docs = new Map(Object.entries(seed));
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }
  return {
    docs,
    async read(key) {
      return docs.get(key) || null;
    },
    claim(key, fields) {
      return exclusive(async () => {
        const current = docs.get(key);
        if (current && BLOCKING.includes(current.status)) return { claimed: false, doc: current };
        const doc = { ...(current || {}), ...fields, operationKey: key, parentSku: "KE20", status: "in_progress", lastCode: "in_progress" };
        docs.set(key, doc);
        return { claimed: true, doc };
      });
    },
    save(key, patch) {
      return exclusive(async () => {
        const doc = { ...(docs.get(key) || {}), ...patch, operationKey: key };
        docs.set(key, doc);
        return doc;
      });
    },
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

function liveRemote({ bluePrice = 26500, blackPrice = 26500, parentPrice = 26500 } = {}) {
  return async (request) => (
    String(request.path).endsWith("/variants")
      ? variants({ bluePrice, blackPrice })
      : parent({ price: parentPrice })
  );
}

after(() => setGiniFetch(null));

describe("KE20 sequential price PATCH", () => {
  it("keeps the 28000 target on the existing 5.5 percent rounding rule", () => {
    assert.equal(applyCommissionRate(26500, 5.5), 28000);
    assert.equal(ke20PricePatchWritesEnabled({}), false);
    assert.equal(ke20PricePatchWritesEnabled(process.env), false);
  });

  it("prepares the blue PATCH and does not send while the gates are off", async () => {
    const jsonCalls = [];
    const gets = remoteGets([parent(), variants()]);
    const result = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: {},
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: journal(),
      ...records(),
    });
    assert.equal(result.code, "ke20_price_patch_disabled");
    assert.equal(result.sent, false);
    assert.equal(result.canSend, false);
    assert.equal(result.batchEnabled, false);
    assert.equal(result.retry, false);
    assert.equal(jsonCalls.length, 0);
    assert.equal(gets.calls.length, 0);
    assert.equal(result.request.method, "PATCH");
    assert.equal(result.request.path, KE20_PRICE_PATCH_PATH);
    assert.equal(result.request.rawBody, KE20_BLUE_PRICE_PATCH_RAW_BODY);
  });

  it("signs the exact blue body and rejects any other method", async () => {
    const captured = [];
    setGiniFetch(async (_url, init) => {
      captured.push(init);
      return { status: 200, headers: { get: () => "application/json" }, text: async () => "{\"data\":{}}" };
    });
    const response = await performGiniJsonRequest({
      method: "PATCH",
      path: KE20_PRICE_PATCH_PATH,
      rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY,
      resolvedConfig: { baseUrl: "https://merchant.gini.iq", clientId: "client", clientSecret: "secret" },
    });
    assert.equal(response.status, 200);
    assert.equal(captured[0].method, "PATCH");
    assert.equal(captured[0].body, KE20_BLUE_PRICE_PATCH_RAW_BODY);
    const signed = signGiniRequest({ method: "PATCH", path: KE20_PRICE_PATCH_PATH, body: KE20_BLUE_PRICE_PATCH_RAW_BODY, timestamp: captured[0].headers["X-TIMESTAMP"], clientSecret: "secret" });
    const empty = signGiniRequest({ method: "PATCH", path: KE20_PRICE_PATCH_PATH, body: "", timestamp: captured[0].headers["X-TIMESTAMP"], clientSecret: "secret" });
    assert.equal(captured[0].headers["X-SIGNATURE"], signed.signature);
    assert.notEqual(signed.signature, empty.signature);
    setGiniFetch(null);
    await assert.rejects(
      () => performGiniJsonRequest({ method: "POST", path: KE20_PRICE_PATCH_PATH, rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY }),
      (err) => err.code === "update_method_rejected"
    );
  });

  it("verifies blue at 28000 and leaves black at 26500 with the parent still at 26500", async () => {
    const jsonCalls = [];
    const gets = remoteGets([
      parent(),
      variants(),
      parent({ price: 26500 }),
      variants({ bluePrice: 28000, blackPrice: 26500 }),
    ]);
    const operation = journal();
    const result = await runKe20PricePatch({
      stage: "blue",
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
    assert.equal(result.nextStage, "black");
    assert.equal(result.sent, false);
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].rawBody, KE20_BLUE_PRICE_PATCH_RAW_BODY);
    assert.equal(jsonCalls[0].rawBody.includes("164307"), false);
    assert.equal(jsonCalls[0].rawBody.includes("quantity"), false);
    assert.equal(jsonCalls[0].rawBody.includes("is_visible"), false);
    assert.equal(gets.calls.every((call) => call.method === "GET"), true);
    assert.equal(operation.docs.get("ke20-price-164306").status, "verified");
    assert.equal(operation.docs.get("ke20-price-164307"), undefined);
    const again = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records(),
    });
    assert.equal(again.code, "already_verified");
    assert.equal(jsonCalls.length, 1);
  });

  it("sends black only after blue is verified and the fresh remote state matches", async () => {
    const jsonCalls = [];
    const operation = journal({
      "ke20-price-164306": { status: "verified", rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY, stage: "blue" },
    });
    const blocked = await runKe20PricePatch({
      stage: "black",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(), variants()]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: journal(),
      ...records(),
    });
    assert.equal(blocked.code, "stage_not_ready");
    assert.equal(jsonCalls.length, 0);
    const result = await runKe20PricePatch({
      stage: "black",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([
        parent({ price: 26500 }),
        variants({ bluePrice: 28000, blackPrice: 26500 }),
        parent({ price: 28000 }),
        variants({ bluePrice: 28000, blackPrice: 28000 }),
      ]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records(),
    });
    assert.equal(result.verified, true);
    assert.equal(result.nextStage, "");
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].rawBody, KE20_BLACK_PRICE_PATCH_RAW_BODY);
    assert.equal(jsonCalls[0].rawBody.includes("164306"), false);
    assert.equal(operation.docs.get("ke20-price-164306").status, "verified");
    assert.equal(operation.docs.get("ke20-price-164307").status, "verified");
  });

  it("blocks a baseline mismatch before either PATCH", async () => {
    const jsonCalls = [];
    const operation = journal();
    const result = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent({ visible: true }), variants({ bluePrice: 27000 })]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records(),
    });
    assert.equal(result.code, "baseline_blocked");
    assert.equal(result.blockers.includes("parent_not_hidden"), true);
    assert.equal(result.blockers.includes("blue_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
    assert.equal(operation.docs.get("ke20-price-164306").status, "baseline_blocked");
  });

  it("blocks a missing production approval and an ownership mismatch", async () => {
    const jsonCalls = [];
    const missing = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(), variants()]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: journal(),
      ...records({ approvals: [approved(164306, KE20_BLUE_PRICE_PATCH_RAW_BODY)] }),
    });
    assert.equal(missing.code, "approval_blocked");
    assert.equal(missing.blockers.includes("black_approval_missing"), true);
    const owner = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(), variants()]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: journal(),
      ...records({ identities: [
        { approvedSku: "KE20-BLUE", confirmedGiniVariantId: "1", productId: OWNER_PRODUCT },
        { approvedSku: "KE20-BLACK", confirmedGiniVariantId: "164307", productId: OWNER_PRODUCT },
      ] }),
    });
    assert.equal(owner.code, "approval_blocked");
    assert.equal(owner.blockers.includes("blue_identity_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
  });

  it("lets only one of two concurrent blue claims send", async () => {
    const jsonCalls = [];
    const operation = journal();
    const shared = {
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: async (request) => {
        const after = jsonCalls.length > 0;
        if (String(request.path).endsWith("/variants")) return variants(after ? { bluePrice: 28000, blackPrice: 26500 } : {});
        return parent();
      },
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...records(),
    };
    const [first, second] = await Promise.all([runKe20PricePatch(shared), runKe20PricePatch(shared)]);
    const codes = [first.code, second.code].sort();
    assert.deepEqual(codes, ["concurrent_claim_lost", "verified"]);
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].rawBody, KE20_BLUE_PRICE_PATCH_RAW_BODY);
    assert.equal(operation.docs.get("ke20-price-164306").status, "verified");
  });

  it("records network uncertainty and does not retry after a restart", async () => {
    const jsonCalls = [];
    const operation = journal();
    const shared = {
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: liveRemote(),
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
    const timedOut = await runKe20PricePatch(shared);
    assert.equal(timedOut.code, "patch_uncertain");
    assert.equal(operation.docs.get("ke20-price-164306").lastCode, "update_timeout");
    const again = await runKe20PricePatch(shared);
    assert.equal(again.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 1);
    const restarted = await runKe20PricePatch({
      ...shared,
      performJson: async () => { jsonCalls.push("restarted"); return { status: 200 }; },
      operation: journal({ "ke20-price-164306": { status: "in_progress", stage: "blue", rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY } }),
    });
    assert.equal(restarted.code, "restart_no_retry");
    assert.equal(jsonCalls.length, 1);
  });

  it("records an uncertain HTTP status and a failed read-back without another PATCH", async () => {
    const jsonCalls = [];
    const operation = journal();
    const uncertain = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: liveRemote(),
      performJson: async () => { jsonCalls.push("patch"); return { status: 502, json: {} }; },
      operation,
      ...records(),
    });
    assert.equal(uncertain.code, "patch_uncertain");
    const unread = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([parent(), variants(), new Error("read failed")]).perform,
      performJson: async () => { jsonCalls.push("patch"); return { status: 200 }; },
      operation: journal(),
      ...records(),
    });
    assert.equal(unread.code, "verification_unread");
    assert.equal(jsonCalls.length, 2);
    const retry = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performGet: liveRemote(),
      performJson: async () => { jsonCalls.push("patch"); return { status: 200 }; },
      operation,
      ...records(),
    });
    assert.equal(retry.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 2);
  });

  it("keeps a partial blue verification from authorizing black or another blue send", async () => {
    const jsonCalls = [];
    const operation = journal({
      "ke20-price-164306": { status: "verified", rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY, stage: "blue" },
    });
    const preview = await previewKe20PricePatch({
      env: {},
      host: "merchant.gini.iq",
      remote: {
        parent: { state: "present", id: "618623", sku: "KE20", quantity: 20, price: 26500, visibility: "hidden" },
        variants: [
          { normalized: true, id: "164306", sku: "KE20-BLUE", price: 28000, quantity: 10 },
          { normalized: true, id: "164307", sku: "KE20-BLACK", price: 26500, quantity: 10 },
        ],
      },
      operation,
      skipConnection: true,
      ...records(),
    });
    assert.equal(preview.writesEnabled, false);
    assert.equal(preview.readyForConfirmation, false);
    assert.equal(preview.sent, false);
    assert.equal(preview.nextStage, "black");
    assert.equal(preview.stages.blue.rawBody, KE20_BLUE_PRICE_PATCH_RAW_BODY);
    assert.equal(preview.stages.black.rawBody, KE20_BLACK_PRICE_PATCH_RAW_BODY);
    assert.equal(preview.baseline.ok, true);
    const blueAgain = await runKe20PricePatch({
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performJson: async () => { jsonCalls.push("blue"); return { status: 200 }; },
      operation,
      ...records(),
    });
    assert.equal(blueAgain.code, "already_verified");
    assert.equal(jsonCalls.length, 0);
    assert.equal(operation.docs.get("ke20-price-164307"), undefined);
  });

  it("does not expose a batch sender or another marketplace", () => {
    const route = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
    const service = fs.readFileSync(new URL("./services/giniVariantPricePatch.js", import.meta.url), "utf8");
    const panel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniKe20PricePatchPanel.jsx", import.meta.url), "utf8");
    assert.equal(route.includes("variant-sync/price-pilot/send"), false);
    assert.equal(route.includes("variant-sync/ke20-price-patch"), true);
    assert.equal(service.includes("EI-8888"), false);
    assert.equal(service.includes("miswag"), false);
    assert.equal(service.includes("elryan"), false);
    assert.equal(service.includes("ibsher"), false);
    assert.equal(service.includes("GINI_KE20_PRICE_PATCH_ENABLED === \"true\""), false);
    assert.equal(panel.includes("readyForConfirmation === true"), true);
    assert.equal(KE20_BLUE_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164306,\"price\":28000}");
    assert.equal(KE20_BLACK_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164307,\"price\":28000}");
  });
});
