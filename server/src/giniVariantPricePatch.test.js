import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import { performGiniJsonRequest, setGiniFetch } from "./services/giniConnection.js";
import { previewEi8888PricePatch, previewKe20PricePatch, refreshEi8888CommissionSnapshot, resolvePricePilotCommissionSnapshot, runEi8888PricePatch, runKe20PricePatch } from "./services/giniVariantPricePatch.js";
import { applyCommissionRate } from "./utils/commission.js";
import { signGiniRequest } from "./utils/giniSigner.js";
import {
  EI8888_BLUE_PRICE_PATCH_RAW_BODY,
  EI8888_PRICE_PATCH_PATH,
  EI8888_PRICE_PILOT,
  EI8888_PURPLE_PRICE_PATCH_RAW_BODY,
  KE20_BLACK_PRICE_PATCH_RAW_BODY,
  KE20_BLUE_PRICE_PATCH_RAW_BODY,
  KE20_PRICE_PATCH_PATH,
  assessEi8888CommissionSnapshot,
  ei8888PricePatchWritesEnabled,
  ke20PricePatchWritesEnabled,
} from "./utils/giniVariantPricePatchPlan.js";

const OPEN = { GINI_KE20_PRICE_PATCH_ENABLED: "true", GINI_ALLOW_LIVE_KE20_PRICE_PATCH: "true" };
const OWNER_PRODUCT = "6adc7938b3764a909f6929d6";
const PRODUCTION_PRODUCT = "6aae476f023c0be610d48093";
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

function approved(variantId, rawBody, productId = OWNER_PRODUCT) {
  return {
    parentSku: "KE20",
    productId,
    variantId: String(variantId),
    status: "approved",
    baselinePrice: 26500,
    baselineQuantity: 10,
    proposedPrice: 28000,
    rawBody,
  };
}

function identity(sku, variantId, productId, sourceVariantId, sourceSizeId, extra = {}) {
  return {
    productId,
    parentSku: "KE20",
    parentSkuKey: "ke20",
    approvedSku: sku,
    approvedSkuKey: String(sku).toLowerCase(),
    confirmedGiniVariantId: String(variantId),
    sourceVariantId,
    sourceSizeId,
    status: "verified",
    ...extra,
  };
}

function records(overrides = {}) {
  const productId = overrides.owner?.productId || OWNER_PRODUCT;
  return {
    owner: { status: "verified_remote", giniProductId: "618623", parentSku: "KE20", skuKey: "ke20", productId, ...overrides.owner },
    identities: overrides.identities || [
      identity("KE20-BLUE", "164306", productId, "blue-source", "blue-size"),
      identity("KE20-BLACK", "164307", productId, "black-source", "black-size"),
    ],
    approvals: overrides.approvals || [
      approved(164306, KE20_BLUE_PRICE_PATCH_RAW_BODY, productId),
      approved(164307, KE20_BLACK_PRICE_PATCH_RAW_BODY, productId),
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

  it("resolves either the local or production product id from verified records", async () => {
    const remote = {
      parent: { state: "present", id: "618623", sku: "KE20", quantity: 20, price: 26500, visibility: "hidden" },
      variants: [
        { normalized: true, id: "164306", sku: "KE20-BLUE", price: 26500, quantity: 10 },
        { normalized: true, id: "164307", sku: "KE20-BLACK", price: 26500, quantity: 10 },
      ],
    };
    for (const productId of [OWNER_PRODUCT, PRODUCTION_PRODUCT]) {
      const preview = await previewKe20PricePatch({
        env: {},
        host: "merchant.gini.iq",
        remote,
        operation: journal(),
        skipConnection: true,
        ...records({ owner: { productId } }),
      });
      assert.equal(preview.ownership.ok, true);
      assert.equal(preview.ownership.productId, productId);
      assert.equal(preview.ownership.blue.sourceVariantId, "blue-source");
      assert.equal(preview.ownership.blue.sourceSizeId, "blue-size");
      assert.equal(preview.ownership.black.confirmedGiniVariantId, "164307");
      assert.equal(preview.approval.ok, true);
      assert.equal(preview.writesEnabled, false);
      assert.equal(preview.readyForConfirmation, false);
      assert.equal(preview.sent, false);
    }
  });

  it("rejects a development identity, a duplicate SKU, and a stale approval on the production owner", async () => {
    const jsonCalls = [];
    const send = async () => { jsonCalls.push("patch"); return { status: 200 }; };
    const shared = {
      stage: "blue",
      confirm: true,
      env: OPEN,
      host: "merchant.gini.iq",
      performJson: send,
      operation: journal(),
    };
    const wrongProduct = await runKe20PricePatch({
      ...shared,
      ...records({
        owner: { productId: PRODUCTION_PRODUCT },
        identities: [
          identity("KE20-BLUE", "164306", OWNER_PRODUCT, "blue-source", "blue-size"),
          identity("KE20-BLACK", "164307", OWNER_PRODUCT, "black-source", "black-size"),
        ],
      }),
    });
    assert.equal(wrongProduct.blockers.includes("owner_mismatch"), false);
    assert.equal(wrongProduct.blockers.includes("blue_identity_mismatch"), true);
    assert.equal(wrongProduct.blockers.includes("black_identity_mismatch"), true);
    const duplicate = await runKe20PricePatch({
      ...shared,
      operation: journal(),
      ...records({
        owner: { productId: PRODUCTION_PRODUCT },
        identities: [
          identity("KE20-BLUE", "164306", PRODUCTION_PRODUCT, "blue-source", "blue-size"),
          identity("KE20-BLUE", "999", "other-product", "other-source", "other-size"),
          identity("KE20-BLACK", "164307", PRODUCTION_PRODUCT, "black-source", "black-size"),
        ],
      }),
    });
    assert.equal(duplicate.blockers.includes("blue_identity_mismatch"), true);
    const missingSource = await runKe20PricePatch({
      ...shared,
      operation: journal(),
      ...records({
        owner: { productId: PRODUCTION_PRODUCT },
        identities: [
          identity("KE20-BLUE", "164306", PRODUCTION_PRODUCT, "blue-source", ""),
          identity("KE20-BLACK", "164307", PRODUCTION_PRODUCT, "black-source", "black-size"),
        ],
      }),
    });
    assert.equal(missingSource.blockers.includes("blue_identity_mismatch"), true);
    const staleApproval = await runKe20PricePatch({
      ...shared,
      operation: journal(),
      ...records({
        owner: { productId: PRODUCTION_PRODUCT },
        approvals: [
          approved(164306, KE20_BLUE_PRICE_PATCH_RAW_BODY, OWNER_PRODUCT),
          approved(164307, KE20_BLACK_PRICE_PATCH_RAW_BODY, OWNER_PRODUCT),
        ],
      }),
    });
    assert.equal(staleApproval.code, "approval_blocked");
    assert.equal(staleApproval.blockers.includes("owner_mismatch"), false);
    assert.equal(staleApproval.blockers.includes("blue_approval_missing"), true);
    assert.equal(staleApproval.blockers.includes("black_approval_missing"), true);
    const preserved = await runKe20PricePatch({
      ...shared,
      operation: journal(),
      performGet: remoteGets([parent(), variants(), parent(), variants({ bluePrice: 28000 })]).perform,
      ...records({ owner: { productId: PRODUCTION_PRODUCT } }),
    });
    assert.equal(preserved.verified, true);
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0], "patch");
  });

  it("does not expose a batch sender or another marketplace", () => {
    const route = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
    const service = fs.readFileSync(new URL("./services/giniVariantPricePatch.js", import.meta.url), "utf8");
    const plan = fs.readFileSync(new URL("./utils/giniVariantPricePatchPlan.js", import.meta.url), "utf8");
    const panel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniKe20PricePatchPanel.jsx", import.meta.url), "utf8");
    assert.equal(plan.includes("6adc7938b3764a909f6929d6"), false);
    assert.equal(plan.includes("6aae476f023c0be610d48093"), false);
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

const EI_OPEN = { GINI_EI8888_PRICE_PATCH_ENABLED: "true", GINI_ALLOW_LIVE_EI8888_PRICE_PATCH: "true" };
const EI_LOCAL = "local-ei8888-owner";
const EI_PRODUCTION = "production-ei8888-owner";
const EI_COMMISSION = { percentage: 5.5, basePrice: 119750, giniPrice: 126500, scope: "filter" };

function eiParent({ price = 119750, quantity = 20, visible = false, id = 618651 } = {}) {
  return { status: 200, json: { data: { id, sku: "EI-8888", quantity, price, is_visible: visible } } };
}

function eiVariants({
  bluePrice = 119750,
  purplePrice = 119750,
  blueQty = 10,
  purpleQty = 10,
  blueId = 164312,
  purpleId = 164313,
} = {}) {
  return {
    status: 200,
    json: {
      data: [
        { id: blueId, sku: "EI-8888-BLUE", quantity: blueQty, price: bluePrice },
        { id: purpleId, sku: "EI-8888-PURPLE", quantity: purpleQty, price: purplePrice },
      ],
    },
  };
}

function eiApproved(variantId, rawBody, productId) {
  return {
    parentSku: "EI-8888",
    productId,
    variantId: String(variantId),
    status: "approved",
    baselinePrice: 119750,
    baselineQuantity: 10,
    proposedPrice: 126500,
    rawBody,
  };
}

function eiIdentity(sku, variantId, productId, sourceVariantId, sourceSizeId) {
  return {
    productId,
    parentSku: "EI-8888",
    parentSkuKey: "ei-8888",
    approvedSku: sku,
    approvedSkuKey: String(sku).toLowerCase(),
    confirmedGiniVariantId: String(variantId),
    sourceVariantId,
    sourceSizeId,
    status: "verified",
  };
}

function eiRecords(productId = EI_LOCAL, overrides = {}) {
  return {
    owner: { status: "verified_remote", giniProductId: "618651", parentSku: "EI-8888", skuKey: "ei-8888", productId, ...overrides.owner },
    identities: overrides.identities || [
      eiIdentity("EI-8888-BLUE", "164312", productId, "blue-source", "blue-size"),
      eiIdentity("EI-8888-PURPLE", "164313", productId, "purple-source", "purple-size"),
    ],
    approvals: overrides.approvals || [
      eiApproved(164312, EI8888_BLUE_PRICE_PATCH_RAW_BODY, productId),
      eiApproved(164313, EI8888_PURPLE_PRICE_PATCH_RAW_BODY, productId),
    ],
    commissionSnapshot: overrides.commissionSnapshot === undefined ? EI_COMMISSION : overrides.commissionSnapshot,
  };
}

function eiJournal(seed = {}) {
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
        const doc = { ...(current || {}), ...fields, operationKey: key, parentSku: "EI-8888", status: "in_progress", lastCode: "in_progress" };
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

describe("EI-8888 sequential price PATCH", () => {
  it("keeps both write gates off and prices 119750 at 5.5 percent as 126500", () => {
    assert.equal(applyCommissionRate(119750, 5.5), 126500);
    assert.equal(ei8888PricePatchWritesEnabled({}), false);
    assert.equal(ei8888PricePatchWritesEnabled(process.env), false);
    assert.equal(ei8888PricePatchWritesEnabled({ GINI_EI8888_PRICE_PATCH_ENABLED: "true" }), false);
    assert.equal(ei8888PricePatchWritesEnabled({ GINI_ALLOW_LIVE_EI8888_PRICE_PATCH: "true" }), false);
    const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    assert.equal(/GINI_EI8888_PRICE_PATCH_ENABLED\s*=\s*true/.test(envText), false);
    assert.equal(/GINI_ALLOW_LIVE_EI8888_PRICE_PATCH\s*=\s*true/.test(envText), false);
  });

  it("prepares the blue PATCH and does not send while the gates are off", async () => {
    const jsonCalls = [];
    const gets = remoteGets([eiParent(), eiVariants()]);
    const result = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: {},
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: eiJournal(),
      ...eiRecords(),
    });
    assert.equal(result.code, "ei8888_price_patch_disabled");
    assert.equal(result.sent, false);
    assert.equal(result.canSend, false);
    assert.equal(result.retry, false);
    assert.equal(jsonCalls.length, 0);
    assert.equal(gets.calls.length, 0);
    assert.equal(result.request.rawBody, EI8888_BLUE_PRICE_PATCH_RAW_BODY);
    assert.equal(result.request.path, EI8888_PRICE_PATCH_PATH);
  });

  it("verifies blue at 126500 and leaves purple at 119750 with the parent still hidden", async () => {
    const jsonCalls = [];
    const gets = remoteGets([
      eiParent(),
      eiVariants(),
      eiParent({ price: 119750 }),
      eiVariants({ bluePrice: 126500, purplePrice: 119750 }),
    ]);
    const operation = eiJournal();
    const result = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: gets.perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...eiRecords(),
    });
    assert.equal(result.verified, true);
    assert.equal(result.nextStage, "purple");
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].method, "PATCH");
    assert.equal(jsonCalls[0].rawBody, "{\"variant_id\":164312,\"price\":126500}");
    assert.equal(jsonCalls[0].rawBody.includes("164313"), false);
    assert.equal(jsonCalls[0].rawBody.includes("quantity"), false);
    assert.equal(operation.docs.get("ei-8888-price-164312").status, "verified");
    assert.equal(operation.docs.get("ei-8888-price-164313"), undefined);
    assert.equal(gets.calls.every((call) => call.method === "GET"), true);
  });

  it("sends purple only after blue is independently verified", async () => {
    const jsonCalls = [];
    const blocked = await runEi8888PricePatch({
      stage: "purple",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([eiParent(), eiVariants()]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: eiJournal(),
      ...eiRecords(),
    });
    assert.equal(blocked.code, "stage_not_ready");
    assert.equal(jsonCalls.length, 0);
    const staleRemote = await runEi8888PricePatch({
      stage: "purple",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([eiParent(), eiVariants()]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: eiJournal({
        "ei-8888-price-164312": { status: "verified", rawBody: EI8888_BLUE_PRICE_PATCH_RAW_BODY, stage: "blue" },
      }),
      ...eiRecords(),
    });
    assert.equal(staleRemote.code, "baseline_blocked");
    assert.equal(staleRemote.blockers.includes("blue_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
    const operation = eiJournal({
      "ei-8888-price-164312": { status: "verified", rawBody: EI8888_BLUE_PRICE_PATCH_RAW_BODY, stage: "blue" },
    });
    const result = await runEi8888PricePatch({
      stage: "purple",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([
        eiParent({ price: 119750 }),
        eiVariants({ bluePrice: 126500, purplePrice: 119750 }),
        eiParent({ price: 126500 }),
        eiVariants({ bluePrice: 126500, purplePrice: 126500 }),
      ]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation,
      ...eiRecords(),
    });
    assert.equal(result.verified, true);
    assert.equal(result.nextStage, "");
    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0].rawBody, "{\"variant_id\":164313,\"price\":126500}");
    assert.equal(jsonCalls[0].rawBody.includes("164312"), false);
    assert.equal(operation.docs.get("ei-8888-price-164312").status, "verified");
    assert.equal(operation.docs.get("ei-8888-price-164313").status, "verified");
  });

  it("blocks a baseline conflict and an approval from the other product id", async () => {
    const jsonCalls = [];
    const baseline = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: remoteGets([eiParent({ visible: true, quantity: 19 }), eiVariants({ blueQty: 9 })]).perform,
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: eiJournal(),
      ...eiRecords(),
    });
    assert.equal(baseline.code, "baseline_blocked");
    assert.equal(baseline.blockers.includes("parent_not_hidden"), true);
    assert.equal(baseline.blockers.includes("parent_quantity_mismatch"), true);
    assert.equal(baseline.blockers.includes("blue_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
    const mismatched = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performJson: async (request) => { jsonCalls.push(request); return { status: 200 }; },
      operation: eiJournal(),
      ...eiRecords(EI_PRODUCTION, {
        approvals: [
          eiApproved(164312, EI8888_BLUE_PRICE_PATCH_RAW_BODY, EI_LOCAL),
          eiApproved(164313, EI8888_PURPLE_PRICE_PATCH_RAW_BODY, EI_LOCAL),
        ],
      }),
    });
    assert.equal(mismatched.code, "approval_blocked");
    assert.equal(mismatched.blockers.includes("blue_approval_missing"), true);
    assert.equal(mismatched.blockers.includes("purple_approval_missing"), true);
    assert.equal(jsonCalls.length, 0);
  });

  it("accepts either the local or production owner id and rejects the other identity", async () => {
    const remote = {
      parent: { state: "present", id: "618651", sku: "EI-8888", quantity: 20, price: 119750, visibility: "hidden" },
      variants: [
        { normalized: true, id: "164312", sku: "EI-8888-BLUE", price: 119750, quantity: 10 },
        { normalized: true, id: "164313", sku: "EI-8888-PURPLE", price: 119750, quantity: 10 },
      ],
    };
    for (const productId of [EI_LOCAL, EI_PRODUCTION]) {
      const preview = await previewEi8888PricePatch({
        env: {},
        host: "merchant.gini.iq",
        remote,
        operation: eiJournal(),
        skipConnection: true,
        ...eiRecords(productId),
      });
      assert.equal(preview.ownership.ok, true);
      assert.equal(preview.ownership.productId, productId);
      assert.equal(preview.ownership.blue.sourceVariantId, "blue-source");
      assert.equal(preview.ownership.purple.confirmedGiniVariantId, "164313");
      assert.equal(preview.approval.ok, true);
      assert.equal(preview.commission.ok, true);
      assert.equal(preview.writesEnabled, false);
      assert.equal(preview.readyForConfirmation, false);
      assert.equal(preview.sent, false);
    }
    const wrong = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performJson: async () => ({ status: 200 }),
      operation: eiJournal(),
      ...eiRecords(EI_PRODUCTION, {
        identities: [
          eiIdentity("EI-8888-BLUE", "164312", EI_LOCAL, "blue-source", "blue-size"),
          eiIdentity("EI-8888-PURPLE", "164313", EI_LOCAL, "purple-source", "purple-size"),
        ],
      }),
    });
    assert.equal(wrong.blockers.includes("blue_identity_mismatch"), true);
    assert.equal(wrong.blockers.includes("purple_identity_mismatch"), true);
  });

  it("records an uncertain write and does not retry it", async () => {
    const jsonCalls = [];
    const operation = eiJournal();
    const shared = {
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performGet: async (request) => (String(request.path).endsWith("/variants") ? eiVariants() : eiParent()),
      performJson: async () => {
        jsonCalls.push("patch");
        const err = new Error("timed out");
        err.code = "update_timeout";
        err.status = 504;
        throw err;
      },
      operation,
      ...eiRecords(),
    };
    const timedOut = await runEi8888PricePatch(shared);
    assert.equal(timedOut.code, "patch_uncertain");
    assert.equal(operation.docs.get("ei-8888-price-164312").status, "uncertain");
    const again = await runEi8888PricePatch(shared);
    assert.equal(again.code, "patch_not_retried");
    assert.equal(jsonCalls.length, 1);
    const restarted = await runEi8888PricePatch({
      ...shared,
      operation: eiJournal({ "ei-8888-price-164312": { status: "in_progress", stage: "blue", rawBody: EI8888_BLUE_PRICE_PATCH_RAW_BODY } }),
    });
    assert.equal(restarted.code, "restart_no_retry");
    assert.equal(jsonCalls.length, 1);
  });

  it("blocks a commission snapshot that is not the saved 5.5 percent rule", async () => {
    const jsonCalls = [];
    const wrongRate = await runEi8888PricePatch({
      stage: "blue",
      confirm: true,
      env: EI_OPEN,
      host: "merchant.gini.iq",
      performJson: async () => { jsonCalls.push("patch"); return { status: 200 }; },
      operation: eiJournal(),
      ...eiRecords(EI_PRODUCTION, { commissionSnapshot: { percentage: 7, basePrice: 119750, giniPrice: 128250, scope: "filter" } }),
    });
    assert.equal(wrongRate.code, "commission_blocked");
    assert.equal(wrongRate.blockers.includes("commission_rate_mismatch"), true);
    assert.equal(jsonCalls.length, 0);
    const product = {
      _id: EI_PRODUCTION,
      price: 119750,
      createdBy: { _id: "vendor-sokany" },
      brand: { _id: "brand-1" },
      category: { _id: "category-1" },
      subCategory: { _id: "sub-1" },
      collectionName: { _id: "col-1" },
      variants: [
        { _id: "blue-source", color: "Blue", sizes: [{ _id: "blue-size", size: "One", stockQuantity: 10, price: 119750 }] },
        { _id: "purple-source", color: "Purple", sizes: [{ _id: "purple-size", size: "One", stockQuantity: 10, price: 119750 }] },
      ],
    };
    const rules = [{
      scope: "vendor",
      percentage: 5.5,
      isActive: true,
      targetId: "vendor-sokany",
      targetName: { en: "Sokany" },
    }];
    const snapshot = await resolvePricePilotCommissionSnapshot({
      pilot: EI8888_PRICE_PILOT,
      stageOrder: ["blue", "purple"],
      productId: EI_PRODUCTION,
      identities: eiRecords(EI_PRODUCTION).identities,
      product,
      rules,
    });
    assert.equal(snapshot.percentage, 5.5);
    assert.equal(snapshot.basePrice, 119750);
    assert.equal(snapshot.giniPrice, 126500);
    const drifted = await resolvePricePilotCommissionSnapshot({
      pilot: EI8888_PRICE_PILOT,
      stageOrder: ["blue", "purple"],
      productId: EI_LOCAL,
      identities: eiRecords(EI_LOCAL).identities,
      product: { ...product, _id: EI_LOCAL },
      rules: [{ ...rules[0], percentage: 7 }],
    });
    assert.equal(assessEi8888CommissionSnapshot(drifted).ok, false);
  });

  it("keeps the EI-8888 sender on the shared signed PATCH client and off other marketplaces", () => {
    const route = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
    const service = fs.readFileSync(new URL("./services/giniVariantPricePatch.js", import.meta.url), "utf8");
    const plan = fs.readFileSync(new URL("./utils/giniVariantPricePatchPlan.js", import.meta.url), "utf8");
    const panel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniEi8888PricePatchPanel.jsx", import.meta.url), "utf8");
    assert.equal(route.includes("variant-sync/ei8888-price-patch"), true);
    assert.equal(route.includes("variant-sync/price-pilot/send"), false);
    assert.equal(plan.includes("6adc7945b3764a909f6931b1"), false);
    assert.equal(plan.includes("6aae4770023c0be610d48876"), false);
    assert.equal(plan.includes("GINI_EI8888_PRICE_PATCH_ENABLED"), true);
    assert.equal(plan.includes("GINI_ALLOW_LIVE_EI8888_PRICE_PATCH"), true);
    assert.equal(service.includes("performGiniJsonRequest"), true);
    assert.equal(service.includes("miswag"), false);
    assert.equal(service.includes("elryan"), false);
    assert.equal(service.includes("ibsher"), false);
    assert.equal(panel.includes("readyForConfirmation === true"), true);
    assert.equal(panel.includes("GINI_EI8888_PRICE_PATCH_ENABLED=true"), false);
    assert.equal(EI8888_BLUE_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164312,\"price\":126500}");
    assert.equal(EI8888_PURPLE_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164313,\"price\":126500}");
  });
});

function sokanyFilter(percentage, targetId = "vendor-sokany|_ALL_|category-1|_ALL_|_ALL_") {
  return {
    scope: "filter",
    percentage,
    isActive: true,
    targetId,
    targetName: { en: "Sokany" },
    vendorId: "vendor-sokany",
    brandId: "",
    categoryId: "category-1",
    subCategoryId: "",
    collectionId: "",
  };
}

function eiCatalogProduct(productId, { ownPrice = 119750 } = {}) {
  const size = (id) => ({ _id: id, size: "One", stockQuantity: 10, ...(ownPrice == null ? {} : { price: ownPrice }) });
  return {
    _id: productId,
    price: 119750,
    createdBy: { _id: "vendor-sokany" },
    brand: { _id: "brand-1" },
    category: { _id: "category-1" },
    subCategory: { _id: "sub-1" },
    collectionName: { _id: "col-1" },
    variants: [
      { _id: "blue-source", color: "Blue", sizes: [size("blue-size")] },
      { _id: "purple-source", color: "Purple", sizes: [size("purple-size")] },
    ],
  };
}

function legacyEiApprovals(productId) {
  return [164312, 164313].map((variantId, index) => ({
    operationKey: `ei-8888:${variantId}`,
    parentSku: "EI-8888",
    productId,
    variantId: String(variantId),
    variantSku: index === 0 ? "EI-8888-BLUE" : "EI-8888-PURPLE",
    status: "approved",
    baselinePrice: 119750,
    baselineQuantity: 10,
    proposedPrice: 126500,
    rawBody: index === 0 ? EI8888_BLUE_PRICE_PATCH_RAW_BODY : EI8888_PURPLE_PRICE_PATCH_RAW_BODY,
  }));
}

function eiRemoteBaseline() {
  return {
    parent: { state: "present", id: "618651", sku: "EI-8888", quantity: 20, price: 119750, visibility: "hidden" },
    variants: [
      { normalized: true, id: "164312", sku: "EI-8888-BLUE", price: 119750, quantity: 10 },
      { normalized: true, id: "164313", sku: "EI-8888-PURPLE", price: 119750, quantity: 10 },
    ],
  };
}

describe("EI-8888 commission snapshot refresh", () => {
  const productId = EI_PRODUCTION;
  const rules = [sokanyFilter(5.5), { scope: "all", percentage: 10, isActive: true, targetId: "all", targetName: { en: "All products" } }];
  const legacy = {
    ...eiRecords(productId, { approvals: legacyEiApprovals(productId), commissionSnapshot: null }),
  };

  function refreshInput(overrides = {}) {
    const saves = [];
    return {
      saves,
      input: {
        confirm: false,
        skipRemote: true,
        remote: eiRemoteBaseline(),
        product: eiCatalogProduct(productId),
        rules,
        owner: legacy.owner,
        identities: legacy.identities,
        approvals: legacy.approvals.map((row) => ({ ...row })),
        store: {
          async save(doc) {
            saves.push(doc);
            return true;
          },
        },
        ...overrides,
      },
    };
  }

  it("keeps a pre-deployment approval blocked until a confirmed snapshot refresh", async () => {
    const preview = await previewEi8888PricePatch({
      env: {},
      host: "merchant.gini.iq",
      remote: eiRemoteBaseline(),
      operation: eiJournal(),
      skipConnection: true,
      product: eiCatalogProduct(productId),
      rules,
      owner: legacy.owner,
      identities: legacy.identities,
      approvals: legacy.approvals,
    });
    assert.equal(preview.baseline.ok, true);
    assert.equal(preview.ownership.ok, true);
    assert.equal(preview.approval.ok, true);
    assert.equal(preview.commission.ok, false);
    assert.equal(preview.commission.blockers.includes("commission_snapshot_missing"), true);
    assert.equal(preview.commissionRefresh.ok, true);
    assert.equal(preview.commissionRefresh.applied, false);
    assert.equal(preview.commissionRefresh.snapshot.scope, "filter");
    assert.equal(preview.commissionRefresh.snapshot.percentage, rules[0].percentage);
    assert.equal(preview.commissionRefresh.snapshot.giniPrice, 126500);
    assert.equal(preview.writesEnabled, false);
    assert.equal(preview.readyForConfirmation, false);
    assert.equal(preview.sent, false);

    const { saves, input } = refreshInput();
    const dry = await refreshEi8888CommissionSnapshot(input);
    assert.equal(dry.applied, false);
    assert.equal(dry.ok, true);
    assert.equal(saves.length, 0);
    assert.equal(input.approvals.every((row) => row.commissionSnapshot == null), true);

    const confirmed = await refreshEi8888CommissionSnapshot({ ...input, confirm: true });
    assert.equal(confirmed.applied, true);
    assert.equal(confirmed.sent, false);
    assert.equal(confirmed.liveSend, false);
    assert.equal(saves.length, 2);
    assert.deepEqual(saves.map((row) => Object.keys(row).sort()), [["commissionSnapshot", "operationKey"], ["commissionSnapshot", "operationKey"]]);
    assert.equal(saves.every((row) => row.commissionSnapshot.percentage === rules[0].percentage), true);
    assert.equal(saves.every((row) => row.commissionSnapshot.scope === "filter" && row.commissionSnapshot.targetId === rules[0].targetId), true);
    assert.equal(saves.every((row) => row.baselinePrice == null && row.proposedPrice == null && row.rawBody == null), true);

    const storedApprovals = input.approvals.map((row, index) => ({ ...row, commissionSnapshot: saves[index].commissionSnapshot }));
    const released = await previewEi8888PricePatch({
      env: {},
      host: "merchant.gini.iq",
      remote: eiRemoteBaseline(),
      operation: eiJournal(),
      skipConnection: true,
      product: eiCatalogProduct(productId),
      rules,
      owner: legacy.owner,
      identities: legacy.identities,
      approvals: storedApprovals,
    });
    assert.equal(released.commission.ok, true);
    assert.equal(released.commissionRefresh.applied, false);
    assert.equal(released.readyForConfirmation, false);
    assert.equal(KE20_BLUE_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164306,\"price\":28000}");
    assert.equal(KE20_BLACK_PRICE_PATCH_RAW_BODY, "{\"variant_id\":164307,\"price\":28000}");
  });

  it("quotes from the parent selling price when a variant has no own price", async () => {
    const snapshot = await resolvePricePilotCommissionSnapshot({
      pilot: EI8888_PRICE_PILOT,
      stageOrder: ["blue", "purple"],
      productId,
      identities: legacy.identities,
      product: eiCatalogProduct(productId, { ownPrice: null }),
      rules,
    });
    assert.equal(snapshot.percentage, rules[0].percentage);
    assert.equal(snapshot.basePrice, 119750);
    assert.equal(snapshot.giniPrice, 126500);
    assert.equal(snapshot.scope, "filter");
  });

  it("rejects a missing, changed, ambiguous, or mismatched commission before any write", async () => {
    const missing = refreshInput({ rules: [] });
    const missingResult = await refreshEi8888CommissionSnapshot({ ...missing.input, confirm: true });
    assert.equal(missingResult.applied, false);
    assert.equal(missingResult.blockers.includes("commission_rule_missing"), true);
    assert.equal(missing.saves.length, 0);
    assert.equal(missingResult.snapshot, null);

    const changed = refreshInput({ rules: [sokanyFilter(7), rules[1]] });
    const changedResult = await refreshEi8888CommissionSnapshot({ ...changed.input, confirm: true });
    assert.equal(changedResult.applied, false);
    assert.equal(changedResult.blockers.includes("commission_rule_changed"), true);
    assert.equal(changed.saves.length, 0);

    const ambiguous = refreshInput({
      rules: [sokanyFilter(5.5, "sokany-a"), sokanyFilter(5.5, "sokany-b"), rules[1]],
    });
    const ambiguousResult = await refreshEi8888CommissionSnapshot({ ...ambiguous.input, confirm: true });
    assert.equal(ambiguousResult.applied, false);
    assert.equal(ambiguousResult.blockers.includes("commission_rule_ambiguous"), true);
    assert.equal(ambiguous.saves.length, 0);

    const mismatched = refreshInput({
      approvals: legacy.approvals.map((row) => ({ ...row, proposedPrice: 130000 })),
    });
    const mismatchedResult = await refreshEi8888CommissionSnapshot({ ...mismatched.input, confirm: true });
    assert.equal(mismatchedResult.applied, false);
    assert.equal(mismatchedResult.blockers.includes("blue_approval_missing"), true);
    assert.equal(mismatchedResult.blockers.includes("purple_approval_missing"), true);
    assert.equal(mismatched.saves.length, 0);

    const stored = legacy.approvals.map((row) => ({
      ...row,
      commissionSnapshot: { percentage: 5.5, basePrice: 119750, giniPrice: 126500, scope: "filter", targetId: rules[0].targetId },
    }));
    const drifted = refreshInput({ approvals: stored, rules: [sokanyFilter(7), rules[1]] });
    const driftedResult = await refreshEi8888CommissionSnapshot({ ...drifted.input, confirm: true });
    assert.equal(driftedResult.applied, false);
    assert.equal(driftedResult.blockers.includes("commission_rule_changed"), true);
    assert.equal(drifted.saves.length, 0);
    assert.equal(stored.every((row) => row.proposedPrice === 126500 && row.baselinePrice === 119750), true);

    const preview = await previewEi8888PricePatch({
      env: {},
      host: "merchant.gini.iq",
      remote: eiRemoteBaseline(),
      operation: eiJournal(),
      skipConnection: true,
      product: eiCatalogProduct(productId),
      rules: [sokanyFilter(7)],
      owner: legacy.owner,
      identities: legacy.identities,
      approvals: stored,
    });
    assert.equal(preview.commission.ok, false);
    assert.equal(preview.commission.blockers.includes("commission_rule_changed"), true);
    assert.equal(preview.readyForConfirmation, false);
  });

  it("does not let the snapshot refresh touch KE20 journals or enable a GINI write", () => {
    const service = fs.readFileSync(new URL("./services/giniVariantPricePatch.js", import.meta.url), "utf8");
    const route = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
    const refreshStart = service.indexOf("async function planCommissionSnapshotRefresh");
    const refreshEnd = service.indexOf("const ke20Runner");
    const refreshSource = service.slice(refreshStart, refreshEnd);
    assert.equal(refreshStart > 0, true);
    assert.equal(refreshSource.includes("GiniVariantPricePatch"), false);
    assert.equal(refreshSource.includes("KE20"), false);
    assert.equal(refreshSource.includes("5.5"), false);
    assert.equal(refreshSource.includes("miswag"), false);
    assert.equal(refreshSource.includes("elryan"), false);
    assert.equal(refreshSource.includes("ibsher"), false);
    assert.equal(route.includes("variant-sync/ei8888-price-patch/commission-snapshot"), true);
    assert.equal(route.includes("confirm: req.body?.confirm === true"), true);
    assert.equal(service.includes("EI-8888"), false);
  });
});
