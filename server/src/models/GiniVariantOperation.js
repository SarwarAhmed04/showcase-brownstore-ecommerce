import mongoose from "mongoose";

const giniVariantOperationSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, unique: true },
    parentSku: { type: String, required: true },
    skuKey: { type: String, required: true, index: true },
    stage: { type: String, default: "idle" },
    status: {
      type: String,
      required: true,
      enum: ["idle", "parent_in_progress", "parent_uncertain", "parent_verified", "variants_in_progress", "variants_uncertain", "variants_verified", "stopped"],
    },
    lastCode: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    parentQuantity: { type: Number, default: null },
    parentVisibility: { type: String, default: "" },
    giniProductId: { type: String, default: "" },
  },
  { timestamps: true }
);

export const GiniVariantOperation = mongoose.model("GiniVariantOperation", giniVariantOperationSchema);
