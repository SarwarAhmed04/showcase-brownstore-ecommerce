import mongoose from "mongoose";

const giniSkuCreateAttemptSchema = new mongoose.Schema(
  {
    skuKey: { type: String, required: true, unique: true },
    productId: { type: String, required: true, unique: true },
    sku: { type: String, required: true },
    status: { type: String, required: true, enum: ["in_progress", "uncertain", "confirmed"] },
    giniProductId: { type: String, default: "" },
    previewToken: { type: String, default: "" },
    payloadHash: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    errorCode: { type: String, default: "" },
  },
  { timestamps: true }
);

export const GiniSkuCreateAttempt = mongoose.model("GiniSkuCreateAttempt", giniSkuCreateAttemptSchema);
