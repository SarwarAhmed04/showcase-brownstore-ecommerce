import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GINI_HISTORICAL_HOLD_SKUS } from "./utils/giniHistoricalHold.js";
import {
  canReuseLocalPreviewRow,
  localPreviewFingerprint,
  storedLookupReusable,
} from "./utils/giniPreviewRecovery.js";

describe("GINI preview recovery decisions", () => {
  it("keeps all 60 historical holds", () => {
    assert.equal(GINI_HISTORICAL_HOLD_SKUS.length, 60);
    assert.equal(new Set(GINI_HISTORICAL_HOLD_SKUS).size, 60);
    assert.equal(GINI_HISTORICAL_HOLD_SKUS.includes("HB-632"), true);
  });

  it("reuses only a matching local classification", () => {
    const source = {
      classification: "BLOCKED",
      sku: "KEEP-1",
      payloadHash: "abc",
      blockers: ["missing_image"],
    };
    assert.equal(
      canReuseLocalPreviewRow(source, {
        classification: "BLOCKED",
        sku: "keep-1",
        payloadHash: "abc",
        blockers: ["missing_image"],
      }),
      true
    );
    assert.equal(
      canReuseLocalPreviewRow(
        { ...source, classification: "READY_CREATE", blockers: [] },
        { classification: "READY_CREATE", sku: "KEEP-1", payloadHash: "abc", blockers: [] }
      ),
      false
    );
    assert.equal(
      canReuseLocalPreviewRow(source, {
        classification: "BLOCKED",
        sku: "KEEP-1",
        payloadHash: "changed",
        blockers: ["missing_image"],
      }),
      false
    );
  });

  it("does not treat a refreshed sync time as a payload change and does not reuse another job's absence", () => {
    const first = localPreviewFingerprint({
      skuKey: "sku-1",
      payloadHash: "same",
      blockers: [],
      ownerIds: ["p1"],
      inactiveCodes: [],
      policySignature: "policy",
    });
    const refreshed = localPreviewFingerprint({
      skuKey: "sku-1",
      payloadHash: "same",
      blockers: [],
      ownerIds: ["p1"],
      inactiveCodes: [],
      policySignature: "policy",
    });
    const priced = localPreviewFingerprint({
      skuKey: "sku-1",
      payloadHash: "new-price",
      blockers: [],
      ownerIds: ["p1"],
      inactiveCodes: [],
      policySignature: "policy",
    });
    assert.equal(first, refreshed);
    assert.notEqual(first, priced);
    assert.deepEqual(storedLookupReusable({ lookupOutcome: "absent", lookupSkuKey: "sku-1" }, "sku-1"), { exists: false });
    assert.equal(storedLookupReusable({ classification: "READY_CREATE", payloadHash: "same" }, "sku-1"), null);
    assert.equal(storedLookupReusable({ lookupOutcome: "absent", lookupSkuKey: "sku-1" }, "sku-2"), null);
  });
});
