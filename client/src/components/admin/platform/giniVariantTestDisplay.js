export const GINI_VARIANT_TEST_PRODUCT_ID = "6ae09068b3764a909f69494a";

export function canConfirmGiniVariantTest({ preview, confirmed, busy, writesEnabled } = {}) {
  return Boolean(
    writesEnabled === true &&
      confirmed === true &&
      busy !== true &&
      preview?.canSend === true &&
      preview?.writesEnabled === true &&
      preview?.readyForLiveTest === true &&
      preview?.productId === GINI_VARIANT_TEST_PRODUCT_ID
  );
}

export function canConfirmGiniVariantStage({ stage, preview, confirmed, acceptUniqueness, busy, writesEnabled } = {}) {
  if (writesEnabled !== true || confirmed !== true || busy === true || preview?.writesEnabled !== true) return false;
  if (preview?.productId !== GINI_VARIANT_TEST_PRODUCT_ID) return false;
  if (stage === "parent") return preview?.stagePlan?.parent?.actionable === true && !(preview?.stagePlan?.parent?.blockers || []).includes("variant_sku_uniqueness_unproven");
  if (stage === "variants") return preview?.stagePlan?.variants?.actionable === true && acceptUniqueness === true;
  return false;
}

const STAGE_BLOCKER_TEXT = {
  stage_not_ready: "This stage is missing required preview data.",
  image_bytes_missing: "A required image did not load as file bytes.",
  parent_lookup_uncertain: "The parent SKU could not be read.",
  parent_already_exists: "The parent already exists on GINI. Stage A will not create another.",
  operation_in_progress: "A write is already recorded as in progress.",
  operation_uncertain: "An earlier write has an uncertain result.",
  stage_b_parent_not_verified: "Stage B stays closed until Stage A has verified the hidden parent.",
  variant_sku_conflict: "A proposed variant SKU already belongs to a BrownStore or GINI product.",
  variant_sku_lookup_incomplete: "A variant SKU lookup did not finish.",
  duplicate_brownstore_sku: "More than one BrownStore product uses this SKU.",
  category_not_confirmed: "The saved GINI category mapping is not category 3 and subcategory 3.",
  color_attribute_mismatch: "GINI Color attribute 3696 did not return Blue, Black, and Purple.",
  variant_test_product_mismatch: "This workflow accepts only the Jawal Flex Xiaomi 17T Pro test product.",
  missing_variant_image: "A variation has no image file for the documented variant image field.",
  missing_name: "Missing Arabic or English product name.",
  missing_description: "Missing Arabic description.",
};

function blockerText(codes) {
  return (codes || []).map((code) => STAGE_BLOCKER_TEXT[code] || code);
}

export function describeGiniVariantStages({ preview, confirmParent = false, confirmVariants = false, acceptUniqueness = false, busy = false, writesEnabled = false } = {}) {
  const parent = preview?.stagePlan?.parent || {};
  const variants = preview?.stagePlan?.variants || {};
  const parentBlockers = parent.blockers || [];
  const gateOn = writesEnabled === true && preview?.writesEnabled === true && busy !== true;
  const parentStatus = parent.actionable !== true
    ? "blocked"
    : gateOn && confirmParent === true
      ? "open"
      : "ready, confirmation required";
  let variantStatus = "blocked";
  if (variants.actionable === true) {
    if (variants.uniquenessUnproven === true && acceptUniqueness !== true) variantStatus = "blocked, acknowledgement required";
    else if (gateOn && confirmVariants === true) variantStatus = "open";
    else variantStatus = "ready, confirmation required";
  }
  return {
    parentBlockedByUniqueness: parentBlockers.includes("variant_sku_uniqueness_unproven"),
    parentStatus,
    parentBlockerMessages: blockerText(parentBlockers),
    variantStatus,
    variantBlockerMessages: blockerText(variants.blockers || []),
    uniquenessMessage: variants.uniquenessUnproven === true
      ? "Global variant-SKU uniqueness is unproven. Stage B stays closed until that risk is explicitly acknowledged. Stage A does not use this check."
      : "",
  };
}
