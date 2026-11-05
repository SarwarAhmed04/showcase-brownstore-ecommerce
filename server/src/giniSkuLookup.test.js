import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findExistingGiniProduct } from "./services/giniSkuLookup.js";
import { classifyGiniBulk } from "./utils/giniSyncEvaluate.js";

function response(status, body, extra = {}) {
  return { status, json: body, edgeBlocked: false, ...extra };
}

function direct(status, data = null) {
  return response(status, data ? { data } : { message: "no product" });
}

function search(items, lastPage, status = 200) {
  return response(status, { data: items, meta: lastPage == null ? {} : { last_page: lastPage } });
}

function lookupState(found) {
  return !found ? "skipped" : found.error ? "error" : found.exists ? "exists" : "absent";
}

function scriptedLookup(steps) {
  const calls = [];
  const perform = async (request) => {
    calls.push(request);
    const next = steps.shift();
    if (!next) throw new Error("unexpected GINI read");
    return next;
  };
  return { calls, perform };
}

describe("GINI SKU lookup absence safety", () => {
  it("keeps a direct exact match as a positive product and does not search", async () => {
    const { calls, perform } = scriptedLookup([
      direct(200, { id: 501, sku: "HA0449", image: "https://cdn.example/a.jpg" }),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.equal(found.exists, true);
    assert.equal(found.giniProductId, "501");
    assert.deepEqual(found.images, ["https://cdn.example/a.jpg"]);
    assert.equal(found.error, undefined);
    assert.equal(calls.length, 1);
    assert.equal(lookupState(found), "exists");
    assert.equal(classifyGiniBulk({ plan: { blockers: ["existing_gini_product"], lookupState: "exists" }, isActive: true }).classification, "ALREADY_EXISTS");
  });

  it("does not treat one HTTP 404 as absence", async () => {
    const { calls, perform } = scriptedLookup([
      direct(404),
      search([], null),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.equal(found.error, true);
    assert.equal(found.failure, "incomplete");
    assert.equal(found.reason, "search_pagination_incomplete");
    assert.notEqual(found.exists, false);
    assert.equal(calls.length, 2);
    assert.equal(lookupState(found), "error");
  });

  it("returns uncertain when search pages remain or the page list stops early", async () => {
    const incomplete = scriptedLookup([
      direct(404),
      ...Array.from({ length: 20 }, () => search([{ id: 1, sku: "OTHER" }], 100)),
    ]);
    const capped = await findExistingGiniProduct("HA0449", incomplete.perform);
    assert.equal(capped.error, true);
    assert.equal(capped.reason, "search_pagination_incomplete");
    assert.notEqual(capped.exists, false);
    assert.ok(incomplete.calls.length < 100);

    const failedPage = scriptedLookup([
      direct(404),
      search([], 2),
      response(500, { message: "upstream" }),
    ]);
    const broken = await findExistingGiniProduct("HA0449", failedPage.perform);
    assert.equal(broken.error, true);
    assert.equal(broken.status, 500);
    assert.notEqual(broken.exists, false);
    assert.equal(
      classifyGiniBulk({ plan: { blockers: ["gini_lookup_failed"], lookupState: "error" }, isActive: true }).classification,
      "LOOKUP_UNCERTAIN"
    );
  });

  it("keeps HTTP 429 and 5xx uncertain", async () => {
    const limited = await findExistingGiniProduct("HA0449", scriptedLookup([response(429, { message: "slow" }, { retryAfter: 2 })]).perform);
    assert.equal(limited.error, true);
    assert.equal(limited.failure, "rate_limited");
    assert.equal(limited.retryAfter, 2);
    assert.notEqual(limited.exists, false);

    const upstream = await findExistingGiniProduct("HA0449", scriptedLookup([response(503, { message: "down" })]).perform);
    assert.equal(upstream.error, true);
    assert.equal(upstream.status, 503);
    assert.notEqual(upstream.exists, false);
  });

  it("does not collapse duplicate remote SKUs into one product or into absence", async () => {
    const { perform } = scriptedLookup([
      direct(404),
      search(
        [
          { id: 501, sku: "HA0449" },
          { id: 777, sku: "HA0449" },
        ],
        1
      ),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.equal(found.error, true);
    assert.equal(found.failure, "duplicate");
    assert.equal(found.reason, "duplicate_remote_sku");
    assert.notEqual(found.exists, true);
    assert.notEqual(found.exists, false);
    assert.equal(lookupState(found), "error");
  });

  it("accepts absence only after a 404 and a finished search with no exact SKU", async () => {
    const { calls, perform } = scriptedLookup([
      direct(404),
      search([{ id: 9, sku: "OTHER" }], 2),
      search([], 2),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.deepEqual(found, { exists: false });
    assert.equal(calls.length, 3);
    assert.equal(lookupState(found), "absent");
    assert.equal(classifyGiniBulk({ plan: { blockers: [], lookupState: "absent" }, isActive: true }).classification, "READY_CREATE");
  });

  it("uses a later search page to identify a product that the direct read missed", async () => {
    const { perform } = scriptedLookup([
      direct(404),
      search([], 2),
      search([{ id: 501, sku: "HA0449", image: "https://cdn.example/b.jpg" }], 2),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.equal(found.exists, true);
    assert.equal(found.giniProductId, "501");
    assert.deepEqual(found.images, ["https://cdn.example/b.jpg"]);
  });

  it("does not call a non-404 direct read absent when search is empty", async () => {
    const { perform } = scriptedLookup([
      direct(200, { id: 12, sku: "OTHER" }),
      search([], 1),
    ]);
    const found = await findExistingGiniProduct("HA0449", perform);
    assert.equal(found.error, true);
    assert.equal(found.reason, "search_pagination_incomplete");
    assert.notEqual(found.exists, false);
  });
});
