import mongoose from "mongoose";

const giniVariantParentOwnerSchema = new mongoose.Schema(
  {
    skuKey: { type: String, required: true, unique: true },
    parentSku: { type: String, required: true },
    productId: { type: String, required: true },
    vendorId: { type: String, default: "" },
    giniProductId: { type: String, default: "" },
    parentQuantity: { type: Number, default: null },
    visibility: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvalNote: { type: String, default: "" },
    status: { type: String, required: true, enum: ["approved", "verified_remote"] },
  },
  { timestamps: true }
);

export const GiniVariantParentOwner = mongoose.model("GiniVariantParentOwner", giniVariantParentOwnerSchema);
