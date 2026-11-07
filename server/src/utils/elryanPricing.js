import crypto from "crypto";
import { Commission } from "../models/Commission.js";
import { resolveCommissionRate, winningCommission } from "./commission.js";
import { partnerPricePreview } from "./partnerCatalog.js";
import { toResolvedProduct } from "./productView.js";
import { ELRYAN_READINESS } from "./elryanConstants.js";

/**
 * Outgoing Elryan `price` uses Elryan commission rules only.
 * No applicable Elryan rule keeps the BrownStore selling price unchanged.
 * An applicable rule keeps the existing commission calculation and 250 IQD rounding.
 * `cost` stays omitted. Elryan's marketplace commission is not added.
 */
export const ELRYAN_PRICING_NOTE =
  "Outgoing price comes from the BrownStore selling price and Elryan commission rules only. If no Elryan rule applies, the selling price is sent unchanged. If an Elryan rule applies, the existing commission calculation and 250 IQD rounding are used. cost is omitted. Elryan marketplace commission and vendor payout are not added and are not required.";

export const ELRYAN_PACKAGE_DIMENSIONS_NOTE =
  "UNVERIFIED. Create lets width, height, and depth fall back to the category minimum. A category without a minimum makes all three required. Category responses do not include those minimums, so dimensions are not invented and are not treated as universally required.";

export function elryanCommissionRules(rules) {
  return (rules || []).filter((rule) => rule && rule.partner === "elryan" && rule.isActive !== false);
}

export function elryanPricingSource(rules, winningRule) {
  const fingerprint = elryanCommissionRules(rules)
    .map((rule) => ({
      id: String(rule._id || ""),
      scope: String(rule.scope || ""),
      targetId: String(rule.targetId || ""),
      percentage: Number(rule.percentage),
      updatedAt: rule.updatedAt ? new Date(rule.updatedAt).toISOString() : "",
    }))
    .sort((left, right) =>
      `${left.id}|${left.scope}|${left.targetId}`.localeCompare(`${right.id}|${right.scope}|${right.targetId}`)
    );
  const applied =
    winningRule && winningRule.partner === "elryan"
      ? {
          id: String(winningRule._id || ""),
          scope: String(winningRule.scope || ""),
          targetId: String(winningRule.targetId || ""),
          percentage: Number(winningRule.percentage),
        }
      : null;
  return { partner: "elryan", applied, rules: fingerprint };
}

/** Binds the Elryan body to the BrownStore rules that produced it. The body itself is unchanged. */
export function elryanOutboundPriceHash(payload, pricingSource) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        payload: payload || {},
        pricingSource: pricingSource || { partner: "elryan", applied: null, rules: [] },
      })
    )
    .digest("hex");
}

/**
 * BrownStore selling price plus Elryan commission rules only.
 * Proposed Elryan field: `price`. `cost` stays omitted.
 */
export async function buildElryanPricingView(productDoc, { commissionRules } = {}) {
  const loaded =
    commissionRules || (await Commission.find({ partner: "elryan", isActive: { $ne: false } }).lean());
  const rules = elryanCommissionRules(loaded);
  const resolved = toResolvedProduct(productDoc);
  const preview = partnerPricePreview(productDoc, rules);
  const rule = winningCommission(productDoc, rules);
  const rate = resolveCommissionRate(productDoc, rules);
  const pricingSource = elryanPricingSource(rules, rule);
  if (resolved?.priceReview || preview.priceReview) {
    return {
      storeSellingPrice: null,
      commissionRate: rate,
      commission: preview.commission,
      commissionScope: rule?.scope || null,
      commissionTargetId: rule?.targetId || null,
      winningScope: rule?.scope || null,
      rawPrice: null,
      platformPrice: null,
      proposedElryanPrice: null,
      proposedElryanCost: null,
      priceReview: true,
      priceReviewReason: resolved?.priceReviewReason || preview.priceReviewReason || "missing_regular_price",
      pricingStatus: ELRYAN_READINESS.NOT_READY,
      pricingNote: "The BrownStore selling price is missing or ambiguous, so no Elryan price is sent.",
      pricingSource,
      elryanCommissionInvestigation: null,
    };
  }
  const selling = Number(resolved?.sellingPrice) || 0;
  const ruled = Boolean(rule);
  const platformPrice = ruled ? preview.price : selling;
  const rawPrice = ruled ? preview.rawPrice : selling;
  const pricingNote = ruled
    ? "Outgoing price is the BrownStore selling price plus the Elryan commission rule, rounded with the existing 250 IQD step. cost is omitted. Elryan marketplace commission is not added."
    : "No Elryan commission rule applies. Outgoing price is the BrownStore selling price unchanged. cost is omitted. Elryan marketplace commission is not added.";
  return {
    storeSellingPrice: selling,
    commissionRate: rate,
    commission: ruled ? preview.commission : 0,
    commissionScope: rule?.scope || null,
    commissionTargetId: rule?.targetId || null,
    winningScope: rule?.scope || null,
    rawPrice,
    platformPrice,
    proposedElryanPrice: platformPrice > 0 ? platformPrice : null,
    proposedElryanCost: null,
    priceReview: false,
    priceReviewReason: "",
    pricingStatus: "RESOLVED",
    pricingNote,
    pricingSource,
    elryanCommissionInvestigation: null,
  };
}

export function attachCommissionInvestigation(pricingView, investigation) {
  return {
    ...pricingView,
    elryanCommissionInvestigation: investigation || null,
  };
}
