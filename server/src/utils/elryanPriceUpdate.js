import crypto from "node:crypto";

/**
 * Marketplace v1 PATCH /v1/products/{id} writes the customer price on `price`.
 * That field is a number above zero: what the customer pays, in the vendor currency.
 * Sending `cost` calculates the selling price from marketplace commission, so cost is never sent.
 * GET /v1/products/{id} does not return `price`. The actual selling price is `data.sellingPrice`.
 */
export const ELRYAN_PRICE_WRITE_FIELD = "price";
export const ELRYAN_SELLING_PRICE_READ_FIELD = "sellingPrice";
export const ELRYAN_PRICE_UPDATE_ACTION = "production_price_update";
export const ELRYAN_PRICE_CURRENCY = "IQD";

export function readElryanSellingPrice(product) {
  const source = product && typeof product === "object" ? product : {};
  if (!Object.prototype.hasOwnProperty.call(source, ELRYAN_SELLING_PRICE_READ_FIELD)) {
    return { present: false, amount: null };
  }
  const amount = Number(source.sellingPrice);
  return { present: true, amount: Number.isFinite(amount) ? amount : null };
}

export function reviewElryanSellingPrice({ product, approvedPrice, approvalValid = false } = {}) {
  const current = readElryanSellingPrice(product);
  const currency = String(product?.currency || "").trim();
  const approved = Number(approvedPrice);
  const approvedOk = approvalValid === true && Number.isFinite(approved) && approved > 0;
  const patch = {};
  let priceCode = "price_differs";
  if (!current.present || current.amount == null) priceCode = "selling_price_unreadable";
  else if (currency && currency !== ELRYAN_PRICE_CURRENCY) priceCode = "currency_mismatch";
  else if (!approvedOk) priceCode = "pricing_unverified";
  else if (current.amount === approved) priceCode = "price_unchanged";
  else patch.price = approved;
  return {
    currentSellingPrice: current.amount,
    approvedPrice: approvedOk ? approved : null,
    currency: currency || ELRYAN_PRICE_CURRENCY,
    pricePatch: patch,
    priceUpdateAllowed: priceCode === "price_differs",
    priceCode,
  };
}

/** Stable binding for one selling-price preview. Key order is part of the token. */
export function elryanPriceUpdateBinding({ listingId, currentSellingPrice, price } = {}) {
  const patch = {};
  if (price != null && Number.isFinite(Number(price))) patch.price = Number(price);
  return {
    action: ELRYAN_PRICE_UPDATE_ACTION,
    listingId: String(listingId || "").trim(),
    currentSellingPrice: currentSellingPrice == null ? null : Number(currentSellingPrice),
    patch,
    currency: ELRYAN_PRICE_CURRENCY,
    readField: ELRYAN_SELLING_PRICE_READ_FIELD,
    writeField: ELRYAN_PRICE_WRITE_FIELD,
  };
}

export function hashElryanPriceUpdateBinding(binding) {
  return crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

export function elryanPriceReviewMessage(priceCode) {
  if (priceCode === "selling_price_unreadable") {
    return "The Production listing did not include sellingPrice. No price was sent.";
  }
  if (priceCode === "currency_mismatch") {
    return "The listing currency is not IQD. No price was sent.";
  }
  if (priceCode === "pricing_unverified") {
    return "The saved Production price approval does not match this SKU, product, and payload. No price was sent.";
  }
  if (priceCode === "price_unchanged") {
    return "The Elryan selling price already matches the approved BrownStore price.";
  }
  return "The Elryan selling price differs from the approved BrownStore price. An explicit update can send only price.";
}
