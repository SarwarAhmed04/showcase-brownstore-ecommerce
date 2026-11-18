import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runPreparedVariantStageA } from "./services/giniVariantSync.js";
import {
  createPlanForParentLookup,
  dryRunItLobby38104,
  previewItLobby38104,
} from "./utils/giniVariant38104DryRun.js";

const OPEN = { GINI_VARIANT_SYNC_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_SYNC: "true" };

test("the 38104 dry-run previews the parent and both approved children without sending", () => {
  const preview = previewItLobby38104();
  const report = dryRunItLobby38104();
  assert.equal(report.dryRun, true);
  assert.equal(report.sentToGini, 0);
  assert.equal(report.canSend, false);
  assert.equal(report.writesEnabled, false);
  assert.equal(report.status, "APPROVED_FOR_FUTURE_SYNC");
  assert.equal(report.intendedAction, "future_sync_not_enabled");
  assert.equal(preview.parent.sku, "38104");
  assert.equal(preview.parent.category_id, "3");
  assert.equal(preview.parent.subcategory_id, "3");
  assert.equal(preview.parent.quantity, 0);
  assert.equal(preview.parent.is_visible, 0);
  assert.deepEqual(report.children.map((child) => child.sku), ["38104-BLACK", "38104-BLUE"]);
  assert.deepEqual(report.children.map((child) => [child.color, child.attributeId, child.price, child.stock, child.image]), [
    ["Black", "3696", 1000, 4, "/fixtures/38104-black.webp"],
    ["Blue", "3696", 1000, 3, "/fixtures/38104-blue.webp"],
  ]);
  assert.deepEqual(report.parent.images, ["/fixtures/38104-black.webp", "/fixtures/38104-blue.webp"]);
  const formSkus = preview.variants.fields.filter((field) => field.key.endsWith("[sku]")).map((field) => field.value);
  assert.deepEqual(formSkus, ["38104-BLACK", "38104-BLUE"]);
  assert.equal(report.createPlan.code, "parent_absent");
  assert.equal(report.createPlan.willCreate, true);
  assert.equal(report.createPlan.sentToGini, 0);
});

test("an existing parent or an uncertain lookup blocks the 38104 create plan", () => {
  const existing = createPlanForParentLookup("present");
  const uncertain = createPlanForParentLookup("uncertain");
  assert.equal(existing.blocked, true);
  assert.equal(existing.willCreate, false);
  assert.equal(existing.code, "parent_already_exists");
  assert.equal(uncertain.blocked, true);
  assert.equal(uncertain.willCreate, false);
  assert.equal(uncertain.code, "parent_lookup_uncertain");
  assert.equal(dryRunItLobby38104({ lookup: { parent: "present" } }).createPlan.code, "parent_already_exists");
  assert.equal(dryRunItLobby38104({ lookup: { parent: "error" } }).createPlan.code, "parent_lookup_uncertain");
});

test("the stage function does not create when the parent exists or the lookup is uncertain", async () => {
  const gates = ["GINI_VARIANT_SYNC_WRITES_ENABLED", "GINI_ALLOW_LIVE_VARIANT_SYNC"];
  const before = Object.fromEntries(gates.map((key) => [key, process.env[key]]));
  const existingMethods = [];
  const existing = await runPreparedVariantStageA({
    sku: "38104",
    approved: true,
    writesEnabled: true,
    env: OPEN,
    perform: async (request) => {
      existingMethods.push(request.method);
      return { status: 200, json: { data: { id: "1", sku: "38104" } } };
    },
  });
  const uncertainMethods = [];
  const uncertain = await runPreparedVariantStageA({
    sku: "38104",
    approved: true,
    writesEnabled: true,
    env: OPEN,
    perform: async (request) => {
      uncertainMethods.push(request.method);
      return { status: 503, json: {} };
    },
  });
  assert.equal(existing.code, "parent_already_exists");
  assert.equal(existing.sent, false);
  assert.deepEqual(existingMethods, ["GET"]);
  assert.equal(uncertain.code, "parent_lookup_uncertain");
  assert.equal(uncertain.sent, false);
  assert.deepEqual(uncertainMethods, ["GET"]);
  assert.deepEqual(Object.fromEntries(gates.map((key) => [key, process.env[key]])), before);
});

test("the dry-run command stays on the local fixture", () => {
  const source = fs.readFileSync(new URL("./scripts/giniVariant38104DryRun.js", import.meta.url), "utf8");
  assert.equal(source.includes("mongoose"), false);
  assert.equal(source.includes("performGiniRequest"), false);
  assert.equal(source.includes("GINI_VARIANT_SYNC_WRITES_ENABLED"), false);
  assert.equal(source.includes("GINI_ALLOW_LIVE_VARIANT_SYNC"), false);
});
