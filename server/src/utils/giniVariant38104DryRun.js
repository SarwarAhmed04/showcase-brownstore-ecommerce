import { classifyVariantProduct, giniVariantSyncWritesEnabled } from "./giniVariantCatalog.js";
import { buildReusableVariantFields, buildVariantParentPreview } from "./giniVariantPayload.js";
import { giniCatalogText } from "./giniSyncOnePlan.js";

export const IT_LOBBY_38104_PRODUCT_ID = "6adf9ca49dedbaa3dd573cce";

/** Local stand-in for the confirmed production shape. Prices, stock, and image paths are fixture values. */
export const IT_LOBBY_38104_FIXTURE = Object.freeze({
  productId: IT_LOBBY_38104_PRODUCT_ID,
  vendor: "IT Lobby",
  parentSku: "38104",
  categoryId: "3",
  subcategoryId: "3",
  colorContract: Object.freeze({ attributeId: "3696", name: "Color", values: Object.freeze(["Black", "Blue"]) }),
  doc: Object.freeze({
    _id: IT_LOBBY_38104_PRODUCT_ID,
    itemCode: "38104",
    name: { en: "IT Lobby 38104", ar: "اي تي لوبي 38104" },
    description: { ar: "Local dry-run fixture" },
    brand: { name: "IT Lobby" },
    createdBy: { _id: "it-lobby", name: "IT Lobby" },
    variants: Object.freeze([
      Object.freeze({
        _id: "v-black",
        color: { en: "Black" },
        images: Object.freeze([Object.freeze({ url: "/fixtures/38104-black.webp", isMain: true })]),
        sizes: Object.freeze([Object.freeze({ _id: "s-black", size: "One", stockQuantity: 4, price: 1000 })]),
      }),
      Object.freeze({
        _id: "v-blue",
        color: { en: "Blue" },
        images: Object.freeze([Object.freeze({ url: "/fixtures/38104-blue.webp", isMain: true })]),
        sizes: Object.freeze([Object.freeze({ _id: "s-blue", size: "One", stockQuantity: 3, price: 1000 })]),
      }),
    ]),
  }),
});

export const IT_LOBBY_38104_ABSENT_LOOKUP = Object.freeze({
  parent: "absent",
  "38104-BLACK": "absent",
  "38104-BLUE": "absent",
});

const APPROVED_IDENTITIES = Object.freeze([
  Object.freeze({ sourceVariantId: "v-black", sourceSizeId: "s-black", approvedSku: "38104-BLACK", status: "approved" }),
  Object.freeze({ sourceVariantId: "v-blue", sourceSizeId: "s-blue", approvedSku: "38104-BLUE", status: "approved" }),
]);

function imageUrl(variant) {
  const images = Array.isArray(variant?.images) ? variant.images : [];
  const main = images.find((image) => image?.isMain && image?.url) || images.find((image) => image?.url);
  return main?.url || "";
}

export function classifyItLobby38104(fixture = IT_LOBBY_38104_FIXTURE) {
  return classifyVariantProduct({
    doc: fixture.doc,
    giniPrice: 1000,
    mappingOk: true,
    categoryId: fixture.categoryId,
    subcategoryId: fixture.subcategoryId,
    ownerIds: [fixture.productId, "6ae08bbd9dedbaa3dd5740d9"],
    canonicalOwnerId: fixture.productId,
    identities: APPROVED_IDENTITIES,
    colorContract: fixture.colorContract,
  });
}

export function previewItLobby38104(fixture = IT_LOBBY_38104_FIXTURE) {
  const row = classifyItLobby38104(fixture);
  const imagesByVariant = new Map((fixture.doc.variants || []).map((variant) => [String(variant._id), imageUrl(variant)]));
  const children = (row.combinations || []).map((combo) => ({
    sku: combo.proposedSku,
    categoryId: row.categoryId,
    subcategoryId: row.subcategoryId,
    color: combo.color,
    attributeId: combo.attributeId,
    attributeName: combo.attributeName,
    price: combo.price,
    stock: combo.stock,
    image: imagesByVariant.get(combo.sourceVariantId) || "",
  }));
  const parent = buildVariantParentPreview({
    text: giniCatalogText(fixture.doc),
    sku: row.parentSku,
    price: children[0]?.price,
    category: { id: row.categoryId },
    subcategory: { id: row.subcategoryId },
    imageUrls: children.map((child) => child.image).filter(Boolean),
  });
  const variants = buildReusableVariantFields(children.map((child) => ({
    sku: child.sku,
    price: child.price,
    stock: child.stock,
    attributeId: child.attributeId,
    value: child.color,
    imageUrl: child.image,
  })));
  return {
    productId: row.productId,
    vendor: row.vendor,
    status: row.status,
    intendedAction: row.intendedAction,
    parent,
    children,
    variants,
  };
}

export function createPlanForParentLookup(lookup = "absent") {
  const state = String(lookup || "").trim().toLowerCase();
  if (state === "absent") {
    return { lookup: "absent", blocked: false, willCreate: true, code: "parent_absent", sentToGini: 0, canSend: false };
  }
  if (state === "present" || state === "exists") {
    return { lookup: "present", blocked: true, willCreate: false, code: "parent_already_exists", sentToGini: 0, canSend: false };
  }
  return { lookup: "uncertain", blocked: true, willCreate: false, code: "parent_lookup_uncertain", sentToGini: 0, canSend: false };
}

export function dryRunItLobby38104({ lookup = IT_LOBBY_38104_ABSENT_LOOKUP, env = process.env } = {}) {
  const preview = previewItLobby38104();
  const parentLookup = typeof lookup === "string" ? lookup : lookup?.parent;
  return {
    dryRun: true,
    sentToGini: 0,
    canSend: false,
    writesEnabled: giniVariantSyncWritesEnabled(env),
    productId: preview.productId,
    vendor: preview.vendor,
    status: preview.status,
    intendedAction: preview.intendedAction,
    parent: {
      sku: preview.parent.sku,
      categoryId: preview.parent.category_id,
      subcategoryId: preview.parent.subcategory_id,
      price: preview.parent.price,
      quantity: preview.parent.quantity,
      isVisible: preview.parent.is_visible,
      images: (preview.parent.images || []).map((image) => image.url),
    },
    children: preview.children,
    createPlan: createPlanForParentLookup(parentLookup),
  };
}
