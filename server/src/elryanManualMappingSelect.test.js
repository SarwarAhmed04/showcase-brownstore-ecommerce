import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyElryanCategoryPick,
  canReviewElryanMapping,
  isElryanCategoryPicked,
  normalizeElryanCategoryPickId,
} from "../../client/src/utils/elryanSmartMappingSelect.js";

describe("Elryan manual category selection helpers", () => {
  it("normalizes numeric and string category IDs the same way (e.g. Air Compressors 398)", () => {
    assert.equal(normalizeElryanCategoryPickId(398), "398");
    assert.equal(normalizeElryanCategoryPickId("398"), "398");
    assert.equal(normalizeElryanCategoryPickId(" 398 "), "398");
    assert.equal(normalizeElryanCategoryPickId(null), "");
    assert.equal(normalizeElryanCategoryPickId(""), "");
  });

  it("marks a manual search result as selected when IDs match across number/string", () => {
    assert.equal(isElryanCategoryPicked("", 398), false);
    assert.equal(isElryanCategoryPicked("398", 398), true);
    assert.equal(isElryanCategoryPicked(398, "398"), true);
    assert.equal(isElryanCategoryPicked("398", 399), false);
  });

  it("enables review only when both collection and category are picked", () => {
    assert.equal(canReviewElryanMapping("", "398"), false);
    assert.equal(canReviewElryanMapping("col-air", ""), false);
    assert.equal(canReviewElryanMapping("col-air", 398), true);
    assert.equal(canReviewElryanMapping("col-air", "398"), true);
  });

  it("applies a pick without implying a save; clears review on change", () => {
    const first = applyElryanCategoryPick("", 398);
    assert.equal(first.pickedCategoryId, "398");
    assert.equal(first.changed, true);
    assert.equal(first.reviewCleared, true);

    const same = applyElryanCategoryPick("398", "398");
    assert.equal(same.pickedCategoryId, "398");
    assert.equal(same.changed, false);
    assert.equal(same.reviewCleared, true);

    const empty = applyElryanCategoryPick("398", null);
    assert.equal(empty.pickedCategoryId, "398");
    assert.equal(empty.changed, false);
    assert.equal(empty.reviewCleared, false);
  });

  it("does not auto-save: pick helpers never return persistence flags", () => {
    const pick = applyElryanCategoryPick("", 398);
    assert.equal(Object.prototype.hasOwnProperty.call(pick, "autoSave"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pick, "confirm"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pick, "save"), false);
  });
});
