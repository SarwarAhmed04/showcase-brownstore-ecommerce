import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import {
  canRecommendCandidate,
  classifyRemoteObservation,
  createGetOnlyFetch,
  evaluateLoopbackAuthorization,
  interpretDirectGet,
  searchSkuCompletely,
  selectCandidateRows,
} from "./scripts/giniProductionPreflight.js";

function searchPage(items, lastPage) {
  return { status: 200, json: { data: items, meta: { last_page: lastPage } } };
}

function directFound(sku, id, merchantId = "merchant-1") {
  return { state: "found", status: 200, sku, giniProductId: id, merchantId };
}

function directMissing() {
  return { state: "absent", status: 404, sku: "", giniProductId: "", merchantId: "" };
}

function finishedSearch(state, matches = []) {
  return { state, complete: true, incomplete: false, status: 200, matches, reason: "" };
}

describe("GINI production preflight classification", () => {
  it("does not connect or send a write when the module loads", () => {
    assert.equal(mongoose.connection.readyState, 0);
    const source = fs.readFileSync(new URL("./scripts/giniProductionPreflight.js", import.meta.url), "utf8");
    assert.equal(source.includes('method: "POST"'), false);
    assert.equal(source.includes('method: "PUT"'), false);
    assert.equal(source.includes('method: "PATCH"'), false);
    assert.equal(source.includes('method: "DELETE"'), false);
    assert.equal(source.includes("insertOne"), false);
    assert.equal(source.includes("updateOne"), false);
    assert.equal(source.includes("deleteOne"), false);
    assert.equal(source.includes("--confirm-production"), true);
    assert.equal(source.includes("--allow-verified-production-loopback"), true);
    assert.equal(source.includes("findOne({}, { projection: { clientSecretEnc: 0 } }).maxTimeMS"), false);
    assert.equal(source.includes("maxTimeMS: QUERY_MS"), true);
  });

  it("treats a 404 plus an unfinished search as uncertain", () => {
    const result = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directMissing(),
      search: {
        state: "incomplete",
        complete: false,
        incomplete: true,
        status: 200,
        matches: [],
        reason: "search_pagination_incomplete",
      },
    });
    assert.equal(result.classification, "UNCERTAIN");
    assert.equal(result.reason, "search_pagination_incomplete");
  });

  it("verifies missing only after a 404 and a finished empty search", () => {
    const result = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directMissing(),
      search: finishedSearch("absent"),
    });
    assert.equal(result.classification, "VERIFIED_MISSING");
    assert.equal(result.giniProductId, "");
  });

  it("keeps a search match that a direct 404 did not see", () => {
    const result = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directMissing(),
      search: finishedSearch("found", [{ sku: "HA0449", giniProductId: "501", merchantId: "merchant-1" }]),
    });
    assert.equal(result.classification, "EXISTS");
    assert.equal(result.giniProductId, "501");
    assert.equal(result.reason, "complete_search_match");
  });

  it("does not call an unfinished search match confirmed present or missing", () => {
    const result = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directMissing(),
      search: {
        state: "found",
        complete: false,
        incomplete: true,
        matches: [{ sku: "HA0449", giniProductId: "501", merchantId: "merchant-1" }],
        reason: "search_pagination_incomplete",
      },
    });
    assert.equal(result.classification, "UNCERTAIN");
    assert.equal(result.giniProductId, "501");
  });

  it("accepts a direct exact match as existing", () => {
    const result = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directFound("HA0449", "501"),
      search: finishedSearch("absent"),
    });
    assert.equal(result.classification, "EXISTS");
    assert.equal(result.reason, "direct_sku_get");
  });

  it("keeps conflicting ids and merchant ids uncertain", () => {
    const ids = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directFound("HA0449", "501", "merchant-1"),
      search: finishedSearch("duplicate", [
        { sku: "HA0449", giniProductId: "501", merchantId: "merchant-1" },
        { sku: "HA0449", giniProductId: "777", merchantId: "merchant-1" },
      ]),
    });
    assert.equal(ids.classification, "UNCERTAIN");
    assert.equal(ids.reason, "duplicate_remote_sku");
    const merchants = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directFound("HA0449", "501", "merchant-1"),
      search: finishedSearch("found", [{ sku: "HA0449", giniProductId: "501", merchantId: "merchant-2" }]),
    });
    assert.equal(merchants.classification, "UNCERTAIN");
    assert.equal(merchants.reason, "account_conflict");
  });

  it("does not turn a rate limit or a lone failed direct read into verified missing", () => {
    const limited = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: { state: "rate_limited", status: 429, sku: "", giniProductId: "", merchantId: "" },
      search: finishedSearch("absent"),
    });
    assert.equal(limited.classification, "UNCERTAIN");
    const failedDirect = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: { state: "uncertain", status: 500, sku: "", giniProductId: "", merchantId: "" },
      search: finishedSearch("absent"),
    });
    assert.equal(failedDirect.classification, "UNCERTAIN");
    assert.notEqual(failedDirect.classification, "VERIFIED_MISSING");
  });

  it("stops a long search at the page cap instead of calling it empty", async () => {
    const pages = [];
    const search = await searchSkuCompletely(
      "HA0449",
      async (page) => {
        pages.push(page);
        return searchPage([{ sku: "OTHER", id: String(page), merchant_id: "merchant-1" }], 6);
      },
      { pageCap: 2 }
    );
    assert.deepEqual(pages, [1, 2]);
    assert.equal(search.complete, false);
    assert.equal(search.reason, "search_pagination_incomplete");
    const classified = classifyRemoteObservation({
      expectedKey: "HA0449",
      direct: directMissing(),
      search,
    });
    assert.equal(classified.classification, "UNCERTAIN");
  });

  it("reads every page when the search reports a short last page", async () => {
    const search = await searchSkuCompletely("HA0449", async (page) => {
      if (page === 1) return searchPage([{ sku: "OTHER", id: "1" }], 2);
      return searchPage([{ sku: "HA0449", id: "501", merchant_id: "merchant-1" }], 2);
    });
    assert.equal(search.complete, true);
    assert.equal(search.state, "found");
    const direct = interpretDirectGet({ status: 404, json: {} });
    assert.equal(direct.state, "absent");
  });

  it("blocks every GINI method except GET", async () => {
    let called = 0;
    const guarded = createGetOnlyFetch(async () => {
      called += 1;
      return { ok: true };
    });
    await assert.rejects(() => guarded("https://merchant.gini.iq/products", { method: "POST" }), /Blocked POST/);
    await assert.rejects(() => guarded("https://merchant.gini.iq/products", { method: "DELETE" }), /Blocked DELETE/);
    const response = await guarded("https://merchant.gini.iq/products", { method: "GET" });
    assert.equal(response.ok, true);
    assert.equal(called, 1);
  });

  it("skips historical and Sync One SKUs when choosing a candidate", () => {
    const held = new Set(["ha0449", "sync-one"]);
    const selected = selectCandidateRows(
      [
        { sku: "HA0449", skuKey: "ha0449", productId: "old" },
        { sku: "SYNC-ONE", skuKey: "sync-one", productId: "audit" },
        { sku: "NEW-1", skuKey: "new-1", productId: "fresh" },
      ],
      held
    );
    assert.deepEqual(selected, [{ sku: "NEW-1", skuKey: "new-1", productId: "fresh" }]);
  });

  it("recommends a candidate only when the production evidence and a verified miss agree", () => {
    const base = {
      previewMatchesReported: true,
      sendStateCount: 0,
      historicalCreatedCount: 0,
      syncOneSuccessCount: 1,
      historicalReadyCount: 29,
      writeGatesEnabled: false,
      merchantHostMatches: true,
      clientMaskMatches: true,
      candidateClassification: "VERIFIED_MISSING",
      candidateHeld: false,
    };
    assert.equal(canRecommendCandidate(base), true);
    assert.equal(canRecommendCandidate({ ...base, historicalReadyCount: 28 }), false);
    assert.equal(canRecommendCandidate({ ...base, sendStateCount: 1 }), false);
    assert.equal(canRecommendCandidate({ ...base, candidateClassification: "UNCERTAIN" }), false);
    assert.equal(canRecommendCandidate({ ...base, candidateClassification: "EXISTS" }), false);
    assert.equal(canRecommendCandidate({ ...base, writeGatesEnabled: true }), false);
    assert.equal(canRecommendCandidate({ ...base, candidateHeld: true }), false);
  });

  it("accepts loopback only for the verified production deployment", () => {
    const verified = {
      confirmProduction: true,
      allowLoopback: true,
      loopback: true,
      databaseName: "brownstore",
      deployment: { serverPackageFound: true, packageName: "brownstore-server" },
      merchant: { hostMatches: true, clientMaskMatches: true },
      preview: {
        found: true,
        total: 41415,
        readyCreate: 38551,
        alreadyExists: 0,
        blocked: 661,
        inactive: 2203,
      },
    };
    assert.equal(evaluateLoopbackAuthorization(verified).reason, "verified_production_loopback");
    assert.equal(evaluateLoopbackAuthorization({ ...verified, allowLoopback: false }).reason, "loopback_not_authorized");
    assert.equal(evaluateLoopbackAuthorization({ ...verified, confirmProduction: false }).reason, "confirmation_required");
    assert.equal(evaluateLoopbackAuthorization({ ...verified, loopback: false, allowLoopback: false }).reason, "remote_database");
  });

  it("fails closed for an unverified local loopback database", () => {
    const local = {
      confirmProduction: true,
      allowLoopback: true,
      loopback: true,
      databaseName: "brownstore",
      deployment: { serverPackageFound: true, packageName: "brownstore-server" },
      merchant: { hostMatches: false, clientMaskMatches: false },
      preview: { found: false },
    };
    assert.equal(evaluateLoopbackAuthorization(local).allowed, false);
    assert.equal(evaluateLoopbackAuthorization(local).reason, "production_context_unverified");
    assert.equal(evaluateLoopbackAuthorization({ ...local, databaseName: "brownstore-dev" }).allowed, false);
    assert.equal(
      evaluateLoopbackAuthorization({
        ...local,
        merchant: { hostMatches: true, clientMaskMatches: true },
        deployment: { serverPackageFound: false, packageName: null },
      }).allowed,
      false
    );
    assert.equal(
      evaluateLoopbackAuthorization({
        ...local,
        merchant: { hostMatches: true, clientMaskMatches: true },
        preview: { found: true, total: 10, readyCreate: 10, alreadyExists: 0, blocked: 0, inactive: 0 },
      }).allowed,
      false
    );
  });

  it("refuses to run without --confirm-production", async () => {
    const script = fileURLToPath(new URL("./scripts/giniProductionPreflight.js", import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: path.resolve(path.dirname(script), "..", ".."),
        env: process.env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("preflight process timed out"));
      }, 20000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-production/);
  });
});
