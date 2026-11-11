import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildGiniMappingExport,
  describeMongoTarget,
  giniValuesComplete,
  mappingIdentityKey,
  sanitizeText,
} from "./scripts/giniProductionMappingExport.js";

function runExportProcess(args = []) {
  const script = fileURLToPath(new URL("./scripts/giniProductionMappingExport.js", import.meta.url));
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
      reject(new Error("mapping export process timed out"));
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
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("GINI production mapping export", () => {
  it("describes a database target without keeping credentials", () => {
    const described = describeMongoTarget("mongodb://audit-user:audit-secret@db.example.com:27017/brownstore?authSource=admin");
    const text = JSON.stringify(described);
    assert.equal(text.includes("audit-secret"), false);
    assert.equal(text.includes("audit-user"), false);
    assert.equal(described.host, "db.example.com:27017");
    assert.equal(described.database, "brownstore");
    assert.equal(described.loopback, false);
  });

  it("removes connection strings from errors", () => {
    const cleaned = sanitizeText("failed mongodb+srv://user:secret@cluster.example/brownstore");
    assert.equal(cleaned.includes("secret"), false);
    assert.equal(cleaned.includes("mongodb+srv://user"), false);
  });

  it("builds an identity from the full category, subcategory, and collection path", () => {
    const key = mappingIdentityKey(
      { en: "Stand Mixers", ar: "عجانات", ku: "هەویرشێل" },
      { en: "Home & Kitchen Appliances", ar: "الأجهزة", ku: "ئامێر" },
      { en: "Food Preparation", ar: "تحضير", ku: "خۆراک" }
    );
    assert.equal(key.includes("stand mixers"), true);
    assert.equal(key.includes("|"), true);
    assert.equal(mappingIdentityKey({}, {}, {}), "");
  });

  it("marks incomplete, unresolved, ambiguous, and duplicate rows ineligible", () => {
    assert.equal(giniValuesComplete({ categoryId: "3", categoryName: "A", subcategoryId: "3", subcategoryName: "B" }), true);
    const phones = {
      _id: "local-phones",
      collection: { en: "Android Smartphones", ar: "هواتف", ku: "مۆبایل" },
      category: { en: "Electronics", ar: "إلكترونيات", ku: "ئەلیکترۆنی" },
      subcategory: { en: "Smartphones", ar: "هواتف", ku: "مۆبایل" },
      categoryIds: ["cat-1"],
      subcategoryIds: ["sub-1"],
      productCount: 10,
      multiVariantProductCount: 4,
    };
    const exportRows = buildGiniMappingExport(
      [
        {
          partner: "gini",
          brownCollectionId: "local-phones",
          values: { categoryId: "3", categoryName: "Phones", subcategoryId: "3", subcategoryName: "Mobiles" },
        },
        {
          partner: "gini",
          brownCollectionId: "missing-products",
          values: { categoryId: "9", categoryName: "Other", subcategoryId: "33", subcategoryName: "Video" },
        },
        {
          partner: "gini",
          brownCollectionId: "split-path",
          values: { categoryId: "1", categoryName: "", subcategoryId: "", subcategoryName: "Partial" },
        },
        {
          partner: "miswag",
          brownCollectionId: "ignored",
          values: { categoryId: "L3-1" },
        },
        {
          partner: "gini",
          brownCollectionId: "same-name-a",
          values: { categoryId: "7", categoryName: "Beauty", subcategoryId: "7", subcategoryName: "Perfume" },
        },
        {
          partner: "gini",
          brownCollectionId: "same-name-b",
          values: { categoryId: "8", categoryName: "Other", subcategoryId: "8", subcategoryName: "Other" },
        },
      ],
      [
        phones,
        {
          _id: "split-path",
          collection: { en: "Blenders", ar: "خلاطات", ku: "خەڵاتە" },
          category: { en: "Home", ar: "منزل", ku: "ماڵ" },
          subcategory: { en: "Food", ar: "طعام", ku: "خۆراک" },
          categoryIds: ["cat-a", "cat-b"],
          subcategoryIds: ["sub-a"],
          productCount: 5,
          multiVariantProductCount: 2,
        },
        {
          _id: "same-name-a",
          collection: { en: "Watches", ar: "ساعات", ku: "کاتژمێر" },
          category: { en: "Fashion", ar: "أزياء", ku: "پۆشاک" },
          subcategory: { en: "Watches", ar: "ساعات", ku: "کاتژمێر" },
          categoryIds: ["cat-w"],
          subcategoryIds: ["sub-w"],
          productCount: 3,
          multiVariantProductCount: 1,
        },
        {
          _id: "same-name-b",
          collection: { en: "Watches", ar: "ساعات", ku: "کاتژمێر" },
          category: { en: "Fashion", ar: "أزياء", ku: "پۆشاک" },
          subcategory: { en: "Watches", ar: "ساعات", ku: "کاتژمێر" },
          categoryIds: ["cat-w"],
          subcategoryIds: ["sub-w"],
          productCount: 2,
          multiVariantProductCount: 1,
        },
      ]
    );

    assert.equal(exportRows.summary.mappingCount, 5);
    assert.equal(exportRows.mappings.some((row) => row.partner !== "gini"), false);
    const phone = exportRows.mappings.find((row) => row.brownCollectionId === "local-phones");
    assert.equal(phone.importEligible, true);
    assert.equal(phone.multiVariantProductCount, 4);
    assert.equal(phone.collection.en, "Android Smartphones");
    const missing = exportRows.mappings.find((row) => row.brownCollectionId === "missing-products");
    assert.equal(missing.identityResolved, false);
    assert.equal(missing.importEligible, false);
    const split = exportRows.mappings.find((row) => row.brownCollectionId === "split-path");
    assert.equal(split.complete, false);
    assert.equal(split.ambiguousHierarchy, true);
    assert.equal(split.importEligible, false);
    const duplicates = exportRows.mappings.filter((row) => row.duplicateIdentity);
    assert.equal(duplicates.length, 2);
    assert.equal(duplicates.every((row) => row.importEligible === false), true);
    assert.equal(JSON.stringify(exportRows).includes("catalogcollections"), false);
  });

  it("contains no database write operations", () => {
    const source = fs.readFileSync(new URL("./scripts/giniProductionMappingExport.js", import.meta.url), "utf8");
    for (const word of ["updateOne", "updateMany", "insertOne", "insertMany", "deleteOne", "deleteMany", "bulkWrite", "findOneAndUpdate", "replaceOne", "save("]) {
      assert.equal(source.includes(word), false, word);
    }
    assert.equal(source.includes("catalogcollections"), false);
    assert.equal(source.includes("--confirm-production"), true);
    assert.equal(source.includes('partner: "gini"'), true);
  });

  it("refuses to run without --confirm-production", async () => {
    const result = await runExportProcess([]);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-production/);
    assert.equal(result.stdout.includes("mongodb"), false);
    assert.equal(result.stderr.includes("mongodb+srv"), false);
  });
});
