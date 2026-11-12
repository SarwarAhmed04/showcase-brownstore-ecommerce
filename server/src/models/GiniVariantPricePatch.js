import mongoose from "mongoose";

const giniVariantPricePatchSchema = new mongoose.Schema(
  {
    operationKey: { type: String, required: true, unique: true },
    parentSku: { type: String, required: true },
    variantId: { type: String, required: true },
    variantSku: { type: String, default: "" },
    stage: { type: String, enum: ["blue", "black", "purple"], required: true },
    status: {
      type: String,
      required: true,
      enum: ["idle", "baseline_blocked", "in_progress", "uncertain", "rejected", "verified"],
    },
    rawBody: { type: String, default: "" },
    lastCode: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniVariantPricePatch = mongoose.model("GiniVariantPricePatch", giniVariantPricePatchSchema);
