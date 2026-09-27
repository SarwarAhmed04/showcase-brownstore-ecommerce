import ExcelJS from "exceljs";
import { Product } from "../models/Product.js";
import { PlatformProduct } from "../models/PlatformProduct.js";
import { applyCommissionRate, commissionMatchFilter, winningCommission } from "./commission.js";
import { partnerPricePreview } from "./partnerCatalog.js";
import { toResolvedProduct } from "./productView.js";

const MEDIA_ORIGIN = String(process.env.MEDIA_PUBLIC_ORIGIN || "https://api.brownstore.net").replace(
  /\/$/,
  ""
);

export const EXCEL_FIELDS = [
  { key: "nameKu", label: "Name (KU)", width: 36 },
  { key: "nameEn", label: "Name (EN)", width: 36 },
  { key: "nameAr", label: "Name (AR)", width: 36 },
  { key: "descriptionKu", label: "Description (KU)", width: 48 },
  { key: "descriptionEn", label: "Description (EN)", width: 48 },
  { key: "descriptionAr", label: "Description (AR)", width: 48 },
  { key: "sku", label: "SKU", width: 18 },
  { key: "stock", label: "Stock", width: 18 },
  { key: "price", label: "Price", width: 18 },
  { key: "discountPrice", label: "Discount price", width: 18 },
  { key: "commission", label: "Commission %", width: 18 },
  { key: "platformPrice", label: "Platform price", width: 18 },
  { key: "availability", label: "Availability", width: 18 },
  { key: "status", label: "Status", width: 18 },
  { key: "brandKu", label: "Brand (KU)", width: 18 },
  { key: "brandEn", label: "Brand (EN)", width: 18 },
  { key: "brandAr", label: "Brand (AR)", width: 18 },
  { key: "warrantyKu", label: "Warranty (KU)", width: 22 },
  { key: "warrantyEn", label: "Warranty (EN)", width: 22 },
  { key: "warrantyAr", label: "Warranty (AR)", width: 22 },
  { key: "badge", label: "Badge", width: 18 },
  { key: "keywords", label: "Keywords", width: 28 },
  { key: "featured", label: "Featured", width: 16 },
  { key: "newArrival", label: "New arrival", width: 16 },
  { key: "bestSeller", label: "Best seller", width: 16 },
  { key: "variants", label: "Variants", width: 28 },
];

const FIELD_KEYS = new Set(EXCEL_FIELDS.map((field) => field.key));
const FIELD_BY_KEY = Object.fromEntries(EXCEL_FIELDS.map((field) => [field.key, field]));

export function excelHeader(key) {
  if (FIELD_BY_KEY[key]) return FIELD_BY_KEY[key].label;
  const image = /^image:(\d+)$/.exec(String(key || ""));
  return image ? `Image ${image[1]}` : String(key || "");
}

function isImageKey(key) {
  const image = /^image:(\d+)$/.exec(String(key || ""));
  if (!image) return 0;
  const n = Number(image[1]);
  return n >= 1 && n <= 30 ? n : 0;
}

export function savedExcelOrder(saved) {
  const used = new Set();
  const order = [];
  for (const raw of Array.isArray(saved) ? saved : []) {
    const key = String(raw || "");
    if (!key || used.has(key)) continue;
    if (FIELD_KEYS.has(key) || isImageKey(key)) {
      order.push(key);
      used.add(key);
    }
  }
  return order;
}

function takeSavedOrder(saved) {
  const order = savedExcelOrder(saved);
  const used = new Set(order);
  for (const field of EXCEL_FIELDS) {
    if (!used.has(field.key)) order.push(field.key);
  }
  return order;
}

const EXCEL_IMAGE_SLOTS = 10;

export function editorExcelOrder(saved) {
  const order = takeSavedOrder(saved);
  const used = new Set(order);
  for (let n = 1; n <= EXCEL_IMAGE_SLOTS; n += 1) {
    const key = `image:${n}`;
    if (!used.has(key)) order.push(key);
  }
  return order;
}

export function downloadExcelOrder(saved, imageCount) {
  const count = Math.max(EXCEL_IMAGE_SLOTS, Number(imageCount) || 0);
  const order = editorExcelOrder(saved).filter((key) => {
    const n = isImageKey(key);
    return !n || n <= count;
  });
  const have = new Set(order);
  const extra = [];
  for (let n = 1; n <= count; n += 1) {
    const key = `image:${n}`;
    if (!have.has(key)) extra.push(key);
  }
  if (!extra.length) return order;
  let insertAt = order.length;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (isImageKey(order[i])) {
      insertAt = i + 1;
      break;
    }
  }
  order.splice(insertAt, 0, ...extra);
  return order;
}

export function visibleExcelOrder(saved, customized) {
  if (customized) return savedExcelOrder(saved);
  const exact = savedExcelOrder(saved);
  if (exact.length > 0) return exact;
  return editorExcelOrder([]);
}

export function excelColumnList(saved, customized = false) {
  return visibleExcelOrder(saved, customized).map((key) => ({ key, label: excelHeader(key) }));
}

function locText(value, key) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value.name) return locText(value.name, key);
  if (value[key]) return String(value[key]);
  const text = value.value || value.text || value.label;
  if (text != null && text !== "") return String(text);
  return "";
}

function yesNo(value) {
  return value ? "Yes" : "No";
}

export function publicMediaUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let path = value;
  try {
    if (/^https?:\/\//i.test(value)) path = new URL(value).pathname;
  } catch {
    path = value;
  }
  const match = String(path).match(/uploads\/products\/[^?#\s]+/i);
  if (match) return `${MEDIA_ORIGIN}/api/media/${match[0]}`;
  const cleaned = String(path)
    .replace(/^\/+/, "")
    .replace(/^api\/media\//, "")
    .replace(/^soi\/media\//, "")
    .replace(/^media\//, "");
  if (!cleaned) return "";
  return `${MEDIA_ORIGIN}/api/media/${cleaned}`;
}

function imageUrls(product) {
  const seen = new Set();
  const urls = [];
  function push(url) {
    const next = publicMediaUrl(url);
    if (!next || seen.has(next)) return;
    seen.add(next);
    urls.push(next);
  }
  for (const variant of product.variants || []) {
    for (const image of variant.images || []) push(image?.url);
  }
  push(product.image);
  return urls;
}

function variantSummary(variants) {
  return (variants || [])
    .map((variant) => {
      const color =
        locText(variant.color, "en") || locText(variant.color, "ku") || locText(variant.color, "ar");
      const sizes = (variant.sizes || [])
        .map((size) => {
          const label = size.size || size.name || size.label || "";
          const stock = Number(size.stockQuantity) || 0;
          return label ? `${label} (${stock})` : String(stock);
        })
        .filter(Boolean)
        .join(", ");
      return [color, sizes].filter(Boolean).join(" — ");
    })
    .filter(Boolean)
    .join("\n");
}

function productRow(product, rules, extra) {
  const resolved = toResolvedProduct(product, extra);
  if (!resolved) return null;
  const rule = winningCommission(product, rules);
  if (!rule) return null;
  const preview = partnerPricePreview(product, rules, extra);
  const rate = Number(rule.percentage);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  const listPrice = Number(resolved.price) || 0;
  const discountPrice = Number(resolved.discountPrice) || 0;
  const commissionedPrice = preview.customPrice
    ? preview.price
    : applyCommissionRate(listPrice, safeRate);
  const commissionedDiscount = preview.customPrice
    ? discountPrice
    : discountPrice > 0
      ? applyCommissionRate(discountPrice, safeRate)
      : 0;
  const keywords = Array.isArray(resolved.keyword) ? resolved.keyword.filter(Boolean).join(", ") : "";
  return {
    cells: {
      nameKu: locText(resolved.name, "ku"),
      nameEn: locText(resolved.name, "en"),
      nameAr: locText(resolved.name, "ar"),
      descriptionKu: locText(resolved.description, "ku"),
      descriptionEn: locText(resolved.description, "en"),
      descriptionAr: locText(resolved.description, "ar"),
      sku: resolved.sku || resolved.itemCode || "",
      stock: resolved.stock ?? 0,
      price: commissionedPrice,
      discountPrice: commissionedDiscount,
      commission: safeRate,
      platformPrice: preview.customPrice ? preview.price : applyCommissionRate(preview.storePrice, safeRate),
      availability: resolved.outOfStock ? "Out of stock" : "In stock",
      status: resolved.isActive === false ? "Inactive" : "Active",
      brandKu: locText(resolved.brand, "ku"),
      brandEn: locText(resolved.brand, "en"),
      brandAr: locText(resolved.brand, "ar"),
      warrantyKu: locText(resolved.warranty, "ku"),
      warrantyEn: locText(resolved.warranty, "en"),
      warrantyAr: locText(resolved.warranty, "ar"),
      badge: resolved.badge || "",
      keywords,
      featured: yesNo(resolved.is_featured),
      newArrival: yesNo(resolved.is_new_arrival),
      bestSeller: yesNo(resolved.is_best_seller),
      variants: variantSummary(resolved.variants),
    },
    images: imageUrls(resolved),
  };
}

function orderedValue(row, key) {
  const image = isImageKey(key);
  if (image) return row.images[image - 1] || "";
  return row.cells[key] ?? "";
}

export async function countCommissionProducts(rules) {
  const filter = commissionMatchFilter(rules);
  if (!filter) return 0;
  return Product.countDocuments(filter);
}

export async function buildCommissionWorkbook(partner, rules) {
  const filter = commissionMatchFilter(rules);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Brown Store";
  const sheet = workbook.addWorksheet("Excel");

  const rows = [];
  if (filter) {
    const [products, overrides] = await Promise.all([
      Product.find(filter).sort({ itemCode: 1 }).lean(),
      PlatformProduct.find({ partner: partner.slug }).lean(),
    ]);
    const overrideMap = new Map(
      overrides.map((row) => [String(row.product), row.overrides || {}])
    );
    for (const product of products) {
      const row = productRow(product, rules, overrideMap.get(String(product._id)) || {});
      if (row) rows.push(row);
    }
  }

  const order = visibleExcelOrder(partner.excelColumns, Boolean(partner.excelColumnsSet));
  const header = sheet.addRow(order.map(excelHeader));
  header.font = { bold: true };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF3E6D4" },
  };
  header.alignment = { vertical: "middle" };

  for (const row of rows) {
    const added = sheet.addRow(order.map((key) => orderedValue(row, key)));
    added.alignment = { vertical: "top" };
    order.forEach((key, index) => {
      if (!isImageKey(key)) return;
      const url = orderedValue(row, key);
      if (!url) return;
      const cell = added.getCell(index + 1);
      cell.value = { text: url, hyperlink: url };
      cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
    });
  }

  order.forEach((key, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = isImageKey(key) ? 72 : FIELD_BY_KEY[key]?.width || 18;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(order.length, 1) },
  };
  return { workbook, total: rows.length };
}
