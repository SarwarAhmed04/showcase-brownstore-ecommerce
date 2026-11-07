import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  ELRYAN_STAGING_SEND_SKU,
  buildElryanStagingSendBody,
  describeElryanSendResult,
  elryanStagingSendConfirmFacts,
  elryanStagingSendGate,
  elryanStagingSendRequest,
  shouldRetryElryanSend,
} from "../../client/src/components/admin/platform/elryanSyncOneSendGate.js";

const bothOn = { productWritesEnabled: true, liveWritesAllowed: true, productPostCalled: false };
const now = Date.parse("2026-10-31T12:00:00.000Z");

function readyPreview(overrides = {}) {
  return {
    readiness: "READY",
    blockers: [],
    previewToken: "preview-token",
    expiresAt: "2026-10-31T12:20:00.000Z",
    product: {
      id: "6adc7937b3764a909f692978",
      sku: "OWCH180002",
      name: { en: "Food Chopper" },
      stock: 3,
    },
    connection: { environment: "staging" },
    pricing: { proposedElryanPrice: 66250 },
    pricingApproval: { valid: true, reason: "matched" },
    proposedPayload: {
      price: 66250,
      quantity: 3,
      images: [{ fileUrl: "https://api.brownstore.net/api/media/uploads/products/chopper.webp" }],
    },
    sendAttempt: { blocked: false, status: "", releaseAllowed: false },
    ...overrides,
  };
}

function gate(preview, writesGate = bothOn, extra = {}) {
  return elryanStagingSendGate({ preview, writesGate, now, ...extra });
}

describe("Elryan Sync One send UI gate", () => {
  it("keeps send closed when both write flags are off", () => {
    const decision = gate(readyPreview(), { productWritesEnabled: false, liveWritesAllowed: false });
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, "writes_disabled");
    assert.equal(
      elryanStagingSendRequest({
        preview: readyPreview(),
        writesGate: { productWritesEnabled: false, liveWritesAllowed: false },
        now,
        confirm: true,
      }),
      null
    );
  });

  it("keeps send closed when only one write flag is on", () => {
    const productOnly = gate(readyPreview(), { productWritesEnabled: true, liveWritesAllowed: false });
    const liveOnly = gate(readyPreview(), { productWritesEnabled: false, liveWritesAllowed: true });
    assert.equal(productOnly.enabled, false);
    assert.equal(productOnly.reason, "writes_partial");
    assert.equal(liveOnly.enabled, false);
    assert.equal(liveOnly.reason, "writes_partial");
  });

  it("keeps Production closed even when Staging would be ready", () => {
    const production = gate(readyPreview({ connection: { environment: "production" } }));
    assert.equal(production.enabled, false);
    assert.equal(production.reason, "staging_only");
    const facts = elryanStagingSendConfirmFacts(readyPreview({ connection: { environment: "production" } }));
    assert.equal(facts.environment, "PRODUCTION");
    assert.equal(facts.createsRealStagingProduct, false);
  });

  it("opens only for a READY Staging preview with no blockers", () => {
    const open = gate(readyPreview());
    assert.equal(open.enabled, true);
    assert.equal(open.reason, "");
    const notReady = gate(readyPreview({ readiness: "NOT_READY" }));
    assert.equal(notReady.reason, "not_ready");
    const blocked = gate(readyPreview({ blockers: [{ code: "dimensions_unverified" }] }));
    assert.equal(blocked.reason, "blockers");
    const otherSku = gate(readyPreview({ product: { ...readyPreview().product, sku: "OTHER" } }));
    assert.equal(otherSku.reason, "wrong_sku");
  });

  it("keeps send closed without a matching Staging price approval", () => {
    const missing = gate(readyPreview({ pricingApproval: undefined }));
    assert.equal(missing.enabled, false);
    assert.equal(missing.reason, "pricing_unverified");
    const mismatched = gate(readyPreview({ pricingApproval: { valid: false, reason: "payload_mismatch" } }));
    assert.equal(mismatched.enabled, false);
    assert.equal(mismatched.reason, "pricing_unverified");
    const matched = gate(readyPreview({ pricingApproval: { valid: true, reason: "matched" } }));
    assert.equal(matched.enabled, true);
    assert.equal(
      elryanStagingSendRequest({
        preview: readyPreview({ pricingApproval: { valid: false, reason: "price" } }),
        writesGate: bothOn,
        now,
        confirm: true,
      }),
      null
    );
  });

  it("requires an explicit confirmation before building the send body", () => {
    const preview = readyPreview();
    assert.equal(buildElryanStagingSendBody(preview, false), null);
    assert.equal(buildElryanStagingSendBody(preview, "true"), null);
    assert.equal(buildElryanStagingSendBody(preview, undefined), null);
    assert.deepEqual(buildElryanStagingSendBody(preview, true), {
      productId: "6adc7937b3764a909f692978",
      previewToken: "preview-token",
      confirm: true,
    });
    const facts = elryanStagingSendConfirmFacts(preview);
    assert.equal(facts.sku, ELRYAN_STAGING_SEND_SKU);
    assert.equal(facts.environment, "STAGING");
    assert.equal(facts.price, 66250);
    assert.equal(facts.currency, "IQD");
    assert.equal(facts.quantity, 3);
    assert.equal(facts.image, "https://api.brownstore.net/api/media/uploads/products/chopper.webp");
    assert.equal(facts.createsRealStagingProduct, true);
  });

  it("rejects an expired preview token", () => {
    const expired = gate(readyPreview({ expiresAt: "2026-10-31T11:00:00.000Z" }));
    assert.equal(expired.enabled, false);
    assert.equal(expired.reason, "token_expired");
  });

  it("does not let a new preview token or an available SKU bypass an uncertain attempt", () => {
    const preview = readyPreview({
      previewToken: "brand-new-token",
      skuAvailable: true,
      sendAttempt: { blocked: true, status: "uncertain", releaseAllowed: false },
    });
    const decision = gate(preview);
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, "send_attempt_blocked");
    assert.equal(elryanStagingSendRequest({ preview, writesGate: bothOn, now, confirm: true }), null);
    assert.equal(shouldRetryElryanSend(), false);
    const outcome = describeElryanSendResult({
      ok: false,
      code: "send_uncertain",
      published: false,
      message: "blocked",
    });
    assert.equal(outcome.kind, "uncertain");
    assert.equal(outcome.retryBlocked, true);
    assert.equal(outcome.lines.includes("published"), false);
  });

  it("does not authorize another create from a stale in-progress attempt", () => {
    const decision = gate(
      readyPreview({
        sendAttempt: {
          blocked: true,
          status: "in_progress",
          startedAt: "2026-10-31T11:00:00.000Z",
        },
      })
    );
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, "send_attempt_blocked");
    const outcome = describeElryanSendResult({ ok: false, code: "send_in_progress", published: false });
    assert.equal(outcome.kind, "in_progress");
    assert.equal(outcome.retryBlocked, true);
  });

  it("keeps a confirmed success blocked and describes a mocked 201 in_review without calling it published", () => {
    const decision = gate(readyPreview({ sendAttempt: { blocked: true, status: "succeeded" } }));
    assert.equal(decision.reason, "send_attempt_blocked");
    const created = describeElryanSendResult({
      ok: true,
      code: "created",
      published: false,
      httpStatus: 201,
      message: "Elryan created the product. The response does not mark it published.",
    });
    assert.deepEqual(created.lines, ["created", "in_review"]);
    assert.equal(created.lines.includes("published"), false);
    assert.equal(created.retryBlocked, true);
    const inconsistent = describeElryanSendResult({ ok: true, code: "created", published: true });
    assert.equal(inconsistent.lines.includes("published"), false);
    const published = describeElryanSendResult({
      ok: true,
      code: "created_and_published",
      published: true,
    });
    assert.deepEqual(published.lines, ["created", "published"]);
  });

  it("labels write-flag, preview, and validation responses without a retry", () => {
    assert.equal(describeElryanSendResult({ code: "writes_disabled" }).kind, "writes_disabled");
    assert.equal(describeElryanSendResult({ code: "writes_gated" }).kind, "writes_disabled");
    assert.equal(describeElryanSendResult({ code: "preview_expired" }).kind, "preview_invalid");
    assert.equal(describeElryanSendResult({ code: "preview_mismatch" }).kind, "preview_invalid");
    assert.equal(describeElryanSendResult({ code: "staging_only" }).kind, "staging_only");
    const rejected = describeElryanSendResult({ ok: false, code: "elryan_rejected", published: false });
    assert.equal(rejected.kind, "validation_error");
    assert.equal(rejected.retryBlocked, false);
    assert.equal(rejected.tokenConsumed, true);
    assert.equal(shouldRetryElryanSend(), false);
  });

  it("does not call Elryan or post a product from the send screen source", () => {
    const ui = fs.readFileSync(
      new URL("../../client/src/components/admin/platform/ElryanSyncOneProduct.jsx", import.meta.url),
      "utf8"
    );
    const gateSource = fs.readFileSync(
      new URL("../../client/src/components/admin/platform/elryanSyncOneSendGate.js", import.meta.url),
      "utf8"
    );
    const api = fs.readFileSync(new URL("../../client/src/api.js", import.meta.url), "utf8");
    assert.equal(ui.includes("useEffect"), false);
    assert.equal(ui.includes("/v1/products"), false);
    assert.equal(gateSource.includes("/v1/products"), false);
    assert.equal(gateSource.includes("fetch("), false);
    assert.equal(ui.split("api.elryanSyncOneSend").length - 1, 1);
    const probe = ui.slice(ui.indexOf("async function onProbeWritesGate"), ui.indexOf("function onAskSend"));
    assert.equal(probe.includes("elryanWritesGate"), true);
    assert.equal(probe.includes("elryanSyncOneSend"), false);
    const refresh = ui.slice(ui.indexOf("async function onRefreshSendAttempt"), ui.indexOf("const reasonText"));
    assert.equal(refresh.includes("elryanSendAttempt"), true);
    assert.equal(refresh.includes("elryanSyncOneSend"), false);
    assert.match(ui, /role="dialog"/);
    assert.match(api, /elryanSyncOneSend: \(body\) =>\s*request\("\/api\/admin\/platforms\/elryan\/sync-one\/send"/);
    assert.equal(api.includes("/v1/products"), false);
  });
});
