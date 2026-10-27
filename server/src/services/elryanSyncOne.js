import crypto from "crypto";
import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { ElryanSyncOnePreview } from "../models/ElryanSyncOnePreview.js";
import { ElryanProductSyncState } from "../models/ElryanProductSyncState.js";
import { elryanProductWritesEnabled, ELRYAN_READINESS, ELRYAN_PATHS } from "../utils/elryanConstants.js";
import { buildElryanPricingView, attachCommissionInvestigation } from "../utils/elryanPricing.js";
import { buildElryanProductPayload, collectElryanImageUrls } from "../utils/elryanPayloadBuilder.js";
import { validateElryanPreviewParts } from "../utils/elryanValidator.js";
import { assessElryanSellableUnits } from "../utils/elryanVariations.js";
import { toResolvedProduct } from "../utils/productView.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import {
  brownColourKeyFromResolved,
  brownWarrantyKeyFromProduct,
  findElryanBrandMapping,
  findElryanColorMapping,
  findElryanWarrantyMapping,
} from "./elryanAttributeMapping.js";
import { elryanCalculateCommission } from "./elryanCatalog.js";
import { getElryanConnectionPublic, resolveElryanConfig } from "./elryanConnection.js";
import { ElryanClientError, elryanRequest } from "./elryanClient.js";

const PREVIEW_TTL_MS = 20 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function payloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

async function loadProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  return Product.findById(productId).lean();
}

export async function searchElryanSyncProducts(q = "", limit = 20) {
  const query = String(q || "").trim();
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const filter = {};
  if (query) {
    const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { itemCode: rx },
      { "overrides.sku": rx },
      { "name.en": rx },
      { "name.ar": rx },
      { ibsherId: rx },
    ];
  }
  const rows = await Product.find(filter).sort({ updatedAt: -1 }).limit(take).lean();
  return {
    products: rows.map((doc) => {
      const resolved = toResolvedProduct(doc);
      return {
        id: String(doc._id),
        sku: resolved?.sku || doc.itemCode || "",
        name: resolved?.name || {},
        image: resolved?.image || "",
      };
    }),
  };
}

function requiredCodesFromAttributeSet(attributeSet) {
  const raw =
    attributeSet?.attributes ||
    attributeSet?.items ||
    attributeSet?.data?.attributes ||
    (Array.isArray(attributeSet) ? attributeSet : []);
  const list = Array.isArray(raw) ? raw : [];
  const codes = [];
  for (const item of list) {
    const code = item?.code || item?.attributeCode || item?.AttributeCode || item?.name;
    const mandatory =
      item?.mandatory === true ||
      item?.required === true ||
      String(item?.["Mandatory?"] || item?.Mandatory || "").toLowerCase() === "yes" ||
      String(item?.mandatory || "").toLowerCase() === "yes";
    if (code && mandatory) codes.push(String(code));
  }
  return codes;
}

/**
 * Local + optional read-only Elryan investigation. Never writes products.
 */
export async function previewElryanSyncOne({ productId, origin = "", investigateCommission = false } = {}) {
  const connection = await getElryanConnectionPublic();
  const config = await resolveElryanConfig();
  const doc = await loadProduct(productId);
  if (!doc) {
    const error = new Error("Product not found");
    error.status = 404;
    throw error;
  }

  const resolved = toResolvedProduct(doc);
  const ctx = await loadEligibilityContext("elryan");
  const mappingValues = taxonomyValuesForProduct(doc, ctx) || {};
  const variation = assessElryanSellableUnits(resolved);
  const brandId = doc.brand?._id || doc.brand?.id || "";
  const brand = await findElryanBrandMapping(brandId);
  const colourKey = brownColourKeyFromResolved(resolved, variation);
  const color = await findElryanColorMapping(colourKey);
  const warrantyKey = brownWarrantyKeyFromProduct(doc);
  const warranty = await findElryanWarrantyMapping(warrantyKey);
  const warrantyFallback =
    warranty || (warrantyKey !== "default" ? await findElryanWarrantyMapping("default") : null);

  let pricing = await buildElryanPricingView(doc);
  let attributeSet = null;
  let requiredAttributeCodes = [];
  let commissionInvestigation = null;

  if (config.hasApiKey && investigateCommission && mappingValues.categoryId && brand?.elryanLabel) {
    try {
      const calc = await elryanCalculateCommission({
        categoryId: mappingValues.categoryId,
        categoryHierarchy: mappingValues.categoryHierarchy || undefined,
        brand: brand.elryanLabel || brand.brownLabel || String(brandId),
      });
      commissionInvestigation = {
        ok: true,
        classification: "READ",
        calculation: calc.calculation,
      };
      pricing = attachCommissionInvestigation(pricing, commissionInvestigation);
    } catch (err) {
      commissionInvestigation = {
        ok: false,
        classification: "READ",
        message: sanitizeElryanText(err?.message || "Commission calculate failed", [config.apiKey]),
      };
      pricing = attachCommissionInvestigation(pricing, commissionInvestigation);
    }
  }

  // Required attributes: use saved mapping values under attributes.* if present; do not invent.
  const attributes =
    mappingValues.attributes && typeof mappingValues.attributes === "object"
      ? mappingValues.attributes
      : {};

  const images = collectElryanImageUrls(resolved, origin);
  const qty = resolved?.outOfStock ? 0 : Math.max(0, Math.floor(Number(resolved?.stock) || 0));

  const validation = validateElryanPreviewParts({
    hasApiKey: config.hasApiKey,
    resolved,
    sku: resolved?.sku,
    mapping: mappingValues,
    brand,
    color,
    warranty: warrantyFallback,
    attributes,
    requiredAttributeCodes,
    variation,
    pricing,
    images,
  });

  const payload = buildElryanProductPayload({
    resolved,
    sku: resolved?.sku,
    mapping: mappingValues,
    brand,
    color,
    warranty: warrantyFallback,
    attributes,
    pricing,
    origin,
    quantity: qty,
  });

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await ElryanSyncOnePreview.create({
    tokenHash: hashToken(token),
    productId: String(doc._id),
    payloadHash: payloadHash(payload),
    readiness: validation.readiness,
    expiresAt,
  });

  await ElryanProductSyncState.findOneAndUpdate(
    { productId: String(doc._id) },
    {
      $set: {
        sku: resolved?.sku || "",
        lastReadiness: validation.readiness,
        lastPreviewAt: new Date(),
      },
    },
    { upsert: true }
  );

  return {
    ok: true,
    classification: "READ",
    productWritesEnabled: elryanProductWritesEnabled(),
    readiness: validation.readiness,
    blockers: validation.blockers,
    previewToken: token,
    expiresAt,
    product: {
      id: String(doc._id),
      sku: resolved?.sku || "",
      name: resolved?.name || {},
      description: resolved?.description || {},
      stock: qty,
      outOfStock: Boolean(resolved?.outOfStock),
      images,
    },
    mapping: {
      brownCollectionId: String(doc.collectionName?._id || doc.collectionName?.id || ""),
      categoryId: mappingValues.categoryId || "",
      categoryName: mappingValues.categoryName || "",
      categoryHierarchy: mappingValues.categoryHierarchy || "",
      attributeSetId: mappingValues.attributeSetId || "",
    },
    brand: brand
      ? { brownKey: brand.brownKey, elryanId: brand.elryanId, label: brand.elryanLabel || brand.brownLabel }
      : null,
    color: color
      ? { brownKey: color.brownKey, elryanId: color.elryanId, label: color.elryanLabel || color.brownLabel }
      : { brownKey: colourKey, elryanId: "", label: colourKey },
    warranty: warrantyFallback
      ? {
          brownKey: warrantyFallback.brownKey,
          elryanCode: warrantyFallback.elryanCode,
          label: warrantyFallback.elryanLabel,
        }
      : null,
    variation,
    pricing,
    attributeSet,
    requiredAttributeCodes,
    proposedPayload: payload,
    connection: {
      status: connection.status,
      environment: connection.environment,
      hasApiKey: connection.hasApiKey,
      accessLabel: connection.accessLabel,
    },
    sync: {
      enabled: false,
      reason: elryanProductWritesEnabled()
        ? "Write flag is on but send still requires explicit confirm and Elryan publishing grant review."
        : "Product publishing is disabled (ELRYAN_PRODUCT_WRITES_ENABLED is not true).",
    },
  };
}

/**
 * WRITE path — permanently blocked unless ELRYAN_PRODUCT_WRITES_ENABLED=true
 * and even then this phase keeps an explicit refuse until a future approved enablement.
 * For safety in this task: always refuse live POST/PATCH.
 */
export async function sendElryanSyncOne({ productId, confirm, previewToken } = {}) {
  if (!elryanProductWritesEnabled()) {
    return {
      ok: false,
      classification: "WRITE",
      blocked: true,
      code: "writes_disabled",
      readiness: ELRYAN_READINESS.NOT_READY,
      message:
        "Elryan product publishing is disabled. ELRYAN_PRODUCT_WRITES_ENABLED must remain false until Elryan grants access and a separate review enables it.",
    };
  }

  // Extra hard stop for this implementation phase — never issue write HTTP even if flag flipped accidentally during local testing without review.
  if (String(process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES || "").trim().toLowerCase() !== "true") {
    return {
      ok: false,
      classification: "WRITE",
      blocked: true,
      code: "writes_gated",
      message:
        "Live Elryan product writes require both ELRYAN_PRODUCT_WRITES_ENABLED=true and ELRYAN_ALLOW_LIVE_PRODUCT_WRITES=true after Elryan grants publishing. No product was sent.",
    };
  }

  if (confirm !== true) {
    return {
      ok: false,
      classification: "WRITE",
      blocked: true,
      code: "confirm_required",
      message: "Send requires explicit confirm=true after Preview.",
    };
  }

  // Structure reserved for a future approved enablement — still does not call write APIs here.
  void productId;
  void previewToken;
  void ELRYAN_PATHS;
  void elryanRequest;
  void ElryanClientError;

  return {
    ok: false,
    classification: "WRITE",
    blocked: true,
    code: "not_implemented_pending_elryan_grant",
    message:
      "Single-product sync structure is prepared but live POST/PATCH remains unimplemented until Elryan publishing access is granted and a reviewed enablement lands.",
  };
}

export function elryanBulkDesignNotes() {
  return {
    classification: "WRITE",
    enabled: false,
    endpoints: {
      create: ELRYAN_PATHS.batchCreate,
      update: ELRYAN_PATHS.batchUpdate,
      status: ELRYAN_PATHS.batchById("{id}"),
    },
    maxBatchSize: 2500,
    notes: [
      "Bulk create accepts JSON or multipart file; valid rows can succeed while invalid rows return problems.",
      "Bulk update matches by SKU; supervised/rejected products cannot be updated.",
      "costPrice alone recalculates sellingPrice from marketplace commission; sellingPrice alone recalculates cost.",
      "Do not execute bulk calls until Elryan grants publishing and a separate review enables writes.",
    ],
  };
}
