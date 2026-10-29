import ExcelJS from "exceljs";
import { Commission } from "../../models/Commission.js";
import { PlatformProduct } from "../../models/PlatformProduct.js";
import { Product } from "../../models/Product.js";
import { publicMediaUrl } from "../commissionExcel.js";
import { summarizeDuplicateSkus } from "./duplicateSkus.js";
import { eligibilityBucket, evaluatePlatformEligibility } from "../platformEligibility.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../platformTaxonomy.js";
import { partnerPricePreview } from "../partnerCatalog.js";
import { toResolvedProduct } from "../productView.js";

export const GINI_SHEET_NAME = "Sheet1";
export const GINI_SAFETY_STOCK = 1;

export const GINI_HEADERS = [
  "اسم المنتج",
  "وصف المنتج",
  "الرقم التعريفي للمنتج( SKU )",
  "سعر المنتج",
  "كمية المنتج (رقم )",
  "المخزون الامني ( للأشعارات عند النفاذ )",
  "لون المنتج",
  "فئة المنتج",
  "الفئة الفرعية",
  "Image 1",
  "Image 2",
  "Image 3",
  "Image 4",
  "Image 5",
  "Image 6",
  "Image 7",
  "Image 8",
  "Image 9",
  "Image 10",
];

const MISSING_TEXT = {
  missing_brand: "Missing brand",
  missing_name: "Missing Arabic or English product name",
  missing_description: "Missing Arabic description",
  missing_sku: "Missing SKU",
  missing_color: "Missing product color",
  missing_image: "Missing product image",
  missing_category: "Missing Gini category or subcategory ID",
  price_needs_review: "The original IBSHER regular price is missing or ambiguous",
};

function locText(value, key) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value.name) return locText(value.name, key);
  if (value[key]) return String(value[key]).trim();
  const text = value.value || value.text || value.label;
  return text != null && text !== "" ? String(text).trim() : "";
}

function excelId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text) && String(Number(text)) === text) return Number(text);
  return text;
}

function productImages(product) {
  const seen = new Set();
  const urls = [];
  const push = (url) => {
    const next = publicMediaUrl(url);
    if (!next || seen.has(next)) return;
    seen.add(next);
    urls.push(next);
  };
  for (const variant of product.variants || []) {
    for (const image of variant.images || []) push(image?.url);
  }
  push(product.image);
  return urls.slice(0, 10);
}

function productColor(product) {
  for (const variant of product.variants || []) {
    const color = locText(variant.color, "en") || locText(variant.color, "ku") || locText(variant.color, "ar");
    if (color) return color;
  }
  return "";
}

function giniManualIds(values) {
  const categoryId = String(values?.categoryId || "").trim();
  const subcategoryId = String(values?.subcategoryId || "").trim();
  if (!categoryId || !subcategoryId) return null;
  return { categoryId, subcategoryId };
}

function giniProductRow(product, rules, overrides, context) {
  const resolved = toResolvedProduct(product, overrides);
  if (!resolved) return { missing: ["missing_name"] };
  const brand = locText(resolved.brand, "en") || locText(resolved.brand, "ku") || locText(resolved.brand, "ar");
  const nameAr = locText(resolved.name, "ar");
  const nameEn = locText(resolved.name, "en");
  const description = locText(resolved.description, "ar");
  const sku = String(resolved.itemCode || resolved.sku || "").trim();
  const color = productColor(resolved);
  const images = productImages(resolved);
  const ids = giniManualIds(taxonomyValuesForProduct(product, context));
  const missing = [];
  if (!brand) missing.push("missing_brand");
  if (!nameAr || !nameEn) missing.push("missing_name");
  if (!description) missing.push("missing_description");
  if (!sku) missing.push("missing_sku");
  if (!color) missing.push("missing_color");
  if (!images.length) missing.push("missing_image");
  if (!ids) missing.push("missing_category");
  const stock = Number(resolved.stock);
  const preview = partnerPricePreview(product, rules);
  if (preview.priceReview) missing.push("price_needs_review");
  if (missing.length) return { missing };
  const displayName = nameEn || nameAr;
  const collection =
    locText(resolved.collectionName, "en") ||
    locText(resolved.collectionName, "ku") ||
    locText(resolved.collectionName, "ar");
  const values = [
    `| ${brand} | ${nameAr} / ${nameEn}`,
    description,
    sku,
    preview.price,
    Number.isFinite(stock) ? stock : 0,
    GINI_SAFETY_STOCK,
    color,
    excelId(ids.categoryId),
    excelId(ids.subcategoryId),
    ...images,
  ];
  while (values.length < GINI_HEADERS.length) values.push("");
  return {
    values: values.slice(0, GINI_HEADERS.length),
    price: preview.price,
    rate: preview.rate,
    skuIdentity: {
      sku,
      productId: String(resolved.id || product._id || ""),
      ibsherId: String(resolved.ibsherId || product.ibsherId || ""),
      name: displayName,
      brand,
      collection,
      sellingPrice: Number(preview.storePrice) || 0,
    },
  };
}

export function giniExcelColumns() {
  return GINI_HEADERS.map((label, index) => ({ key: `gini:${index + 1}`, label }));
}

export async function buildGiniExport(partner, rules, options = {}) {
  const writeRows = options.workbook !== false;
  const context = await loadEligibilityContext(partner.slug || partner);
  const slug = partner.slug || partner;
  const overrides = await PlatformProduct.find({ partner: slug }).select("product overrides").lean();
  const overrideMap = new Map(overrides.map((row) => [String(row.product), row.overrides || {}]));
  const workbook = writeRows ? new ExcelJS.Workbook() : null;
  const sheet = workbook ? workbook.addWorksheet(GINI_SHEET_NAME) : null;
  if (sheet) {
    workbook.creator = "Brown Store";
    const header = sheet.addRow(GINI_HEADERS);
    header.font = { bold: true };
  }

  const report = {
    totalProducts: 0,
    eligible: 0,
    blockedInactive: 0,
    blockedUnmapped: 0,
    missingRequired: 0,
    exportRows: 0,
    missing: [],
  };
  const missingCounts = new Map();
  const exportIdentities = [];
  const cursor = Product.find().sort({ itemCode: 1, _id: 1 }).lean().cursor();

  for await (const product of cursor) {
    report.totalProducts += 1;
    const result = evaluatePlatformEligibility(product, context);
    if (!result.eligible) {
      if (eligibilityBucket(result) === "missing_setup") report.blockedUnmapped += 1;
      else report.blockedInactive += 1;
      continue;
    }
    report.eligible += 1;
    const row = giniProductRow(product, rules, overrideMap.get(String(product._id)), context);
    if (row.missing) {
      report.missingRequired += 1;
      for (const code of row.missing) missingCounts.set(code, (missingCounts.get(code) || 0) + 1);
      continue;
    }
    if (sheet) {
      const excelRow = sheet.addRow(row.values);
      row.values.forEach((value, index) => {
        if (index < 9 || !value) return;
        const url = String(value);
        excelRow.getCell(index + 1).value = { text: url, hyperlink: url };
      });
    }
    exportIdentities.push(row.skuIdentity);
    report.exportRows += 1;
  }

  report.missing = [...missingCounts.entries()].map(([code, count]) => ({
    code,
    count,
    message: MISSING_TEXT[code] || code,
  }));
  report.duplicateSkus = summarizeDuplicateSkus(exportIdentities);
  return { workbook, report };
}

export async function giniExportForPartner(partner, options) {
  const rules = await Commission.find({ partner: partner.slug, isActive: { $ne: false } });
  return buildGiniExport(partner, rules, options);
}
