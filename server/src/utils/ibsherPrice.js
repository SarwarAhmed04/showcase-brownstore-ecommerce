const NUMBER_TYPES = ["double", "int", "long", "decimal"];

function isBlank(value) {
  return value == null || value === "";
}

function isPlainNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numericText(value) {
  const text = String(value).trim();
  return /^\d+(\.\d+)?$/.test(text) ? text : "";
}

/**
 * The original IBSHER regular price. Formatted or non-numeric values stay unresolved
 * so a promotional price cannot be substituted for them.
 */
export function readRegularIbsherPrice(value) {
  if (isBlank(value)) return { ok: false, price: null, reason: "missing_regular_price" };
  if (isPlainNumber(value)) {
    if (value <= 0) return { ok: false, price: null, reason: "missing_regular_price" };
    return { ok: true, price: value, reason: "" };
  }
  if (typeof value === "string") {
    const text = numericText(value);
    if (!text) return { ok: false, price: null, reason: "ambiguous_regular_price" };
    const price = Number(text);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, price: null, reason: "missing_regular_price" };
    }
    return { ok: true, price, reason: "" };
  }
  return { ok: false, price: null, reason: "ambiguous_regular_price" };
}

function positiveAmount(value) {
  if (isBlank(value) || typeof value === "boolean" || typeof value === "object") return 0;
  if (isPlainNumber(value)) return value > 0 ? value : 0;
  if (typeof value === "string") {
    const text = numericText(value);
    if (!text) return 0;
    const amount = Number(text);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }
  return 0;
}

export function readImportedIbsherDiscount(value) {
  return positiveAmount(value);
}

/** Promotional amount BrownStore must ignore. Legacy rows keep it on discountPrice. */
export function importedIbsherDiscount(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const recorded = positiveAmount(source.ibsherDiscountPrice);
  if (recorded > 0) return recorded;
  return positiveAmount(source.discountPrice);
}

function manualAmount(value) {
  if (isBlank(value)) return { set: false, price: null };
  let amount = value;
  if (typeof amount === "string") {
    const text = numericText(amount);
    if (!text) return { set: true, invalid: true, price: null };
    amount = Number(text);
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return { set: true, invalid: true, price: null };
  }
  return { set: true, invalid: false, price: amount };
}

function sameMoney(left, right) {
  return left != null && right != null && Math.abs(left - right) < 1e-6;
}

/** True when a stored discount is the IBSHER promotion, including the value from before a refresh. */
export function matchesImportedDiscount(amount, candidates) {
  const manual = positiveAmount(amount);
  if (!manual) return false;
  return (Array.isArray(candidates) ? candidates : []).some((candidate) =>
    sameMoney(manual, positiveAmount(candidate))
  );
}

function applyPriceLayer(state, overrides) {
  if (!overrides || typeof overrides !== "object") return state;
  const next = {
    manualPrice: state.manualPrice,
    manualDiscount: state.manualDiscount,
  };
  const hasPrice = !isBlank(overrides.price);
  const hasDiscount = !isBlank(overrides.discountPrice);
  if (hasPrice) {
    next.manualPrice = manualAmount(overrides.price);
    if (!hasDiscount) next.manualDiscount = { set: true, cleared: true, price: null };
  }
  if (hasDiscount) {
    const discount = manualAmount(overrides.discountPrice);
    next.manualDiscount =
      discount.invalid || discount.price === 0
        ? { set: true, cleared: !discount.invalid, invalid: Boolean(discount.invalid), price: null }
        : { set: true, price: discount.price };
  }
  return next;
}

/**
 * BrownStore base price is the regular IBSHER price, then an independent manual
 * price or discount. An imported IBSHER promotion never becomes the selling price.
 */
export function resolveBrownStorePrice(raw, overrides, extraOverrides) {
  const source = raw && typeof raw === "object" ? raw : {};
  const regular = readRegularIbsherPrice(source.price);
  const importedDiscount = importedIbsherDiscount(source);
  const layered = applyPriceLayer(applyPriceLayer({
    manualPrice: { set: false, price: null },
    manualDiscount: { set: false, price: null },
  }, overrides), extraOverrides);

  let priceReview = false;
  let priceReviewReason = "";
  let base = null;
  const manualPrice = layered.manualPrice;
  if (manualPrice.set && !manualPrice.invalid && manualPrice.price != null) {
    base = manualPrice.price;
  } else if (regular.ok) {
    base = regular.price;
  } else {
    priceReview = true;
    priceReviewReason = regular.reason || "missing_regular_price";
  }

  let discountPrice = 0;
  let sellingPrice = base;
  let hasDiscount = false;
  const manualDiscount = layered.manualDiscount;
  if (
    !priceReview &&
    manualDiscount.set &&
    !manualDiscount.cleared &&
    !manualDiscount.invalid &&
    manualDiscount.price > 0
  ) {
    const echoesImport = importedDiscount > 0 && sameMoney(manualDiscount.price, importedDiscount);
    if (!echoesImport) {
      discountPrice = manualDiscount.price;
      if (manualDiscount.price < base) {
        sellingPrice = manualDiscount.price;
        hasDiscount = true;
      }
    }
  }

  if (priceReview) {
    base = null;
    sellingPrice = null;
    discountPrice = 0;
    hasDiscount = false;
  }

  return {
    price: base,
    discountPrice,
    sellingPrice,
    hasDiscount,
    importedDiscountPrice: importedDiscount,
    priceReview,
    priceReviewReason,
  };
}

function mongoNumber(expr, { allowZero = false } = {}) {
  return {
    $and: [
      { $in: [{ $type: expr }, NUMBER_TYPES] },
      allowZero ? { $gte: [expr, 0] } : { $gt: [expr, 0] },
    ],
  };
}

/** Admin price filters use the same base as resolveBrownStorePrice. */
export function brownStoreSellingPriceExpr() {
  return {
    $let: {
      vars: {
        regular: { $ifNull: ["$price", null] },
        recordedDiscount: { $ifNull: ["$ibsherDiscountPrice", 0] },
        legacyDiscount: { $ifNull: ["$discountPrice", 0] },
        overridePrice: { $ifNull: ["$overrides.price", null] },
        overrideDiscount: { $ifNull: ["$overrides.discountPrice", null] },
      },
      in: {
        $let: {
          vars: {
            imported: {
              $cond: [
                mongoNumber("$$recordedDiscount"),
                "$$recordedDiscount",
                { $cond: [mongoNumber("$$legacyDiscount"), "$$legacyDiscount", 0] },
              ],
            },
            base: {
              $cond: [
                mongoNumber("$$overridePrice", { allowZero: true }),
                "$$overridePrice",
                { $cond: [mongoNumber("$$regular"), "$$regular", null] },
              ],
            },
          },
          in: {
            $let: {
              vars: {
                manualDiscount: {
                  $cond: [
                    {
                      $and: [
                        mongoNumber("$$overrideDiscount"),
                        { $ne: ["$$overrideDiscount", "$$imported"] },
                      ],
                    },
                    "$$overrideDiscount",
                    null,
                  ],
                },
              },
              in: {
                $cond: [
                  { $eq: ["$$base", null] },
                  null,
                  {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$$manualDiscount", null] },
                          { $lt: ["$$manualDiscount", "$$base"] },
                        ],
                      },
                      "$$manualDiscount",
                      "$$base",
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}
