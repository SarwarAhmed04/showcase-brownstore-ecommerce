import { Product } from "../models/Product.js";
import { GiniVariantAttributeContract } from "../models/GiniVariantAttributeContract.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { clearVariantCatalogCache } from "./giniVariantSync.js";
import { mongoVariantTestOperation } from "./giniVariantTest.js";
import { performGiniRequest } from "./giniConnection.js";
import { variantColorLabel } from "../utils/giniVariantCatalog.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import {
  GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID,
  GINI_VARIANT_TEST_PARENT_SKU,
  GINI_VARIANT_TEST_PRODUCT_ID,
  GINI_VARIANT_TEST_VARIATIONS,
} from "../utils/giniVariantTestContract.js";
import { executeVariantReadBack } from "../utils/giniVariantTestStages.js";

export async function verifyXiaomiVariantReadBack({ perform = performGiniRequest, operation = mongoVariantTestOperation() } = {}) {
  const result = await executeVariantReadBack({ operation, perform });
  if (!result.verified) return { ...result, sentToGini: 0, syncStateChanged: false };
  const product = await Product.findById(GINI_VARIANT_TEST_PRODUCT_ID).select("ibsherId itemCode createdBy variants").lean();
  if (!product) return { ...result, sentToGini: 0, syncStateChanged: false, code: "variant_test_product_mismatch" };
  const values = GINI_VARIANT_TEST_VARIATIONS.map((row) => row.color);
  await GiniVariantAttributeContract.updateOne(
    { key: "color" },
    {
      $set: {
        attributeId: GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID,
        name: "Color",
        values,
        source: "gini-get-75244",
        verifiedAt: new Date(),
      },
    },
    { upsert: true }
  );
  await GiniVariantParentOwner.updateOne(
    { skuKey: giniSkuKey(GINI_VARIANT_TEST_PARENT_SKU) },
    {
      $set: {
        parentSku: GINI_VARIANT_TEST_PARENT_SKU,
        productId: GINI_VARIANT_TEST_PRODUCT_ID,
        vendorId: String(product.createdBy?._id || ""),
        giniProductId: String(result.parent?.id || "613402"),
        parentQuantity: result.parentQuantity,
        visibility: "hidden",
        verifiedAt: new Date(),
        status: "verified_remote",
        approvalNote: "Recorded from a GET-only read-back. The other vendor document was not merged.",
      },
    },
    { upsert: true }
  );
  for (const remote of result.rows || []) {
    const expected = GINI_VARIANT_TEST_VARIATIONS.find((row) => giniSkuKey(row.sku) === giniSkuKey(remote.sku));
    const source = (product.variants || []).find((variant) => variantColorLabel(variant.color).toLowerCase() === expected?.color.toLowerCase());
    const size = source?.sizes?.[0];
    if (!expected || !source?._id || !size?._id) continue;
    await GiniVariantIdentity.updateOne(
      { productId: GINI_VARIANT_TEST_PRODUCT_ID, sourceVariantId: String(source._id), sourceSizeId: String(size._id) },
      {
        $set: {
          ibsherId: String(product.ibsherId || ""),
          vendorId: String(product.createdBy?._id || ""),
          parentSku: GINI_VARIANT_TEST_PARENT_SKU,
          parentSkuKey: giniSkuKey(GINI_VARIANT_TEST_PARENT_SKU),
          proposedSku: expected.sku,
          proposedSkuKey: giniSkuKey(expected.sku),
          approvedSku: expected.sku,
          approvedSkuKey: giniSkuKey(expected.sku),
          confirmedGiniVariantId: String(remote.id || ""),
          attributeId: GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID,
          attributeName: "Color",
          attributeValue: expected.color,
          lastVerifiedQuantity: Number(remote.quantity),
          lastVerifiedPrice: Number(remote.price),
          lastVerifiedAt: new Date(),
          approvedAt: new Date(),
          approvalNote: "Confirmed by GET read-back of the existing Xiaomi variants. No new write was sent.",
          status: "verified",
        },
      },
      { upsert: true }
    );
  }
  clearVariantCatalogCache();
  return { ...result, sentToGini: 0, syncStateChanged: false };
}
