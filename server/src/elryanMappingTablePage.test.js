import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeElryanValueDrafts } from "../../client/src/utils/elryanValueMappingPage.js";
import { elryanMappingPageItems } from "../../client/src/utils/elryanMappingTablePage.js";
import {
  compareMappingLabel,
  normalizeElryanMappingLimit,
  paginateElryanMappingRows,
} from "./utils/elryanMappingTablePage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1).padStart(3, "0"),
  }));
}

describe("Elryan mapping table pagination", () => {
  it("returns one page after the full match set is known", () => {
    const all = rows(60);
    const first = paginateElryanMappingRows(all, { page: 1, limit: 25 });
    const second = paginateElryanMappingRows(all, { page: 2, limit: 25 });
    const third = paginateElryanMappingRows(all, { page: 3, limit: 25 });
    const wide = paginateElryanMappingRows(all, { page: 2, limit: 50 });
    assert.equal(normalizeElryanMappingLimit(25), 25);
    assert.equal(normalizeElryanMappingLimit(40), 25);
    assert.equal(normalizeElryanMappingLimit(50), 50);
    assert.equal(first.total, 60);
    assert.equal(first.pages, 3);
    assert.equal(first.rows.length, 25);
    assert.equal(first.rows[0].id, "001");
    assert.equal(first.rows.at(-1).id, "025");
    assert.equal(second.rows[0].id, "026");
    assert.equal(third.rows.length, 10);
    assert.equal(third.rows[0].id, "051");
    assert.equal(wide.rows.length, 10);
    assert.equal(wide.rows[0].id, "051");

    const seen = new Set();
    for (let page = 1; page <= first.pages; page += 1) {
      for (const row of paginateElryanMappingRows(all, { page, limit: 25 }).rows) {
        assert.equal(seen.has(row.id), false);
        seen.add(row.id);
      }
    }
    assert.equal(seen.size, 60);

    const needle = "04";
    const matched = all.filter((row) => row.id.includes(needle));
    const filtered = paginateElryanMappingRows(matched, { page: 1, limit: 25 });
    assert.equal(filtered.total, matched.length);
    assert.equal(filtered.rows.length, matched.length);
    assert.equal(filtered.rows.some((row) => row.id === "040"), true);

    const everything = paginateElryanMappingRows(all, {});
    assert.equal(everything.rows.length, 60);
    assert.equal(compareMappingLabel("Alpha", "b", "alpha", "a") > 0, true);
    assert.equal(compareMappingLabel("Same", "a", "Same", "b") < 0, true);
  });

  it("keeps saved row state off the current page and pages the mapping screens", () => {
    const merged = mergeElryanValueDrafts(
      {
        later: { elryanId: "9", elryanLabel: "Later", baseId: "1", baseLabel: "Saved", saveError: "" },
      },
      [{ brownKey: "first", mapping: { elryanId: "1", elryanLabel: "First" } }]
    );
    assert.equal(merged.later.elryanId, "9");
    assert.equal(merged.first.elryanId, "1");
    assert.deepEqual(
      elryanMappingPageItems(3, 8).filter((item) => item.type === "page").map((item) => item.page),
      [1, 2, 3, 4, 5, 8]
    );

    const pair = read("server/src/services/elryanPairMapping.js");
    const warranty = read("server/src/services/elryanWarrantyMapping.js");
    const dimensions = read("server/src/services/elryanCollectionDimensions.js");
    const preview = read("server/src/services/elryanMappingPreview.js");
    assert.match(pair, /paginateElryanMappingRows\(matched, query\)/);
    assert.match(warranty, /filterWarrantyBrands\(rows/);
    assert.match(warranty, /paginateElryanMappingRows\(matched, query\)/);
    assert.match(dimensions, /paginateElryanMappingRows\(matched, query\)/);
    assert.match(preview, /filtered = \[\.\.\.filtered\]\.sort\(compareBrownCollection\)/);

    const routes = read("server/src/routes/elryanConnection.js");
    assert.match(routes, /listElryanPairMapping\(req\.query\.kind, req\.query\)/);
    assert.match(routes, /listElryanWarrantyMappingPage\(req\.query\)/);
    assert.match(routes, /listElryanCollectionDimensionCatalog\(req\.query\)/);

    for (const file of [
      "client/src/components/admin/platform/ElryanValueMapping.jsx",
      "client/src/components/admin/platform/ElryanWarrantyMapping.jsx",
      "client/src/components/admin/platform/ElryanDimensionsMapping.jsx",
      "client/src/components/admin/platform/ElryanSmartMapping.jsx",
    ]) {
      assert.match(read(file), /ElryanMappingPager/);
    }
    const dimensionUi = read("client/src/components/admin/platform/ElryanDimensionsMapping.jsx");
    assert.match(dimensionUi, /t\.elryanDimSaving/);
    assert.match(dimensionUi, /t\.elryanValueConfirmed/);
    assert.match(dimensionUi, /data-dimension-status=\{feedback\.status \|\| "idle"\}/);
    const dimensionSaves = [...dimensionUi.matchAll(/api\.saveElryanCollectionDimension\(\{[\s\S]*?\}\)/g)];
    assert.equal(dimensionSaves.length, 2);
    for (const save of dimensionSaves) {
      assert.match(save[0], /environment: activeEnvironment/);
      assert.equal(save[0].includes('environment: "staging"'), false);
    }
    const i18n = read("client/src/i18n.js");
    assert.equal(i18n.includes("Rules saved here stay Staging-only"), false);
    assert.match(i18n, /Rules saved here are stored for Production and are inherited by eligible products in Production previews/);
  });
});
