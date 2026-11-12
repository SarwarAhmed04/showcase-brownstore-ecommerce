import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GINI_PUT_DOCUMENTED_FIELDS } from "./utils/giniProductUpdateContract.js";
import { GINI_VARIANT_UPDATE_CAPABILITIES, buildSingleVariantStockPatch, ke20BlackQuantityPilotPatch } from "./utils/giniVariantUpdateContract.js";
import { auditBlockedProducts, buildGenericChangedPreview, planVariantChange, selectPricePilot } from "./utils/giniVariantChangedPlan.js";
import { previewVariantChangedSync } from "./services/giniVariantChangedSync.js";
import { canSendVariantChangedSync } from "../../client/src/components/admin/platform/giniVariantSyncDisplay.js";

const LABELS = ["Blue", "Black", "Purple"];

function combo(sku, color, stock, price, sourceVariantId, sourceSizeId) {
  return { sourceVariantId, sourceSizeId, color, stock, price, proposedSku: sku, images: 1 };
}

function approved(sku, sourceVariantId, sourceSizeId, confirmedGiniVariantId, status = "verified") {
  return { sourceVariantId, sourceSizeId, approvedSku: sku, status, confirmedGiniVariantId };
}

function remoteRow(sku, color, quantity, price, id) {
  return { id, sku, quantity, price, attributes: [{ id: 3696, value: color }] };
}

function matchedRemote(rows, quantity = 14) {
  return {
    state: "present",
    id: "613402",
    sku: "KE20",
    visibility: "hidden",
    quantity,
    categoryId: "2",
    subcategoryId: "18",
    categoryKnown: true,
    subcategoryKnown: true,
    variants: rows,
  };
}

function base(overrides = {}) {
  const combinations = overrides.combinations || [
    combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"),
    combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
  ];
  return {
    productId: "product-1",
    parentSku: "KE20",
    vendorId: "vendor-1",
    categoryId: "2",
    subcategoryId: "18",
    combinations,
    identities: overrides.identities || [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
    ],
    remote: overrides.remote || matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
    ]),
    colorLabels: LABELS,
    colorAttributeId: "3696",
    ...overrides,
    combinations,
  };
}

function assertNoWrite(plan) {
  assert.equal(plan.canSend, false);
  assert.equal(plan.createAllowed, false);
  assert.equal(plan.replacementPayload, null);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.noDeletion, true);
  assert.equal(plan.recordTransfer, "not_copied");
  assert.equal(plan.changes.some((change) => change.action === "delete"), false);
}

test("documented variant stock update is one variant and is not sent", () => {
  assert.equal(GINI_PUT_DOCUMENTED_FIELDS.includes("variants"), false);
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.singleVariantStockUpdate, "DOCUMENTED_NOT_LIVE_TESTED");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.putVariantsReplacesCompleteSet, "NOT_STATED");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.quantityZero, "NOT_STATED_ON_SINGLE_PATCH");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.addColor, "REQUEST_EXISTS_OMITTED_VALUES_NOT_STATED");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.variantDeletion, "ENDPOINT_EXISTS_EFFECT_NOT_STATED");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.variantDeactivation, "NOT_DOCUMENTED");
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.writesEnabled, false);
  assert.equal(GINI_VARIANT_UPDATE_CAPABILITIES.liveTested, false);
  assert.equal(canSendVariantChangedSync(), false);
  const patch = ke20BlackQuantityPilotPatch();
  assert.equal(patch.ok, true);
  assert.equal(patch.liveSend, false);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/api/v2.0/third-party/products/KE20/stock");
  assert.equal(patch.rawBody, "{\"variant_id\":164307,\"quantity\":9}");
  assert.equal(patch.rawBody.includes("164306"), false);
  assert.equal(patch.replacesVariantSet, false);
  const zero = buildSingleVariantStockPatch({ parentSku: "KE20", variantId: "164307", quantity: 0 });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, "quantity_zero_not_stated");
  assert.equal(zero.liveSend, false);
  const missing = buildSingleVariantStockPatch({ parentSku: "KE20", quantity: 9 });
  assert.equal(missing.code, "missing_remote_variant_id");
  const connection = fs.readFileSync(new URL("./services/giniConnection.js", import.meta.url), "utf8");
  const changed = fs.readFileSync(new URL("./services/giniVariantChangedSync.js", import.meta.url), "utf8");
  assert.equal(connection.includes('verb !== "PUT" && verb !== "PATCH"'), true);
  assert.equal(changed.includes("buildSingleVariantStockPatch"), false);
  assert.equal(changed.includes("ke20BlackQuantityPilotPatch"), false);
});

test("an existing reconciled parent is unchanged and is not created again", () => {
  const plan = planVariantChange(base());
  assert.equal(plan.disposition, "UNCHANGED");
  assert.equal(plan.knownParent, true);
  assert.equal(plan.differences.length, 0);
  assertNoWrite(plan);
  const withGallery = planVariantChange(base({
    combinations: [
      { ...combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"), images: 2 },
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
    remote: matchedRemote([
      { ...remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"), image: "https://cdn.example/blue.webp" },
      { ...remoteRow("KE20-BLACK", "Black", 4, 26500, "12"), image: "https://cdn.example/black.webp" },
    ]),
  }));
  assert.equal(withGallery.disposition, "UNCHANGED");
  assert.equal(withGallery.imageNotes[0].sku, "KE20-BLUE");
  assert.equal(withGallery.imageNotes[0].localImages, 2);
  assert.equal(withGallery.imageNotes[0].remoteImages, 1);
  assertNoWrite(withGallery);
});

test("a remotely absent new parent is not sent while bulk writes are off", () => {
  const plan = planVariantChange(base({
    parentSku: "FRESH-1",
    identities: [
      approved("FRESH-1-BLUE", "a", "b", "", "approved"),
      approved("FRESH-1-BLACK", "c", "d", "", "approved"),
    ],
    combinations: [
      combo("FRESH-1-BLUE", "Blue", 2, 1000, "a", "b"),
      combo("FRESH-1-BLACK", "Black", 3, 1000, "c", "d"),
    ],
    remote: { state: "absent", status: 404, variants: null },
  }));
  assert.equal(plan.disposition, "NEW");
  assert.equal(plan.knownParent, false);
  assert.equal(plan.blockers.includes("bulk_variant_writes_disabled"), true);
  assertNoWrite(plan);
});

test("a quantity change is recorded and not written", () => {
  const plan = planVariantChange(base({
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 1, 26500, "12"),
    ], 11),
  }));
  assert.equal(plan.disposition, "CHANGED");
  assert.equal(plan.changes.some((change) => change.kind === "quantity" && change.action === "documented_not_sent" && change.to === 4 && change.variantId === "12"), true);
  assertNoWrite(plan);
});

test("quantity becoming zero stays unverified and is not sent", () => {
  const plan = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 0, 26500, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  }));
  assert.equal(plan.disposition, "CHANGED");
  const zero = plan.changes.find((change) => change.kind === "quantity_zero");
  assert.equal(zero.action, "quantity_zero_not_stated");
  assert.equal(zero.to, 0);
  assertNoWrite(plan);
});

test("a price change is unsupported", () => {
  const plan = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 10, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  }));
  assert.equal(plan.disposition, "CHANGED");
  assert.equal(plan.changes.some((change) => change.kind === "price" && change.from === 26500 && change.to === 27000 && change.action === "documented_not_sent" && change.variantId === "11"), true);
  assertNoWrite(plan);
});

test("a new mapped color is not added by replacing the remote set", () => {
  const combinations = [
    combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"),
    combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    combo("KE20-PURPLE", "Purple", 2, 26500, "e", "f"),
  ];
  const plan = planVariantChange(base({
    combinations,
    identities: [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
      approved("KE20-PURPLE", "e", "f", "", "approved"),
    ],
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
    ], 16),
  }));
  const added = plan.changes.find((change) => change.kind === "new_color");
  assert.equal(added.sku, "KE20-PURPLE");
  assert.equal(added.action, "blocked_unsupported");
  assert.equal(added.attributeId, "3696");
  assert.equal(plan.disposition, "CHANGED");
  assertNoWrite(plan);
});

test("a removed color stays on GINI for manual review", () => {
  const plan = planVariantChange(base({
    identities: [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
      approved("KE20-PURPLE", "e", "f", "13"),
    ],
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
      remoteRow("KE20-PURPLE", "Purple", 2, 26500, "13"),
    ], 16),
  }));
  assert.equal(plan.disposition, "BLOCKED");
  assert.equal(plan.blockers.includes("removed_color_needs_review"), true);
  assert.equal(plan.manualReview.some((row) => row.sku === "KE20-PURPLE" && row.action === "keep"), true);
  assert.equal(plan.changes.some((change) => change.action === "delete"), false);
  assertNoWrite(plan);
});

test("duplicate parent and variant SKU conflicts block both copies", () => {
  const duplicate = planVariantChange(base({ catalogBlockers: ["duplicate_parent_sku"] }));
  assert.equal(duplicate.disposition, "BLOCKED");
  assert.equal(duplicate.blockers.includes("duplicate_parent_sku"), true);
  const conflict = planVariantChange(base({ variantSkuConflict: true }));
  assert.equal(conflict.disposition, "BLOCKED");
  assert.equal(conflict.blockers.includes("variant_sku_conflict"), true);
  assertNoWrite(duplicate);
  assertNoWrite(conflict);
});

test("an unknown remote variant is kept and blocks replacement", () => {
  const plan = planVariantChange(base({
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
      remoteRow("VENDOR-RED", "Red", 1, 100, "99"),
    ], 15),
  }));
  assert.equal(plan.disposition, "BLOCKED");
  assert.equal(plan.blockers.includes("unknown_remote_variant"), true);
  assert.equal(plan.manualReview.some((row) => row.sku === "VENDOR-RED" && row.action === "keep"), true);
  assertNoWrite(plan);
});

test("an incomplete variant response is uncertain and sends nothing", () => {
  const plan = planVariantChange(base({
    remote: { state: "present", id: "1", sku: "KE20", visibility: "hidden", quantity: 14, variants: null },
  }));
  assert.equal(plan.disposition, "UNCERTAIN");
  assert.equal(plan.blockers.includes("incomplete_api_response"), true);
  assertNoWrite(plan);
});

test("an uncertain earlier operation is not retried", () => {
  const plan = planVariantChange(base({ operationStatus: "variants_uncertain" }));
  assert.equal(plan.disposition, "UNCERTAIN");
  assert.equal(plan.blockers.includes("variants_uncertain"), true);
  assertNoWrite(plan);
});

test("local and production identity differences are reviewed and not imported", () => {
  const conflict = planVariantChange(base({
    environment: "production",
    identityOrigin: "local",
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "99"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
    ]),
  }));
  assert.equal(conflict.disposition, "BLOCKED");
  assert.equal(conflict.blockers.includes("conflicting_identity"), true);
  assert.equal(conflict.recordTransfer, "not_copied");
  const absent = planVariantChange(base({
    environment: "production",
    remote: { state: "absent", status: 404, variants: null },
  }));
  assert.equal(absent.disposition, "BLOCKED");
  assert.equal(absent.blockers.includes("conflicting_identity"), true);
  assert.equal(absent.createAllowed, false);
});

test("missing color spellings stay grouped and never receive an invented id", async () => {
  const { collectMissingColors } = await import("./utils/giniVariantChangedPlan.js");
  const rows = collectMissingColors([
    { colorPreview: [{ color: "white", status: "missing" }, { color: "Blue", status: "mapped", attributeId: "3696" }] },
    { colorPreview: [{ color: "White", status: "missing" }] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productCount, 2);
  assert.equal(rows[0].attributeId, "");
  assert.equal(rows[0].color.includes("White"), true);
});

test("a missing color has no invented attribute id and multi-size stays blocked", () => {
  const missing = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"),
      combo("KE20-GREEN", "Green", 4, 26500, "c", "d"),
    ],
    identities: [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-GREEN", "c", "d", "12"),
    ],
  }));
  assert.equal(missing.disposition, "BLOCKED");
  assert.equal(missing.colorPreview.find((row) => row.color === "Green").attributeId, "");
  assert.equal(missing.colorPreview.find((row) => row.color === "Green").status, "missing");
  const sized = planVariantChange(base({ multipleSizes: true }));
  assert.equal(sized.disposition, "BLOCKED");
  assert.equal(sized.blockers.includes("size_attribute_unverified"), true);
});

test("the dry run only reads and keeps bulk variant writes off", async () => {
  const methods = [];
  const result = await previewVariantChangedSync({
    skipDatabase: true,
    identities: [],
    operations: [],
    simpleJob: { status: "preview", readyCreate: 3, alreadyExists: 2, changed: 1, unchanged: 4, blocked: 5, inactive: 0 },
    loadCatalog: async () => ({ products: [] }),
    perform: async (request) => {
      methods.push(String(request.method).toUpperCase());
      if (String(request.method).toUpperCase() !== "GET") throw new Error("write");
      if (request.path.includes("/attributes/")) {
        return { status: 200, json: { data: { id: 3696, name: "Color", values: LABELS } } };
      }
      if (request.path.endsWith("/variants")) return { status: 200, json: { data: [] } };
      const sku = decodeURIComponent(request.path.split("/").pop());
      return { status: 200, json: { data: { id: "9", sku, quantity: 0, is_visible: 0 } } };
    },
  });
  assert.deepEqual([...new Set(methods)], ["GET"]);
  assert.equal(methods.length, 13);
  assert.equal(result.canSend, false);
  assert.equal(result.bulkSyncEnabled, false);
  assert.equal(result.writesEnabled, false);
  assert.equal(result.futureBulk.enabled, false);
  assert.equal(result.futureBulk.wouldSend, 0);
  assert.equal(result.pilots.length, 6);
  assert.equal(result.pilots.every((pilot) => pilot.createAllowed === false), true);
  assert.equal(result.overview.simple.workflow, "existing_simple_sync");
  assert.equal(result.overview.simple.readyCreate, 3);
  assert.equal(result.overview.bulkVariantWritesEnabled, false);
  assert.equal(result.colorAttribute.expectedPresent, true);
  const source = fs.readFileSync(new URL("./services/giniVariantChangedSync.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
  assert.equal(source.includes("updateOne"), false);
  assert.equal(source.includes("performGiniJsonRequest"), false);
  assert.equal(source.includes("miswag"), false);
  assert.equal(source.includes("elryan"), false);
  assert.equal(routes.includes("variant-sync/changed-preview"), true);
  assert.equal(routes.includes("variant-sync/bulk"), false);
  assert.equal(routes.includes("variant-sync/changed-preview/send"), false);
  assert.equal(result.generic.sending, "off");
  assert.equal(result.generic.journalsWritten, false);
  assert.equal(result.generic.liveSend, false);
  assert.equal(result.generic.nextTest.ready, false);
  assert.equal(result.blockerAudit.primaryTotal, result.summary.blocked);
  assert.equal(source.includes("PATCH"), false);
  assert.equal(source.includes("Commission"), true);
});

test("blocked products get one primary reason and the counts add up", () => {
  const plans = [
    { disposition: "BLOCKED", parentSku: "DUP-1", blockers: ["duplicate_parent_sku", "missing_variant_sku_approval", "missing_color_mapping"] },
    { disposition: "BLOCKED", parentSku: "OWN-1", blockers: ["other_vendor_owns_parent", "missing_variant_sku_approval"] },
    { disposition: "BLOCKED", parentSku: "SIZE-1", blockers: ["size_attribute_unverified", "missing_color_mapping", "missing_variant_sku_approval"] },
    { disposition: "BLOCKED", parentSku: "COLOR-1", blockers: ["missing_color_mapping", "missing_variant_sku_approval", "ownership_unverified"] },
    { disposition: "BLOCKED", parentSku: "SKU-1", blockers: ["missing_variant_sku_approval", "ownership_unverified", "remote_absence_unconfirmed"] },
    { disposition: "BLOCKED", parentSku: "OWNER-1", blockers: ["ownership_unverified"] },
    { disposition: "BLOCKED", parentSku: "OTHER-1", blockers: ["remote_absence_unconfirmed", "missing_mapping"] },
    { disposition: "UNCHANGED", parentSku: "KE20", blockers: [] },
  ];
  const audit = auditBlockedProducts(plans);
  assert.equal(audit.blocked, 7);
  assert.equal(audit.primaryTotal, 7);
  assert.equal(audit.primary.duplicate_parent_sku, 1);
  assert.equal(audit.primary.missing_vendor_ownership, 2);
  assert.equal(audit.primary.missing_size_attribute, 1);
  assert.equal(audit.primary.unmapped_colors, 1);
  assert.equal(audit.primary.missing_approved_variant_skus, 1);
  assert.equal(audit.primary.other, 1);
  assert.equal(audit.overlapping.missing_approved_variant_skus, 5);
  assert.equal(audit.overlapping.unmapped_colors, 3);
  assert.equal(audit.otherCodes.remote_absence_unconfirmed, 2);
  assert.equal(audit.otherCodes.missing_mapping, 1);
});

test("a generic verified parent prepares one price PATCH and skips the unchanged color", () => {
  const plan = planVariantChange(base({
    parentSku: "FRESH-9",
    productId: "fresh-9",
    ownership: "required",
    owner: { productId: "fresh-9", parentSku: "FRESH-9", status: "verified_remote", giniProductId: "700" },
    identities: [
      approved("FRESH-9-BLUE", "a", "b", "501"),
      approved("FRESH-9-BLACK", "c", "d", "502"),
    ],
    combinations: [
      { ...combo("FRESH-9-BLUE", "Blue", 4, 28000, "a", "b"), pricing: { giniPrice: 28000, basePrice: 26500, commission: { percentage: 5.5, scope: "filter" } } },
      { ...combo("FRESH-9-BLACK", "Black", 4, 26500, "c", "d"), pricing: { giniPrice: 26500, basePrice: 26500, commission: { percentage: 5.5, scope: "filter" } } },
    ],
    remote: {
      ...matchedRemote([
        remoteRow("FRESH-9-BLUE", "Blue", 4, 26500, "501"),
        remoteRow("FRESH-9-BLACK", "Black", 4, 26500, "502"),
      ], 8),
      sku: "FRESH-9",
      id: "700",
    },
  }));
  assert.equal(plan.disposition, "CHANGED");
  const preview = buildGenericChangedPreview([plan], [
    { parentSku: "KE20", variantId: "164306", status: "verified" },
    { parentSku: "KE20", variantId: "164307", status: "verified" },
    { parentSku: "EI-8888", variantId: "164312", status: "verified" },
    { parentSku: "EI-8888", variantId: "164313", status: "verified" },
  ]);
  assert.equal(preview.sending, "off");
  assert.equal(preview.journalsWritten, false);
  assert.equal(preview.preparedRequestCount, 1);
  assert.equal(preview.preparedRequests[0].rawBody, "{\"variant_id\":501,\"price\":28000}");
  assert.equal(preview.preparedRequests[0].rawBody.includes("502"), false);
  assert.equal(preview.preparedRequests[0].liveSend, false);
  assert.equal(preview.preparedRequests[0].journalAction, "not_written");
  assert.equal(preview.skippedUnchangedVariants, 1);
  assert.equal(preview.nextTest.ready, true);
  assert.equal(preview.nextTest.kind, "price");
  assert.equal(preview.nextTest.request.variantSku, "FRESH-9-BLUE");
  assert.equal(preview.nextTest.liveSend, false);
  assert.equal(preview.preservedPilotJournals.every((row) => row.preserved === true && row.rewritten === false), true);
  assert.equal(preview.deletionAllowed, false);
  const unpriced = planVariantChange(base({
    parentSku: "FRESH-9",
    combinations: [
      combo("FRESH-9-BLUE", "Blue", 4, 28000, "a", "b"),
      combo("FRESH-9-BLACK", "Black", 4, 26500, "c", "d"),
    ],
    identities: [
      approved("FRESH-9-BLUE", "a", "b", "501"),
      approved("FRESH-9-BLACK", "c", "d", "502"),
    ],
    remote: {
      ...matchedRemote([
        remoteRow("FRESH-9-BLUE", "Blue", 4, 26500, "501"),
        remoteRow("FRESH-9-BLACK", "Black", 4, 26500, "502"),
      ], 8),
      sku: "FRESH-9",
      id: "700",
    },
  }));
  assert.equal(buildGenericChangedPreview([unpriced]).preparedRequestCount, 0);
  assert.equal(selectPricePilot([{
    parentSku: "FRESH-9",
    productId: "fresh-9",
    disposition: "CHANGED",
    blockers: [],
    changes: [{ kind: "price", action: "documented_not_sent" }],
    priceRows: unpriced.priceRows,
  }]).ready, false);
});

test("stock zero, new colors, removed colors, and duplicate parents stay out of the generic queue", () => {
  const zero = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 0, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  }));
  const added = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 10, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
      combo("KE20-PURPLE", "Purple", 2, 26500, "e", "f"),
    ],
    identities: [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
      approved("KE20-PURPLE", "e", "f", "", "approved"),
    ],
  }));
  const removed = planVariantChange(base({
    identities: [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
      approved("KE20-PURPLE", "e", "f", "13"),
    ],
    remote: matchedRemote([
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
      remoteRow("KE20-PURPLE", "Purple", 2, 26500, "13"),
    ], 16),
  }));
  const duplicate = planVariantChange(base({ parentSku: "SHARED-1", catalogBlockers: ["duplicate_parent_sku"] }));
  const sized = planVariantChange(base({ multipleSizes: true }));
  const preview = buildGenericChangedPreview([zero, added, removed, duplicate, sized]);
  assert.equal(preview.eligibleCount, 0);
  assert.equal(preview.preparedRequestCount, 0);
  assert.equal(preview.nextTest.ready, false);
  assert.equal(removed.changes.some((change) => change.action === "delete"), false);
  assert.equal(removed.noDeletion, true);
  assert.equal(sized.blockers.includes("size_attribute_unverified"), true);
  const shared = buildGenericChangedPreview([
    planVariantChange(base({
      parentSku: "SHARED-2",
      combinations: [
        combo("SHARED-2-BLUE", "Blue", 4, 28000, "a", "b"),
        combo("SHARED-2-BLACK", "Black", 4, 26500, "c", "d"),
      ],
      identities: [
        approved("SHARED-2-BLUE", "a", "b", "801"),
        approved("SHARED-2-BLACK", "c", "d", "802"),
      ],
      remote: {
        ...matchedRemote([
          remoteRow("SHARED-2-BLUE", "Blue", 4, 26500, "801"),
          remoteRow("SHARED-2-BLACK", "Black", 4, 26500, "802"),
        ], 8),
        sku: "SHARED-2",
      },
    })),
  ], [], { sharedParentKeys: new Set(["shared-2"]) });
  assert.equal(shared.eligibleCount, 0);
  assert.equal(shared.preparedRequestCount, 0);
});

test("only a verified single-owner parent is added to the fresh read list", async () => {
  const { variantReadCandidates } = await import("./utils/giniVariantChangedPlan.js");
  const ready = {
    productId: "fresh-9",
    parentSku: "FRESH-9",
    multipleSizes: false,
    blockers: [],
    combinations: [
      combo("FRESH-9-BLUE", "Blue", 4, 26500, "a", "b"),
      combo("FRESH-9-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  };
  const duplicate = { ...ready, productId: "copy", parentSku: "FRESH-9", blockers: ["duplicate_parent_sku"] };
  const identities = new Map([
    ["fresh-9", [
      approved("FRESH-9-BLUE", "a", "b", "501"),
      approved("FRESH-9-BLACK", "c", "d", "502"),
    ]],
  ]);
  const owners = [{ parentSku: "FRESH-9", productId: "fresh-9", status: "verified_remote", giniProductId: "700" }];
  assert.deepEqual(variantReadCandidates({
    products: [ready],
    identitiesByProduct: identities,
    owners,
    colorLabels: LABELS,
    colorAttributeId: "3696",
  }), ["FRESH-9"]);
  assert.deepEqual(variantReadCandidates({
    products: [ready, duplicate],
    identitiesByProduct: identities,
    owners,
    colorLabels: LABELS,
    colorAttributeId: "3696",
  }), []);
  assert.deepEqual(variantReadCandidates({
    products: [{ ...ready, parentSku: "KE20" }],
    identitiesByProduct: identities,
    owners,
    colorLabels: LABELS,
    colorAttributeId: "3696",
  }), []);
});
