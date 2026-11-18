import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ELRYAN_BRAND_MAPPING_TAB,
  ELRYAN_COLOUR_MAPPING_TAB,
  elryanCatalogPageWindow,
  elryanValueAttribute,
  elryanValueRowStatus,
  filterElryanValueRows,
  mergeElryanValueDrafts,
} from "../../client/src/utils/elryanValueMappingPage.js";
import {
  elryanPlatformSectionEntries,
  resolveElryanPlatformTab,
} from "../../client/src/utils/elryanCategoryMappingPage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Elryan brand and colour mapping pages", () => {
  it("replaces the combined sidebar entry and keeps warranty mapping", () => {
    const ids = elryanPlatformSectionEntries().map(([id]) => id);
    assert.equal(ids.includes(ELRYAN_BRAND_MAPPING_TAB), true);
    assert.equal(ids.includes(ELRYAN_COLOUR_MAPPING_TAB), true);
    assert.equal(ids.includes("elryanWarrantyMapping"), true);
    assert.equal(ids.includes("elryanAttributes"), false);
    assert.ok(ids.indexOf(ELRYAN_BRAND_MAPPING_TAB) < ids.indexOf(ELRYAN_COLOUR_MAPPING_TAB));
    assert.ok(ids.indexOf(ELRYAN_COLOUR_MAPPING_TAB) < ids.indexOf("elryanWarrantyMapping"));
    assert.equal(resolveElryanPlatformTab("elryanAttributes"), ELRYAN_BRAND_MAPPING_TAB);
    assert.equal(resolveElryanPlatformTab("syncOne"), "syncOne");

    const host = read("client/src/components/admin/platform/elryanPlatformHost.jsx");
    assert.match(host, /<ElryanValueMapping t=\{t\} kind="brand" \/>/);
    assert.match(host, /<ElryanValueMapping t=\{t\} kind="color" \/>/);
    assert.match(host, /<ElryanWarrantyMapping t=\{t\} lang=\{lang\} \/>/);
    assert.equal(host.includes("ElryanAttributeMappings"), false);
    assert.equal(host.includes("ElryanSyncAll"), true);
  });

  it("keeps confirmed, unsaved, and row errors distinct", () => {
    assert.equal(elryanValueRowStatus({ savedId: "10104", draftId: "10104" }).kind, "confirmed");
    assert.equal(elryanValueRowStatus({ savedId: "", draftId: "" }).kind, "empty");
    assert.equal(elryanValueRowStatus({ savedId: "10104", draftId: "88" }).kind, "unsaved");
    assert.equal(elryanValueRowStatus({ savedId: "", draftId: "88" }).kind, "unsaved");
    const failed = elryanValueRowStatus({ savedId: "10104", draftId: "88", saveError: "Catalog unavailable" });
    assert.equal(failed.kind, "error");
    assert.equal(failed.message, "Catalog unavailable");
  });

  it("searches the verified catalog past the first page and preserves an unsaved row", () => {
    assert.equal(elryanValueAttribute("brand"), "Brand");
    assert.equal(elryanValueAttribute("color"), "Color");
    const first = elryanCatalogPageWindow({ page: 1, limit: 30, total: 80 });
    assert.equal(first.hasNext, true);
    assert.equal(first.hasPrevious, false);
    const last = elryanCatalogPageWindow({ page: 3, limit: 30, total: 80 });
    assert.equal(last.hasNext, false);
    assert.equal(last.hasPrevious, true);

    const rows = [
      { brownKey: "ingco", brownLabel: "INGCO", mapping: { elryanId: "10104", elryanLabel: "ingco" } },
      { brownKey: "black", brownLabel: "Black", mapping: null },
    ];
    assert.equal(filterElryanValueRows(rows, "10104")[0].brownKey, "ingco");
    const merged = mergeElryanValueDrafts(
      {
        ingco: { elryanId: "50", elryanLabel: "other", baseId: "10104", baseLabel: "ingco", saveError: "" },
        black: { elryanId: "", elryanLabel: "", baseId: "", baseLabel: "", saveError: "" },
      },
      rows
    );
    assert.equal(merged.ingco.elryanId, "50");
    assert.equal(merged.black.elryanId, "");

    const ui = read("client/src/components/admin/platform/ElryanValueMapping.jsx");
    assert.match(ui, /api\.elryanPairMapping\(kind\)/);
    assert.match(ui, /api\.elryanAttributeValues\(attribute/);
    assert.match(ui, /search: String\(nextQuery \|\| ""\)\.trim\(\) \|\| undefined/);
    assert.match(ui, /api\.saveElryanValueMapping/);
    assert.match(ui, /environment,/);
    assert.match(ui, /elryanId,/);
    assert.match(ui, /data-mapping-status=\{status\.kind\}/);
    assert.match(ui, /t\.elryanValueConfirmed/);
    assert.match(ui, /t\.elryanValueUnsaved/);
    assert.equal(ui.includes("elryanSyncOneSend"), false);
    assert.equal(ui.includes("elryanSyncAll"), false);

    const i18n = read("client/src/i18n.js");
    for (const title of [
      'elryanBrandMappingTitle: "Brand Mapping"',
      'elryanColourMappingTitle: "Colour Mapping"',
      'elryanValueConfirmed: "Confirmed"',
      'elryanValueUnsaved: "Unsaved changes"',
      'elryanBrandMappingTitle: "نەخشەی براند"',
      'elryanColourMappingTitle: "نەخشەی ڕەنگ"',
      'elryanBrandMappingTitle: "تعيين العلامات"',
      'elryanColourMappingTitle: "تعيين الألوان"',
    ]) {
      assert.equal(i18n.includes(title), true, title);
    }
  });
});
