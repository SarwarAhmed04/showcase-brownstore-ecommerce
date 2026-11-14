import fs from "fs";
import assert from "node:assert/strict";
import test from "node:test";
import { IBSHER_AUTO_SYNC_INTERVAL_MS, catalogSyncPaused, ibsherAutoSyncEnabled, manualCatalogSyncAllowed, PAUSED_CATALOG_SYNC_AUTHORIZATION, startIbsherAutoSync } from "./utils/ibsherAutoSync.js";

function harness(env, extra = {}) {
  const calls = [];
  const timers = [];
  const logs = [];
  const result = startIbsherAutoSync({
    env,
    sync: () => {
      calls.push("sync");
      return Promise.resolve({ skipped: true });
    },
    setTimer: (fn, interval) => {
      timers.push({ fn, interval });
      return { fake: true };
    },
    log: (message) => logs.push(message),
    pauseFileExists: () => false,
    ...extra,
  });
  return { result, calls, timers, logs };
}

test("development does not import or start a timer unless opted in", () => {
  for (const env of [
    { NODE_ENV: "development" },
    { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "false" },
    { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "TRUE" },
    {},
  ]) {
    const run = harness(env);
    assert.equal(ibsherAutoSyncEnabled(env), false);
    assert.equal(run.result.enabled, false);
    assert.equal(run.result.timer, null);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.timers, []);
  }
});

test("development runs automatic sync only when the opt-in is exactly true", () => {
  const env = { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "true" };
  const run = harness(env);
  assert.equal(ibsherAutoSyncEnabled(env), true);
  assert.equal(run.result.enabled, true);
  assert.deepEqual(run.calls, ["sync"]);
  assert.equal(run.timers.length, 1);
  assert.equal(run.timers[0].interval, IBSHER_AUTO_SYNC_INTERVAL_MS);
});

test("production keeps automatic sync and ignores the development opt-in", () => {
  for (const env of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" },
    { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "" },
  ]) {
    const run = harness(env);
    assert.equal(ibsherAutoSyncEnabled(env), true);
    assert.equal(run.calls.length, 1);
    assert.equal(run.timers.length, 1);
    assert.equal(run.timers[0].interval, 60 * 60 * 1000);
  }
});

test("each production process start requests one immediate catalog sync", () => {
  const first = harness({ NODE_ENV: "production" });
  const restarted = harness({ NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" });
  assert.deepEqual(first.calls, ["sync"]);
  assert.deepEqual(restarted.calls, ["sync"]);
  assert.equal(first.timers[0].interval, 60 * 60 * 1000);
  assert.equal(restarted.timers[0].interval, 60 * 60 * 1000);
});

test("production pause blocks startup sync and does not schedule the hourly sync", () => {
  for (const env of [
    { NODE_ENV: "production", IBSHER_CATALOG_SYNC_PAUSED: "true" },
    { NODE_ENV: "production", IBSHER_CATALOG_SYNC_PAUSED: "YES", IBSHER_AUTO_SYNC_ENABLED: "true" },
    { NODE_ENV: "production", IBSHER_CATALOG_SYNC_PAUSED: "1" },
  ]) {
    const run = harness(env);
    assert.equal(catalogSyncPaused(env), true);
    assert.equal(ibsherAutoSyncEnabled(env), false);
    assert.equal(run.result.enabled, false);
    assert.equal(run.result.paused, true);
    assert.equal(run.result.timer, null);
    assert.deepEqual(run.calls, []);
    assert.match(run.logs.join("\n"), /IBSHER catalog auto-sync is paused/);
  }
});

test("a pause file blocks a production restart even when the development opt-in is unset", () => {
  const env = { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" };
  const run = harness(env, { pauseFileExists: () => true });
  assert.equal(run.result.paused, true);
  assert.deepEqual(run.calls, []);
  assert.equal(run.result.timer, null);
  assert.match(run.logs.join("\n"), /hourly schedule were not started/);
});

test("a scheduled tick does not sync after the pause file appears", () => {
  let paused = false;
  const run = harness({ NODE_ENV: "production" }, { pauseFileExists: () => paused });
  assert.deepEqual(run.calls, ["sync"]);
  paused = true;
  run.timers[0].fn();
  assert.deepEqual(run.calls, ["sync"]);
  assert.match(run.logs.join("\n"), /tick skipped/);
});

test("a paused Refresh Products request is refused unless it carries the explicit authorization", () => {
  const paused = { NODE_ENV: "production" };
  const file = () => true;
  assert.deepEqual(manualCatalogSyncAllowed({ env: paused, pauseFileExists: file, body: {} }).allowed, false);
  assert.equal(manualCatalogSyncAllowed({
    env: paused,
    pauseFileExists: file,
    body: { authorizePausedCatalogSync: PAUSED_CATALOG_SYNC_AUTHORIZATION },
  }).allowed, true);
  assert.equal(manualCatalogSyncAllowed({
    env: { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" },
    pauseFileExists: () => false,
    body: {},
  }).allowed, true);
});

test("startup uses the guard and paused refresh is refused before sync", () => {
  const index = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("./routes/admin.js", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../../client/src/api.js", import.meta.url), "utf8");
  assert.match(index, /startIbsherAutoSync\(\{\s*sync:\s*syncFromIbsher\s*\}\)/);
  assert.equal(index.includes("setInterval(refreshCatalog"), false);
  assert.equal(index.includes("refreshCatalog()"), false);
  assert.match(admin, /adminRouter\.post\("\/sync"/);
  assert.match(admin, /manualCatalogSyncAllowed/);
  assert.ok(admin.indexOf("manualCatalogSyncAllowed") < admin.indexOf("const result = await syncFromIbsher()"));
  assert.ok(admin.indexOf("manualCatalogSyncAllowed") < admin.indexOf("const result = await syncCategoriesFromIbsher()"));
  assert.match(admin, /Refresh Products was refused/);
  assert.match(admin, /Category refresh was refused/);
  assert.match(admin, /catalog\.sync_refused/);
  assert.equal(admin.includes("Category.deleteMany"), false);
  assert.equal(admin.includes("ibsherAutoSyncEnabled"), false);
  assert.match(client, /sync: \(\) => request\("\/api\/admin\/sync", \{ method: "POST" \}\)/);
  assert.equal(client.includes(PAUSED_CATALOG_SYNC_AUTHORIZATION), false);
});
