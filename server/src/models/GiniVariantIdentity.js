import mongoose from "mongoose";

const giniVariantIdentitySchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, index: true },
    ibsherId: { type: String, default: "" },
    vendorId: { type: String, default: "" },
    parentSku: { type: String, required: true },
    parentSkuKey: { type: String, required: true, index: true },
    sourceVariantId: { type: String, required: true },
    sourceSizeId: { type: String, default: "" },
    proposedSku: { type: String, default: "" },
    proposedSkuKey: { type: String, default: "" },
    approvedSku: { type: String, default: "" },
    approvedSkuKey: { type: String, default: "" },
    confirmedGiniVariantId: { type: String, default: "" },
    attributeId: { type: String, default: "" },
    attributeName: { type: String, default: "" },
    attributeValue: { type: String, default: "" },
    lastVerifiedQuantity: { type: Number, default: null },
    lastVerifiedPrice: { type: Number, default: null },
    lastVerifiedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvalNote: { type: String, default: "" },
    status: { type: String, default: "proposed", enum: ["proposed", "approved", "verified", "conflict"] },
  },
  { timestamps: true }
);

giniVariantIdentitySchema.index({ productId: 1, sourceVariantId: 1, sourceSizeId: 1 }, { unique: true });
giniVariantIdentitySchema.index({ approvedSkuKey: 1 }, { unique: true, partialFilterExpression: { approvedSkuKey: { $gt: "" } } });
giniVariantIdentitySchema.index(
  { confirmedGiniVariantId: 1 },
  { unique: true, partialFilterExpression: { confirmedGiniVariantId: { $gt: "" } } }
);

export const GiniVariantIdentity = mongoose.model("GiniVariantIdentity", giniVariantIdentitySchema);
