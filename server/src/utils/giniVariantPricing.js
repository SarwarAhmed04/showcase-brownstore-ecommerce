import { applyCommissionRate, winningCommission } from "./commission.js";

function ruleName(rule) {
  const name = rule?.targetName;
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  return String(name.en || name.ku || name.ar || "").trim();
}

function commissionView(rule, rate) {
  if (!rule) return null;
  return {
    scope: String(rule.scope || ""),
    percentage: rate,
    targetId: String(rule.targetId || ""),
    targetName: ruleName(rule),
  };
}

function supportedOwnPrice(value) {
  const price = Number(value);
  return Number.isInteger(price) && price >= 1 ? price : null;
}

function parentBase(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Variant GINI price uses the same rule precedence and 250 IQD rounding as a simple product.
 * A positive integer size or color price is the base. Otherwise the parent selling price is the base.
 */
export function quoteVariantGiniPrice({
  product = null,
  rules = [],
  ownPrice = null,
  parentStorePrice = null,
  parentPriceReview = false,
} = {}) {
  const rule = product ? winningCommission(product, rules) : null;
  const rate = rule && Number.isFinite(Number(rule.percentage)) ? Number(rule.percentage) : 0;
  const own = supportedOwnPrice(ownPrice);
  const parent = parentBase(parentStorePrice);
  if (parentPriceReview === true && own == null) {
    return {
      basePrice: null,
      giniPrice: null,
      rate,
      usedOwnPrice: false,
      priceReview: true,
      commission: commissionView(rule, rate),
    };
  }
  const base = own != null ? own : parent;
  if (base == null) {
    return {
      basePrice: null,
      giniPrice: null,
      rate,
      usedOwnPrice: false,
      priceReview: false,
      commission: commissionView(rule, rate),
    };
  }
  return {
    basePrice: base,
    giniPrice: applyCommissionRate(base, rate),
    rate,
    usedOwnPrice: own != null,
    priceReview: false,
    commission: commissionView(rule, rate),
  };
}

export function applyCatalogVariantPrices(product, rules = []) {
  const scope = product?.priceScope;
  const combinations = Array.isArray(product?.combinations) ? product.combinations : [];
  const hasOwn = combinations.some((row) => row && row.ownPrice != null && row.ownPrice !== "");
  if (!scope && !hasOwn) return product;
  const synthetic = scope
    ? {
        createdBy: { _id: scope.vendorId || "" },
        brand: { _id: scope.brandId || "" },
        category: { _id: scope.categoryId || "" },
        subCategory: { _id: scope.subCategoryId || "" },
        collectionName: { _id: scope.collectionId || "" },
      }
    : null;
  return {
    ...product,
    combinations: combinations.map((combo) => {
      const pricing = quoteVariantGiniPrice({
        product: synthetic,
        rules,
        ownPrice: combo?.ownPrice,
        parentStorePrice: scope?.storePrice,
        parentPriceReview: scope?.priceReview === true,
      });
      if (!Number.isInteger(pricing.giniPrice)) return { ...combo, pricing };
      return { ...combo, price: pricing.giniPrice, pricing };
    }),
  };
}
