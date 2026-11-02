import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyElryanCategoryPick,
  applyElryanMappingSaveResult,
  buildElryanMappingSaveBody,
  elryanCollectionPreviewQuery,
  elryanManualPageKeepsSelection,
  nextManualSearchOffset,
  nextUnmappedCollectionId,
  pickElryanCategoryState,
  pickNextUnmapped,
  planCollectionPageChange,
  resolveDisplayedElryanCategory,
  selectElryanCollection,
} from "../../client/src/utils/elryanSmartMappingSelect.js";

describe("Elryan quick mapping selection", () => {
  const suggestion = {
    categoryId: 398,
    categoryName: "Air Compressors",
    hierarchy: "Tools : Air Compressors",
    attributeSetId: 7,
    isParent: false,
    kind: "leaf",
    confidence: "HIGH",
    score: 84,
    reasons: ["Exact normalized collection name match"],
  };
  const manual = {
    categoryId: "401",
    categoryName: "Pumps",
    hierarchy: "Tools : Pumps",
    attributeSetId: 8,
    isParent: false,
    kind: "leaf",
  };

  it("selects a smart suggestion without saving or keeping a stale review", () => {
    const picked = pickElryanCategoryState(
      { pickedCategoryId: "", review: { canSave: true }, overwriteAck: true },
      { categoryId: suggestion.categoryId, source: "smart", snapshot: suggestion }
    );
    assert.equal(picked.pickedCategoryId, "398");
    assert.equal(picked.pickSource, "smart");
    assert.equal(picked.review, null);
    assert.equal(picked.overwriteAck, false);
    assert.equal(picked.autoSave, false);
    assert.equal(Object.prototype.hasOwnProperty.call(picked, "confirm"), false);
    assert.equal(picked.pickedSnapshot.categoryName, "Air Compressors");
    assert.equal(picked.pickedSnapshot.confidence, "HIGH");
    assert.equal(applyElryanCategoryPick("", 398).reviewCleared, true);
  });

  it("selects an inline manual category in the same panel flow", () => {
    const picked = pickElryanCategoryState(
      { pickedCategoryId: "398", review: { canSave: true }, pickSource: "smart" },
      { categoryId: manual.categoryId, source: "manual", snapshot: manual }
    );
    assert.equal(picked.pickedCategoryId, "401");
    assert.equal(picked.pickSource, "manual");
    assert.equal(picked.review, null);
    assert.equal(picked.autoSave, false);
  });

  it("keeps the picked category when manual search moves to another page", () => {
    const kept = elryanManualPageKeepsSelection("398");
    assert.equal(kept.retained, true);
    assert.equal(kept.pickedCategoryId, "398");
    const shown = resolveDisplayedElryanCategory({
      pickedCategoryId: kept.pickedCategoryId,
      snapshot: suggestion,
      candidates: [],
      manualCategories: [{ categoryId: 900, categoryName: "Other page" }],
    });
    assert.equal(shown.categoryId, "398");
    assert.equal(shown.categoryName, "Air Compressors");
    assert.equal(shown.hierarchy, "Tools : Air Compressors");
    assert.equal(shown.onManualPage, false);
    assert.equal(shown.attributeSetId, 7);
  });

  it("pages manual search by the snapshot total without dropping the selection id", () => {
    const first = nextManualSearchOffset({ offset: 0, limit: 25, totalMatching: 60, direction: "next" });
    assert.equal(first.moved, true);
    assert.equal(first.offset, 25);
    const last = nextManualSearchOffset({ offset: 50, limit: 25, totalMatching: 60, direction: "next" });
    assert.equal(last.moved, false);
    const back = nextManualSearchOffset({ offset: 25, limit: 25, totalMatching: 60, direction: "prev" });
    assert.equal(back.offset, 0);
    assert.equal(elryanManualPageKeepsSelection(401).pickedCategoryId, "401");
  });

  it("clears a stale review when the collection or category changes", () => {
    const nextCollection = selectElryanCollection({
      brownCollectionId: "col-next",
      keepMessage: true,
      message: "Mapping saved locally.",
    });
    assert.equal(nextCollection.selectedId, "col-next");
    assert.equal(nextCollection.pickedCategoryId, "");
    assert.equal(nextCollection.review, null);
    assert.equal(nextCollection.message, "Mapping saved locally.");

    const changedCategory = pickElryanCategoryState(
      { pickedCategoryId: "398", review: { canSave: true, elryan: { categoryId: "398" } } },
      { categoryId: 399, source: "smart", snapshot: { ...suggestion, categoryId: 399, categoryName: "Other" } }
    );
    assert.equal(changedCategory.review, null);
    assert.equal(changedCategory.pickedCategoryId, "399");
  });

  it("passes collection search past the first page and keeps filters", () => {
    const params = elryanCollectionPreviewQuery({
      q: "Zinc Path",
      status: "unmapped",
      confidence: "HIGH",
      offset: 40,
      limit: 40,
    });
    assert.equal(params.offset, 40);
    assert.equal(params.q, "Zinc Path");
    assert.equal(params.status, "unmapped");
    assert.equal(params.confidence, "HIGH");
    assert.equal(params.limit, 40);
  });

  it("turns the server nextOffset into the next page and can return to the previous cursor", () => {
    const next = planCollectionPageChange({
      history: [0],
      offset: 0,
      direction: "next",
      nextOffset: 15,
      hasMore: true,
    });
    assert.equal(next.moved, true);
    assert.equal(next.offset, 15);
    assert.deepEqual(next.history, [0, 15]);
    const prev = planCollectionPageChange({
      history: next.history,
      offset: 15,
      direction: "prev",
    });
    assert.equal(prev.offset, 0);
    const blocked = planCollectionPageChange({
      history: next.history,
      offset: 15,
      direction: "next",
      nextOffset: 120,
      hasMore: false,
    });
    assert.equal(blocked.moved, false);
    assert.equal(blocked.offset, 15);
  });

  it("refuses to build a save until review exists, and sends overwrite only after confirmation", () => {
    const missing = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: 398,
      review: null,
      overwriteAck: true,
    });
    assert.equal(missing.allowed, false);

    const needsOverwrite = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: "401",
      review: { canSave: true, requiresOverwriteConfirmation: true },
      overwriteAck: false,
      source: "manual",
    });
    assert.equal(needsOverwrite.allowed, false);
    assert.equal(needsOverwrite.reason, "overwrite_required");

    const confirmed = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: 401,
      review: { canSave: true, requiresOverwriteConfirmation: true },
      overwriteAck: true,
      source: "manual",
    });
    assert.equal(confirmed.allowed, true);
    assert.equal(confirmed.body.confirm, true);
    assert.equal(confirmed.body.overwrite, true);
    assert.equal(confirmed.body.source, "manual");
    assert.equal(confirmed.body.categoryId, "401");
    assert.equal(Array.isArray(confirmed.body.brownCollectionId), false);

    const fresh = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: "398",
      review: { canSave: true, requiresOverwriteConfirmation: false },
      overwriteAck: false,
      source: "smart",
    });
    assert.equal(fresh.allowed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(fresh.body, "overwrite"), false);
    assert.equal(fresh.body.confirm, true);
  });

  it("keeps the success message and the saved collection instead of jumping to the first row", () => {
    const rows = [
      { brownCollectionId: "first", existingMapping: { configured: false, values: {} } },
      {
        brownCollectionId: "saved",
        existingMapping: { configured: false, values: {} },
      },
    ];
    const applied = applyElryanMappingSaveResult({
      rows,
      selectedId: "saved",
      saveResult: {
        readBackConfirmed: true,
        configured: true,
        brownCollectionId: "saved",
        environment: "staging",
        values: {
          categoryId: "398",
          categoryName: "Air Compressors",
          categoryHierarchy: "Tools : Air Compressors",
        },
      },
      successMessage: "Mapping saved locally. Nothing was sent to Elryan.",
    });
    assert.equal(applied.claimedSuccess, true);
    assert.equal(applied.fullRefresh, false);
    assert.equal(applied.preserveFilters, true);
    assert.equal(applied.jumpedToFirst, false);
    assert.equal(applied.selectedId, "saved");
    assert.notEqual(applied.selectedId, "first");
    assert.equal(applied.message, "Mapping saved locally. Nothing was sent to Elryan.");
    assert.equal(applied.review, null);
    assert.equal(applied.rows[0].existingMapping.configured, false);
    assert.equal(applied.rows[1].existingMapping.configured, true);
    assert.equal(applied.rows[1].existingMapping.values.categoryId, "398");
    assert.equal(applied.mappedDelta, 1);
  });

  it("does not claim success or rewrite the saved mapping when read-back fails", () => {
    const rows = [
      {
        brownCollectionId: "saved",
        existingMapping: {
          configured: true,
          values: { categoryId: "100", categoryName: "Old" },
        },
      },
    ];
    const applied = applyElryanMappingSaveResult({
      rows,
      selectedId: "saved",
      saveResult: {
        readBackConfirmed: false,
        configured: true,
        brownCollectionId: "saved",
        values: { categoryId: "200", categoryName: "New" },
      },
      successMessage: "Mapping saved locally. Nothing was sent to Elryan.",
    });
    assert.equal(applied.claimedSuccess, false);
    assert.equal(applied.readBackConfirmed, false);
    assert.equal(applied.message, "");
    assert.equal(applied.selectedId, "saved");
    assert.equal(applied.rows[0].existingMapping.values.categoryId, "100");
    assert.equal(applied.rows[0].saveReadBackFailed, true);
  });

  it("moves to the next unmapped collection and skips one that was just saved", () => {
    const rows = [
      { brownCollectionId: "a", existingMapping: { configured: true } },
      { brownCollectionId: "b", existingMapping: { configured: false } },
      { brownCollectionId: "c", existingMapping: { configured: false } },
    ];
    assert.equal(nextUnmappedCollectionId(rows, "a"), "b");
    assert.equal(pickNextUnmapped({ rows, selectedId: "b", hasMore: false }).brownCollectionId, "c");
    assert.equal(pickNextUnmapped({ rows, selectedId: "c", hasMore: true }).action, "load-next");
    assert.equal(pickNextUnmapped({ rows, selectedId: "c", hasMore: false }).action, "none");

    const saved = applyElryanMappingSaveResult({
      rows: [
        { brownCollectionId: "b", existingMapping: { configured: false, values: {} } },
        { brownCollectionId: "c", existingMapping: { configured: false, values: {} } },
      ],
      selectedId: "b",
      saveResult: {
        readBackConfirmed: true,
        configured: true,
        brownCollectionId: "b",
        environment: "staging",
        values: { categoryId: "398" },
      },
      successMessage: "saved",
    });
    assert.equal(saved.message, "saved");
    assert.equal(nextUnmappedCollectionId(saved.rows, "b"), "c");
  });
});
