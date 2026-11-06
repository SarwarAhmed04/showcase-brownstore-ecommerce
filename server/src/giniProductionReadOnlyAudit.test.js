import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import { giniSkuKey as canonicalSkuKey } from "./utils/giniSyncOnePlan.js";
import {
  LOCAL_HISTORICAL_SKUS,
  LOCAL_REFERENCE_SKUS,
  auditDatabase,
  closeAfterAudit,
  describeMongoTarget,
  giniSkuKey,
  inspectDeployment,
  maskClientId,
  overlapConfirmedWithReady,
  referencePresence,
  sanitizeText,
  writeGateSnapshot,
} from "./scripts/giniProductionReadOnlyAudit.js";

describe("GINI production read-only audit helpers", () => {
  it("keeps the local reference list at 59 SKUs and does not open a database on import", () => {
    assert.equal(LOCAL_REFERENCE_SKUS.length, 59);
    assert.equal(new Set(LOCAL_REFERENCE_SKUS).size, 59);
    for (const sku of LOCAL_HISTORICAL_SKUS) assert.equal(LOCAL_REFERENCE_SKUS.includes(sku), true);
    assert.equal(mongoose.connection.readyState, 0);
  });

  it("normalizes SKUs the same way as the GINI create plan", () => {
    assert.equal(giniSkuKey("  X0571 "), canonicalSkuKey("  X0571 "));
    assert.equal(giniSkuKey("Honor Pad"), "honor-pad");
  });

  it("describes a database target without keeping credentials", () => {
    const described = describeMongoTarget("mongodb://audit-user:audit-secret@db.example.com:27017/brownstore?authSource=admin");
    const text = JSON.stringify(described);
    assert.equal(text.includes("audit-secret"), false);
    assert.equal(text.includes("audit-user"), false);
    assert.equal(described.host, "db.example.com:27017");
    assert.equal(described.database, "brownstore");
    assert.equal(described.loopback, false);
    assert.equal(describeMongoTarget("mongodb://127.0.0.1:27017/brownstore").loopback, true);
    assert.equal(describeMongoTarget("").available, false);
  });

  it("removes connection strings and tokens from errors", () => {
    const cleaned = sanitizeText("failed mongodb+srv://user:secret@cluster.example/brownstore eyJabcdefgh.eyJabcdefgh.signature1");
    assert.equal(cleaned.includes("secret"), false);
    assert.equal(cleaned.includes("mongodb+srv://user"), false);
    assert.equal(cleaned.includes("eyJabcde12"), false);
  });

  it("counts ready overlap by SKU and product id separately", () => {
    const ready = {
      available: true,
      count: 3,
      bySku: new Set(["sku-a", "sku-b"]),
      byProduct: new Set(["product-b", "product-c"]),
    };
    const overlap = overlapConfirmedWithReady(
      [
        { sku: "SKU-A", skuKey: "sku-a", productId: "product-a" },
        { sku: "SKU-B", skuKey: "sku-b", productId: "product-b" },
        { sku: "SKU-C", skuKey: "sku-c", productId: "product-c" },
      ],
      ready
    );
    assert.equal(overlap.overlapByNormalizedSku, 2);
    assert.equal(overlap.overlapByProductId, 2);
    assert.equal(overlap.skuMatchWithoutProductMatch, 1);
    assert.equal(overlap.productMatchWithoutSkuMatch, 1);
    const missingReady = overlapConfirmedWithReady([{ sku: "SKU-A", skuKey: "sku-a", productId: "product-a" }], {
      available: false,
      count: null,
      bySku: new Set(),
      byProduct: new Set(),
    });
    assert.equal(missingReady.available, false);
    assert.equal(missingReady.overlapByNormalizedSku, null);
  });

  it("does not turn an unreadable collection into a zero count", () => {
    const presence = referencePresence(["LP-ID141232", "E6310221"], null, null, null);
    assert.equal(presence.presentInSendState, null);
    assert.equal(presence.presentInCreated, null);
    assert.equal(presence.missingFromSendState, null);
    const found = referencePresence(["LP-ID141232", "5301ATVN"], new Set(["lp-id141232"]), new Set(), new Set(["5301atvn"]));
    assert.deepEqual(found.missingFromSendState, ["5301ATVN"]);
    assert.deepEqual(found.readySkus, ["5301ATVN"]);
  });

  it("treats only the exact string true as a write gate", () => {
    const gates = writeGateSnapshot({
      GINI_BULK_WRITES_ENABLED: "TRUE",
      GINI_ALLOW_LIVE_BULK_WRITES: "true",
      GINI_RESYNC_WRITES_ENABLED: "false",
    });
    assert.equal(gates.gates.GINI_BULK_WRITES_ENABLED, false);
    assert.equal(gates.gates.GINI_ALLOW_LIVE_BULK_WRITES, true);
    assert.equal(gates.anyEnabled, true);
  });

  it("reads deployment metadata from this checkout without printing a database URI", () => {
    const deployment = inspectDeployment(path.dirname(fileURLToPath(import.meta.url)));
    assert.equal(deployment.serverPackageFound, true);
    assert.equal(deployment.packageName, "brownstore-server");
    assert.equal(deployment.safeguards.fullSyncSavedIdGuard.containsMarker, true);
    assert.equal(deployment.safeguards.resyncSearchStopsWhenPagesRemain.containsMarker, true);
    assert.equal(deployment.safeguards.resyncIncompleteSearchBlocksSend.containsMarker, true);
    assert.match(deployment.revision || "", /^[0-9a-f]{40}$/);
    const source = fs.readFileSync(new URL("./scripts/giniProductionReadOnlyAudit.js", import.meta.url), "utf8");
    assert.equal(source.includes("insertOne"), false);
    assert.equal(source.includes("updateOne"), false);
    assert.equal(source.includes("deleteOne"), false);
    assert.equal(source.includes("syncFromIbsher"), false);
    assert.equal(maskClientId("1423456789abcdef2bee"), "1423...2bee");
  });
});

const QUERY_MS = 120000;

function connectionDocument() {
  return {
    baseUrl: "https://merchant.gini.iq",
    clientId: "1423456789abcdef2bee",
    clientSecretEnc: "do-not-print",
    lastStatus: "ok",
    hasSecret: true,
    lastAuthOk: true,
    lastCategoriesOk: true,
    lastCategoriesCount: 4,
  };
}

function listCursor(names) {
  return {
    toArray() {
      return Promise.resolve(names.map((name) => ({ name })));
    },
    close() {
      return Promise.resolve();
    },
  };
}

function connectionOnlyDb(findOne) {
  return {
    listCollections() {
      return listCursor(["giniconnections"]);
    },
    collection(name) {
      if (name !== "giniconnections") throw new Error(`unexpected collection ${name}`);
      return { findOne };
    },
  };
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, value]) => doc[key] === value);
}

function deadlineCursor(rows, seen) {
  let timed = false;
  const cursor = {
    rows: rows.slice(),
    sort() {
      return this;
    },
    limit(count) {
      this.rows = this.rows.slice(0, count);
      return this;
    },
    maxTimeMS(ms) {
      assert.equal(ms, QUERY_MS);
      timed = true;
      seen.findDeadlines += 1;
      return this;
    },
    toArray() {
      assert.equal(timed, true, "find cursor was read without maxTimeMS()");
      return Promise.resolve(this.rows.slice());
    },
    next() {
      assert.equal(timed, true, "find cursor was read without maxTimeMS()");
      return Promise.resolve(this.rows[0] ?? null);
    },
    close() {
      return Promise.resolve();
    },
    async *[Symbol.asyncIterator]() {
      assert.equal(timed, true, "find cursor was read without maxTimeMS()");
      for (const row of this.rows) yield row;
    },
  };
  return cursor;
}

function commandCursor(rows) {
  return {
    toArray() {
      return Promise.resolve(rows.slice());
    },
    close() {
      return Promise.resolve();
    },
  };
}

function buildPopulatedDb(events) {
  const seen = { findDeadlines: 0, countFilters: [], aggregateCalls: 0, findOneOptions: null };
  const jobId = "preview-job-1";
  const docs = {
    ginisyncsendstates: [
      {
        sku: "HA0449",
        skuKey: "ha0449",
        productId: "product-1",
        giniProductId: "gini-1",
        jobId,
        confirmedAt: new Date("2026-03-02T00:00:00.000Z"),
        partner: "gini",
      },
    ],
    ginisyncproductresults: [
      { jobId, classification: "READY_CREATE", sku: "HA0449", skuKey: "ha0449", productId: "product-1" },
      { jobId, classification: "CREATED", sku: "HA0449", skuKey: "ha0449", productId: "product-1", giniProductId: "gini-1" },
    ],
    ginisyncjobs: [
      {
        _id: jobId,
        mode: "preview",
        status: "completed",
        runScope: "catalog",
        total: 3,
        processed: 3,
        eligible: 2,
        readyCreate: 1,
        alreadyExists: 0,
        blocked: 1,
        inactive: 1,
        reconcile: 0,
        lookupUncertain: 0,
        needsReview: 0,
        created: 0,
        finishedAt: new Date("2026-03-01T00:00:00.000Z"),
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ],
    ginisynconeaudits: [{ action: "CREATE", success: false }],
    giniresyncpreviews: [],
    giniresyncaudits: [],
    giniresyncjobs: [],
    giniresynclocks: [],
    giniconnections: [],
    products: [{ _id: "p1" }, { _id: "p2" }],
    platformtaxonomyconfigs: [{ partner: "gini" }, { partner: "miswag" }],
  };

  function makeCollection(name) {
    const rows = docs[name] || [];
    return {
      async countDocuments(filter, options) {
        assert.equal(options?.maxTimeMS, QUERY_MS);
        assert.equal(typeof Promise.resolve(0).maxTimeMS, "undefined");
        seen.countFilters.push(filter);
        return rows.filter((doc) => matches(doc, filter)).length;
      },
      find(filter) {
        return deadlineCursor(
          rows.filter((doc) => matches(doc, filter)),
          seen
        );
      },
      aggregate(pipeline, options) {
        assert.equal(options?.maxTimeMS, QUERY_MS);
        seen.aggregateCalls += 1;
        const groupId = pipeline?.[0]?.$group?._id;
        if (groupId && typeof groupId === "object") return commandCursor([]);
        const match = pipeline?.[0]?.$match || {};
        const grouped = new Map();
        for (const doc of rows) {
          if (!matches(doc, match)) continue;
          grouped.set(doc.classification, (grouped.get(doc.classification) || 0) + 1);
        }
        return commandCursor([...grouped].map(([_id, n]) => ({ _id, n })));
      },
      findOne(filter, options) {
        if (name !== "giniconnections") throw new Error(`findOne is not used on ${name}`);
        seen.findOneOptions = { filter, options };
        const pending = new Promise((resolve) => {
          setTimeout(() => {
            events.push("findOne");
            resolve(connectionDocument());
          }, 20);
        });
        assert.equal(typeof pending.maxTimeMS, "undefined");
        return pending;
      },
    };
  }

  return {
    seen,
    db: {
      listCollections() {
        return listCursor(Object.keys(docs));
      },
      collection(name) {
        if (!Object.hasOwn(docs, name)) throw new Error(`unexpected collection ${name}`);
        return makeCollection(name);
      },
    },
  };
}

function runAuditProcess(args = []) {
  const script = fileURLToPath(new URL("./scripts/giniProductionReadOnlyAudit.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.resolve(path.dirname(script), "..", ".."),
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("audit process timed out"));
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
}

describe("GINI production read-only audit driver cleanup", () => {
  it("passes maxTimeMS to findOne instead of calling it on the driver promise", async () => {
    const events = [];
    let options;
    const pendingHasMaxTime = [];
    const connection = {
      readyState: 1,
      db: connectionOnlyDb((filter, findOptions) => {
        assert.deepEqual(filter, {});
        options = findOptions;
        const pending = new Promise((resolve) => {
          setTimeout(() => {
            events.push("findOne");
            resolve(connectionDocument());
          }, 20);
        });
        pendingHasMaxTime.push(typeof pending.maxTimeMS);
        return pending;
      }),
      disconnect() {
        events.push("disconnect");
        this.readyState = 0;
        return Promise.resolve();
      },
    };

    const report = await closeAfterAudit(connection, () => auditDatabase(connection.db));

    assert.deepEqual(pendingHasMaxTime, ["undefined"]);
    assert.equal(options.maxTimeMS, QUERY_MS);
    assert.deepEqual(options.projection, { clientSecretEnc: 0 });
    assert.deepEqual(events, ["findOne", "disconnect"]);
    assert.equal(connection.readyState, 0);
    assert.equal(report.giniConnection.found, true);
    assert.equal(report.giniConnection.host, "merchant.gini.iq");
    assert.equal(report.giniConnection.hostMatchesEarlierRead, true);
    assert.equal(report.giniConnection.clientIdMask, "1423...2bee");
    assert.equal(report.giniConnection.clientIdMaskMatchesEarlierRead, true);
    assert.equal(JSON.stringify(report).includes("do-not-print"), false);
    assert.equal(JSON.stringify(report).includes("clientSecretEnc"), false);
  });

  it("awaits a rejected findOne and closes the client without an unhandled rejection", async () => {
    const events = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const connection = {
      readyState: 1,
      db: connectionOnlyDb(() => {
        const pending = new Promise((_, reject) => {
          setTimeout(() => {
            events.push("rejected");
            reject(new Error("Cannot use a session that has ended"));
          }, 20);
        });
        assert.equal(typeof pending.maxTimeMS, "undefined");
        return pending;
      }),
      disconnect() {
        events.push("disconnect");
        this.readyState = 0;
        return Promise.resolve();
      },
    };
    try {
      await assert.rejects(
        () => closeAfterAudit(connection, () => auditDatabase(connection.db)),
        /Cannot use a session that has ended/
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(events, ["rejected", "disconnect"]);
      assert.equal(unhandled.length, 0);
      assert.equal(connection.readyState, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps find, countDocuments, and aggregate on their supported driver APIs", async () => {
    const events = [];
    const { db, seen } = buildPopulatedDb(events);
    const connection = {
      readyState: 1,
      db,
      disconnect() {
        events.push("disconnect");
        this.readyState = 0;
        return Promise.resolve();
      },
    };

    const report = await closeAfterAudit(connection, () => auditDatabase(db));

    assert.equal(seen.findDeadlines, 6);
    assert.equal(seen.aggregateCalls, 2);
    assert.equal(seen.countFilters.length, 9);
    assert.equal(
      seen.countFilters.some((filter) => filter.partner === "gini"),
      true
    );
    assert.equal(
      seen.countFilters.some((filter) => filter.action === "CREATE" && filter.success === true),
      true
    );
    assert.equal(
      seen.countFilters.some((filter) => filter.total === 41415 && filter.readyCreate === 38551),
      true
    );
    assert.equal(seen.findOneOptions.options.maxTimeMS, QUERY_MS);
    assert.deepEqual(seen.findOneOptions.options.projection, { clientSecretEnc: 0 });
    assert.deepEqual(events, ["findOne", "disconnect"]);
    assert.equal(report.collections.giniconnections.present, true);
    assert.equal(report.collections.ginisynconepreviews.present, false);
    assert.equal(report.confirmedSends.documents, 1);
    assert.equal(report.confirmedSends.partnerGini, 1);
    assert.equal(report.confirmedSends.distinctNormalizedSku, 1);
    assert.equal(report.historicalCreates.createdRows, 1);
    assert.equal(report.confirmationGaps.available, true);
    assert.equal(report.confirmationGaps.emptyGiniProductIdCount, 0);
    assert.equal(report.referenceSkus.presentInSendState, 1);
    assert.equal(report.referenceSkus.expected, 59);
    assert.equal(report.syncOneSuccessfulCreates, 0);
    assert.equal(report.context.products, 2);
    assert.equal(report.context.giniTaxonomyMappings, 1);
    assert.equal(report.mappingCoverage.available, true);
    assert.equal(report.mappingCoverage.liveTreeChecked, false);
    assert.equal(report.mappingCoverage.collections, 0);
    assert.equal(report.mappingCoverage.mappedIsNotSendEligibility, true);
    assert.equal(report.resync.giniresynclocks, 0);
    assert.equal(report.resync.giniresyncpreviews, 0);
    assert.equal(report.previews.reportedCountMatches, 0);
    assert.equal(report.previews.reportedCounts.found, false);
    assert.equal(report.previews.latest.found, true);
    assert.equal(report.previews.latest.matchesReportedCounts, false);
    assert.equal(report.previews.latest.job.id, "preview-job-1");
    assert.equal(report.previews.latest.job.readyCreate, 1);
    assert.equal(report.previews.latest.overlap.overlapByNormalizedSku, 1);
    assert.equal(report.previews.latest.overlap.overlapByProductId, 1);
    assert.equal(report.previews.latest.overlap.readyRowCount, 1);
    assert.equal(report.previews.latest.overlap.storedRows, 2);
    assert.deepEqual(report.previews.latest.storedClassificationCounts, { READY_CREATE: 1, CREATED: 1 });
    assert.deepEqual(report.previews.latest.referenceSkusInReady, ["HA0449"]);
    assert.equal(report.giniConnection.lastCategoriesCount, 4);
    assert.equal(JSON.stringify(report).includes("do-not-print"), false);
  });

  it("does not chain maxTimeMS onto the findOne promise", () => {
    const source = fs.readFileSync(new URL("./scripts/giniProductionReadOnlyAudit.js", import.meta.url), "utf8");
    assert.equal(source.includes("findOne({}, { projection: { clientSecretEnc: 0 } }).maxTimeMS"), false);
    assert.equal(source.includes("maxTimeMS: QUERY_MS"), true);
    assert.equal(source.includes("--confirm-production"), true);
  });

  it("does not turn a disconnect failure into an unhandled rejection", async () => {
    const connection = {
      readyState: 1,
      db: connectionOnlyDb(() => Promise.resolve(connectionDocument())),
      disconnect() {
        this.readyState = 0;
        return Promise.reject(new Error("already closed"));
      },
    };
    const report = await closeAfterAudit(connection, () => auditDatabase(connection.db));
    assert.equal(report.giniConnection.found, true);
    assert.equal(connection.readyState, 0);
  });

  it("does not disconnect a client that was never opened", async () => {
    let called = false;
    const connection = {
      readyState: 0,
      disconnect() {
        called = true;
        return Promise.resolve();
      },
    };
    const value = await closeAfterAudit(connection, async () => "audit-skipped");
    assert.equal(value, "audit-skipped");
    assert.equal(called, false);
  });

  it("still refuses to run without --confirm-production", async () => {
    const result = await runAuditProcess([]);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-production/);
    assert.equal(result.stdout.includes("mongodb"), false);
    assert.equal(result.stderr.includes("mongodb+srv"), false);
  });
});
