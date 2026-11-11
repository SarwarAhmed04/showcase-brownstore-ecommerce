import mongoose from "mongoose";

const giniVariantChangedOperationSchema = new mongoose.Schema(
  {
    operationKey: { type: String, required: true, unique: true },
    productId: { type: String, required: true, index: true },
    parentSku: { type: String, required: true },
    variantId: { type: String, required: true },
    variantSku: { type: String, default: "" },
    status: {
      type: String,
      required: true,
      enum: ["idle", "pending_approval", "approved", "in_progress", "uncertain", "rejected", "verified", "conflict"],
    },
    baselinePrice: { type: Number, default: null },
    baselineQuantity: { type: Number, default: null },
    proposedPrice: { type: Number, default: null },
    proposedQuantity: { type: Number, default: null },
    rawBody: { type: String, default: "" },
    baselineKey: { type: String, default: "" },
    lastCode: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const GiniVariantChangedOperation = mongoose.model("GiniVariantChangedOperation", giniVariantChangedOperationSchema);
