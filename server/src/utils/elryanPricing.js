import { Commission } from "../models/Commission.js";
import { applyCommissionRate, resolveCommissionRate, winningCommission } from "./commission.js";
import { partnerPricePreview } from "./partnerCatalog.js";
import { toResolvedProduct } from "./productView.js";
import { ELRYAN_READINESS } from "./elryanConstants.js";

/**
 * BrownStore platform price only — never invents Elryan cost/net.
 * Proposed Elryan field: `price` = platformPrice; `cost` left unset until Elryan confirms semantics.
 */
export async function buildElryanPricingView(productDoc, { commissionRules } = {}) {
  const rules = commissionRules || (await Commission.find({}).lean());
  const resolved = toResolvedProduct(productDoc);
  const preview = partnerPricePreview(productDoc, rules);
  const rule = winningCommission(productDoc, rules);
  const rate = resolveCommissionRate(productDoc, rules);
  const platformPrice = applyCommissionRate(resolved?.sellingPrice, rate);

  return {
    storeSellingPrice: Number(resolved?.sellingPrice) || 0,
    commissionRate: rate,
    commission: preview.commission,
    winningScope: rule?.scope || null,
    rawPrice: preview.rawPrice,
    platformPrice,
    /** Documented Elryan customer-facing amount — proposed, not confirmed with Elryan net math. */
    proposedElryanPrice: platformPrice > 0 ? platformPrice : null,
    /** Intentionally null — do not fabricate vendor net / cost. */
    proposedElryanCost: null,
    pricingStatus: ELRYAN_READINESS.PRICING_UNVERIFIED,
    pricingNote:
      "BrownStore platform price is proposed as Elryan `price`. Elryan `cost` / marketplace commission relationship is not confirmed; cost is omitted and readiness stays PRICING_UNVERIFIED.",
    elryanCommissionInvestigation: null,
  };
}

export function attachCommissionInvestigation(pricingView, investigation) {
  return {
    ...pricingView,
    elryanCommissionInvestigation: investigation || null,
    pricingStatus: ELRYAN_READINESS.PRICING_UNVERIFIED,
  };
}
