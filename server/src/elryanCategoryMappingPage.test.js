import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ELRYAN_CATEGORY_MAPPING_TAB,
  applySaveToCardDraft,
  brownStoreTaxonomyPath,
  elryanLoadError,
  elryanPlatformSectionEntries,
  isElryanCategoryMappingTab,
  isElryanHostTab,
  pickCategoryOnCard,
  resolveElryanPlatformTab,
  reviewBrownStorePath,
  searchHitsForCollection,
  selectElryanSidebarSections,
  toggleElryanPicker,
  unmappedCollectionCount,
  withElryanSharedSections,
} from "../../client/src/utils/elryanCategoryMappingPage.js";
import {
  ELRYAN_COLLECTION_PAGE_SIZE,
  applyElryanMappingSaveResult,
  buildElryanMappingSaveBody,
  elryanCollectionPreviewQuery,
} from "../../client/src/utils/elryanSmartMappingSelect.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const SHARED = [
  ["overview", "overviewTab"],
  ["mapping", "categoryMapping"],
  ["availability", "availabilityTab"],
  ["commissions", "existingCommissions"],
  ["products", "products"],
  ["excel", "excelTab"],
  ["api", "partnerApi"],
];

function sliceFn(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

describe("Elryan unified category mapping page", () => {
  it("shows one Category Mapping sidebar entry and keeps the other Elryan sections", () => {
    const entries = elryanPlatformSectionEntries();
    const ids = entries.map(([id]) => id);
    assert.deepEqual(
      ids.filter((id) =>
        ["elryanCategoryMapping", "elryanCategories", "elryanSmartMapping", "mapping"].includes(id)
      ),
      [ELRYAN_CATEGORY_MAPPING_TAB]
    );
    assert.equal(entries.find(([, key]) => key === "elryanCategoryMappingTitle")?.[0], ELRYAN_CATEGORY_MAPPING_TAB);
    assert.equal(ids.includes("elryanDimensionsMapping"), true);
    assert.equal(ids.includes("connection"), true);
    assert.equal(ids.includes("elryanAttributes"), true);
    assert.equal(ids.includes("syncOne"), true);
    assert.equal(ids.includes("syncAll"), true);

    const sidebar = withElryanSharedSections(entries, SHARED).map(([id]) => id);
    assert.equal(sidebar.filter((id) => id === "mapping").length, 0);
    assert.equal(sidebar.filter((id) => id === ELRYAN_CATEGORY_MAPPING_TAB).length, 1);
    for (const id of ["overview", "availability", "commissions", "products", "excel", "api"]) {
      assert.equal(sidebar.includes(id), true, id);
    }
  });

  it("sends the old Elryan category tabs to the unified page", () => {
    for (const tab of ["elryanCategories", "elryanSmartMapping", "mapping"]) {
      assert.equal(resolveElryanPlatformTab(tab), ELRYAN_CATEGORY_MAPPING_TAB);
      assert.equal(isElryanCategoryMappingTab(tab), true);
    }
    assert.equal(resolveElryanPlatformTab("syncOne"), "syncOne");
    assert.equal(resolveElryanPlatformTab("elryanDimensionsMapping"), "elryanDimensionsMapping");
    assert.equal(isElryanCategoryMappingTab("elryanAttributes"), false);

    const commissions = read("client/src/pages/admin/Commissions.jsx");
    assert.match(commissions, /if \(partnerSlug !== "elryan"\) return;/);
    assert.match(commissions, /resolveElryanPlatformTab\(tab\)/);
    assert.match(
      commissions,
      /tab === "mapping" && partnerSlug !== "miswag" && partnerSlug !== "elryan"/
    );
    const host = read("client/src/components/admin/platform/elryanPlatformHost.jsx");
    assert.match(host, /isElryanCategoryMappingTab\(tab\)/);
    assert.match(host, /<ElryanSmartMapping t=\{t\} lang=\{lang\} \/>/);
    assert.equal(host.includes('tab === "elryanCategories"'), false);
    assert.equal(host.includes('tab === "elryanSmartMapping"'), false);
  });

  it("renders Miswag-style vertical cards with the BrownStore taxonomy, id, and product count", () => {
    const ui = read("client/src/components/admin/platform/ElryanSmartMapping.jsx");
    assert.match(ui, /className="elryan-category-mapping space-y-5"/);
    assert.match(ui, /className="mt-5 space-y-3"/);
    assert.match(ui, /data-elryan-collection-card=\{id\}/);
    assert.match(ui, /data-product-count=\{row\.productCount\}/);
    assert.match(ui, /data-mapping-status=\{mapped \? "mapped" : "unmapped"\}/);
    assert.match(ui, /brownStoreTaxonomyPath\(row, lang\)/);
    assert.match(ui, /formatCount\(row\.productCount\)/);
    assert.equal(ui.includes("lg:grid-cols-2"), false);
    assert.equal(ui.includes("saveCategorySetup"), false);
    assert.match(ui, /elryanStatMapped/);
    assert.match(ui, /elryanStatUnmapped/);
    assert.match(ui, /statTotalCollections/);
    assert.match(ui, /\["", t\.filterAll\]/);
    assert.match(ui, /\["mapped", t\.elryanFilterMapped\]/);
    assert.match(ui, /\["unmapped", t\.elryanFilterUnmapped\]/);

    const path = brownStoreTaxonomyPath(
      {
        brownCategoryName: { en: "Automotive", ar: "سيارات", ku: "ئۆتۆمبێل" },
        brownSubCategoryName: { en: "Car Accessories", ar: "إكسسوارات السيارة" },
        brownCollectionName: { en: "Air Compressors", ar: "ضواغط هواء" },
        productCount: 25,
        brownCollectionId: "col-air",
      },
      "en"
    );
    assert.equal(path, "Automotive → Car Accessories → Air Compressors");
    assert.equal(
      brownStoreTaxonomyPath(
        {
          brownCategoryName: { en: "Automotive", ar: "سيارات" },
          brownSubCategoryName: { ar: "إكسسوارات السيارة" },
          brownCollectionName: { ar: "ضواغط هواء" },
        },
        "ar"
      ),
      "سيارات → إكسسوارات السيارة → ضواغط هواء"
    );
    assert.equal(
      brownStoreTaxonomyPath({
        brownCategoryName: { en: "Automotive" },
        brownCollectionName: { en: "Air Compressors" },
      }),
      "Automotive → Air Compressors"
    );
    assert.equal(path.includes("Subcategory"), false);
    assert.equal(
      reviewBrownStorePath({
        categoryName: { en: "Automotive" },
        subCategoryName: { en: "Car Accessories" },
        collectionName: { en: "Air Compressors" },
      }),
      "Automotive → Car Accessories → Air Compressors"
    );
  });

  it("opens one collection picker, selects suggestions and search hits, and does not save", () => {
    const ui = read("client/src/components/admin/platform/ElryanSmartMapping.jsx");
    const pick = sliceFn(ui, "function pickCategory", "async function runManualSearch");
    const search = sliceFn(ui, "async function runManualSearch", "function openPicker");
    assert.match(ui, /data-elryan-picker=\{id\}/);
    assert.match(ui, /pickerFor === id/);
    assert.match(ui, /data-elryan-suggestion=/);
    assert.match(ui, /data-elryan-search-hit/);
    assert.match(ui, /elryanMappingSnapshotSearch/);
    assert.match(pick, /pickCategoryOnCard/);
    assert.equal(pick.includes("elryanMappingSave"), false);
    assert.equal(pick.includes("elryanMappingPreviewSave"), false);
    assert.equal(search.includes("pickedCategoryId"), false);
    assert.equal(search.includes("elryanMappingSave"), false);

    const suggestion = {
      categoryId: 398,
      categoryName: "Air Compressors",
      hierarchy: "Tools : Air Compressors",
      attributeSetId: 7,
      isParent: false,
      kind: "leaf",
      confidence: "HIGH",
    };
    const first = pickCategoryOnCard({}, "col-air", suggestion, "smart");
    assert.equal(first.saved, false);
    assert.equal(first.autoSave, false);
    assert.equal(first.drafts["col-air"].pickedCategoryId, "398");
    assert.equal(first.drafts["col-air"].pickedSnapshot.hierarchy, "Tools : Air Compressors");
    assert.equal(first.drafts["col-air"].review, null);

    const opened = toggleElryanPicker("", "col-air");
    assert.equal(opened, "col-air");
    assert.equal(toggleElryanPicker(opened, "col-pumps"), "col-pumps");
    assert.equal(toggleElryanPicker("col-pumps", "col-pumps"), "");

    const manual = pickCategoryOnCard(first.drafts, "col-pumps", {
      categoryId: "401",
      categoryName: "Pumps",
      hierarchy: "Tools : Pumps",
      isParent: false,
      kind: "leaf",
    }, "manual");
    assert.equal(manual.drafts["col-air"].pickedCategoryId, "398");
    assert.equal(manual.drafts["col-pumps"].pickedCategoryId, "401");
    assert.equal(manual.saved, false);
    assert.deepEqual(
      searchHitsForCollection({
        manualFor: "col-pumps",
        collectionId: "col-air",
        categories: [{ categoryId: "900", categoryName: "Other page" }],
      }),
      []
    );
    assert.equal(
      searchHitsForCollection({
        manualFor: "col-pumps",
        collectionId: "col-pumps",
        categories: [{ categoryId: "401" }],
      }).length,
      1
    );
  });

  it("keeps explicit review, leaf blocking, overwrite protection, and the saved page", () => {
    const ui = read("client/src/components/admin/platform/ElryanSmartMapping.jsx");
    const review = sliceFn(ui, "async function buildReview", "async function saveMapping");
    const save = sliceFn(ui, "async function saveMapping", "function goPrev");
    assert.match(review, /elryanMappingPreviewSave/);
    assert.equal(review.includes("api.elryanMappingSave"), false);
    assert.match(save, /api\.elryanMappingSave\(decision\.body\)/);
    assert.match(save, /buildElryanMappingSaveBody/);
    assert.match(save, /applyElryanMappingSaveResult/);
    assert.match(save, /applySaveToCardDraft/);
    assert.equal(save.includes("loadCollections"), false);
    assert.equal(save.includes("setPageOffset"), false);
    assert.equal(save.includes("setQuery"), false);
    assert.match(ui, /data-elryan-confirm-save=\{id\}/);
    assert.match(ui, /!draft\.review\.canSave/);
    assert.match(ui, /elryanOverwriteConfirm/);
    assert.match(ui, /limit: ELRYAN_COLLECTION_PAGE_SIZE/);
    assert.equal(ELRYAN_COLLECTION_PAGE_SIZE, 40);

    const blocked = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: 12,
      review: { canSave: false, blockers: ["parent"] },
      overwriteAck: true,
    });
    assert.equal(blocked.allowed, false);

    const needsOverwrite = buildElryanMappingSaveBody({
      brownCollectionId: "col-air",
      categoryId: "401",
      review: { canSave: true, requiresOverwriteConfirmation: true },
      overwriteAck: false,
    });
    assert.equal(needsOverwrite.reason, "overwrite_required");

    const page = elryanCollectionPreviewQuery({
      q: "compressor",
      status: "unmapped",
      offset: 80,
      limit: ELRYAN_COLLECTION_PAGE_SIZE,
    });
    assert.equal(page.offset, 80);
    assert.equal(page.limit, 40);
    assert.equal(page.status, "unmapped");

    const rows = [
      { brownCollectionId: "first", existingMapping: { configured: true, values: { categoryId: "1" } } },
      { brownCollectionId: "col-air", existingMapping: { configured: false, values: {} } },
    ];
    const applied = applyElryanMappingSaveResult({
      rows,
      selectedId: "col-air",
      saveResult: {
        readBackConfirmed: true,
        configured: true,
        brownCollectionId: "col-air",
        environment: "staging",
        values: { categoryId: "398", categoryName: "Air Compressors", categoryHierarchy: "Tools : Air Compressors" },
      },
      successMessage: "Mapping saved locally. Nothing was sent to Elryan.",
    });
    assert.equal(applied.selectedId, "col-air");
    assert.equal(applied.jumpedToFirst, false);
    assert.equal(applied.rows[0].existingMapping.values.categoryId, "1");
    assert.equal(applied.rows[1].existingMapping.values.categoryId, "398");
    assert.equal(applied.preserveFilters, true);
    assert.equal(applied.fullRefresh, false);

    const drafts = applySaveToCardDraft(
      {
        "col-air": { pickedCategoryId: "398", review: { canSave: true }, message: "" },
        "col-pumps": { message: "earlier save", pickedCategoryId: "401" },
      },
      "col-air",
      { claimedSuccess: true, message: applied.message }
    );
    assert.equal(drafts["col-air"].message, "Mapping saved locally. Nothing was sent to Elryan.");
    assert.equal(drafts["col-air"].review, null);
    assert.equal(drafts["col-pumps"].message, "earlier save");
    assert.equal(drafts["col-pumps"].pickedCategoryId, "401");

    const failed = applyElryanMappingSaveResult({
      rows: [{ brownCollectionId: "col-air", existingMapping: { configured: true, values: { categoryId: "100" } } }],
      selectedId: "col-air",
      saveResult: { readBackConfirmed: false, configured: true, brownCollectionId: "col-air", values: { categoryId: "200" } },
      successMessage: "Mapping saved locally. Nothing was sent to Elryan.",
    });
    assert.equal(failed.claimedSuccess, false);
    assert.equal(failed.rows[0].existingMapping.values.categoryId, "100");
    const warned = applySaveToCardDraft({}, "col-air", {
      claimedSuccess: false,
      message: failed.message,
      warning: "Saved, but read-back did not match. Refresh and verify.",
    });
    assert.equal(warned["col-air"].message, "");
    assert.match(warned["col-air"].error, /read-back/i);

    assert.equal(unmappedCollectionCount({ collections: 120, mapped: 45 }), 75);
    assert.equal(unmappedCollectionCount({}), null);
  });

  it("uses themed surfaces and does not change GINI, Miswag, dimensions, or sync", () => {
    const ui = read("client/src/components/admin/platform/ElryanSmartMapping.jsx");
    const dark = read("client/src/admin-dark.css");
    for (const token of [".bg-white", ".bg-cream", ".text-brown", ".bg-emerald-50", ".text-emerald-800", ".bg-amber-50", ".bg-red-50"]) {
      assert.match(dark, new RegExp(token.replace(".", "\\.")));
    }
    assert.match(ui, /bg-white/);
    assert.match(ui, /bg-cream/);
    assert.match(ui, /text-brown/);
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(ui), false);
    assert.match(ui, /<ElryanCatalogBrowse t=\{t\} embedded \/>/);

    const sidebar = read("client/src/components/admin/platform/PlatformSidebar.jsx");
    assert.match(sidebar, /partnerSlug === "gini"/);
    assert.match(sidebar, /\.\.\.PLATFORM_SECTIONS,/);
    assert.match(sidebar, /\["mappingCategories", "miswagMappingCategories"\]/);
    const miswag = read("client/src/components/admin/platform/MiswagMappingCategories.jsx");
    assert.match(miswag, /miswagPickCategory/);
    assert.match(miswag, /save\(row,/);
    const panel = read("client/src/components/admin/platform/CategorySetupPanel.jsx");
    const panelExport = panel.slice(panel.indexOf("export default function CategorySetupPanel"));
    assert.match(panelExport, /partnerSlug === "gini"/);
    assert.match(panelExport, /partnerSlug === "elryan"\) return null/);
    assert.match(panel, /function GiniCategorySetup/);
    assert.equal(panelExport.includes("saveCategorySetup"), false);
    const host = read("client/src/components/admin/platform/elryanPlatformHost.jsx");
    assert.match(host, /ElryanDimensionsMapping/);
    assert.match(host, /ElryanSyncOneProduct/);
    assert.match(host, /ElryanSyncAll/);
    assert.equal(ui.includes("ElryanDimensionsMapping"), false);
    assert.equal(ui.includes("ElryanSyncAll"), false);
    assert.equal(ui.includes("ElryanSyncOneProduct"), false);

    const i18n = read("client/src/i18n.js");
    assert.match(i18n, /elryanCategoryMappingTitle: "Category Mapping"/);
    assert.match(i18n, /elryanCategoryMappingTitle: "نەخشەکردنی پۆل"/);
    assert.match(i18n, /elryanCategoryMappingTitle: "تعيين الفئات"/);
  });

  it("bundles the Elryan host with a static import and keeps advanced sections", () => {
    const commissions = read("client/src/pages/admin/Commissions.jsx");
    const sidebar = read("client/src/components/admin/platform/PlatformSidebar.jsx");
    const host = read("client/src/components/admin/platform/elryanPlatformHost.jsx");
    assert.equal(commissions.includes("@vite-ignore"), false);
    assert.equal(sidebar.includes("@vite-ignore"), false);
    assert.match(commissions, /import\("\.\.\/\.\.\/components\/admin\/platform\/elryanPlatformHost\.jsx"\)/);
    assert.match(sidebar, /import\("\.\/elryanPlatformHost\.jsx"\)/);
    assert.match(commissions, /Failed to load Elryan platform host/);
    assert.match(sidebar, /Failed to load Elryan platform sections/);
    assert.match(commissions, /console\.error\("Failed to load Elryan platform host\."/);
    assert.match(sidebar, /console\.error\("Failed to load Elryan platform sections\."/);
    assert.match(commissions, /ElryanModuleLoadNotice/);
    assert.match(sidebar, /ElryanModuleLoadNotice/);
    const i18n = read("client/src/i18n.js");
    assert.match(i18n, /elryanModuleLoadTitle: "Elryan sections failed to load\."/);
    assert.match(i18n, /elryanModuleLoadTitle: "بەشەکانی Elryan بارنەکران\."/);
    assert.match(i18n, /elryanModuleLoadTitle: "تعذّر تحميل أقسام Elryan\."/);
    assert.match(sidebar, /partnerSlug === "gini"/);
    assert.match(sidebar, /\["syncAll", "giniSyncAllTitle"\]/);
    assert.match(sidebar, /\["connection", "miswagApiConnection"\]/);
    assert.match(sidebar, /\["mappingCategories", "miswagMappingCategories"\]/);
    assert.match(commissions, /tab === "syncOne" && partnerSlug === "gini"/);
    assert.match(commissions, /tab === "syncAll" && partnerSlug === "miswag"/);
    for (const snippet of [
      'tab === "connection"',
      "isElryanCategoryMappingTab(tab)",
      'tab === "elryanAttributes"',
      'tab === "elryanWarrantyMapping"',
      'tab === "elryanDimensionsMapping"',
      'tab === "syncOne"',
      'tab === "syncAll"',
      "<ElryanSmartMapping",
      "<ElryanAttributeMappings",
      "<ElryanWarrantyMapping",
      "<ElryanDimensionsMapping",
      "<ElryanSyncOneProduct",
      "<ElryanSyncAll",
      "<ElryanApiConnection",
    ]) {
      assert.equal(host.includes(snippet), true, snippet);
    }

    const ready = selectElryanSidebarSections({
      elryanSections: elryanPlatformSectionEntries(),
      error: "",
      sharedSections: SHARED,
    });
    assert.equal(ready.status, "ready");
    const ids = ready.sections.map(([id]) => id);
    for (const id of [
      "connection",
      ELRYAN_CATEGORY_MAPPING_TAB,
      "elryanAttributes",
      "elryanWarrantyMapping",
      "elryanDimensionsMapping",
      "syncOne",
      "syncAll",
      "overview",
      "availability",
      "commissions",
      "products",
      "excel",
      "api",
    ]) {
      assert.equal(ids.includes(id), true, id);
    }
    assert.equal(ids.includes("mapping"), false);
    assert.equal(ids.filter((id) => id === ELRYAN_CATEGORY_MAPPING_TAB).length, 1);

    const loading = selectElryanSidebarSections({
      elryanSections: null,
      error: "",
      sharedSections: SHARED,
    });
    assert.equal(loading.status, "loading");
    assert.deepEqual(loading.sections, []);

    const failed = selectElryanSidebarSections({
      elryanSections: null,
      error: "chunk missing",
      sharedSections: SHARED,
    });
    assert.equal(failed.status, "error");
    assert.deepEqual(
      failed.sections.map(([id]) => id),
      SHARED.map(([id]) => id)
    );

    assert.equal(isElryanHostTab("connection"), true);
    assert.equal(isElryanHostTab("elryanWarrantyMapping"), true);
    assert.equal(isElryanHostTab("elryanDimensionsMapping"), true);
    assert.equal(isElryanHostTab("syncOne"), true);
    assert.equal(isElryanHostTab("syncAll"), true);
    assert.equal(isElryanHostTab("mapping"), true);
    assert.equal(isElryanHostTab("overview"), false);
    assert.equal(isElryanHostTab("products"), false);

    const chunkError = new Error("Failed to fetch dynamically imported module");
    assert.equal(elryanLoadError(chunkError, "fallback"), chunkError);
    assert.equal(elryanLoadError(null, "Failed to load Elryan platform host.").message, "Failed to load Elryan platform host.");
    assert.equal(elryanLoadError(new Error("  "), "Failed to load Elryan platform sections.").message, "Failed to load Elryan platform sections.");
  });
});
