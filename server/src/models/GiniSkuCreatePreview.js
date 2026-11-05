import mongoose from "mongoose";

const giniSkuCreatePreviewSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    productId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    skuKey: { type: String, required: true },
    payloadHash: { type: String, required: true },
    merchantHost: { type: String, required: true },
    clientMask: { type: String, required: true },
    productCount: { type: Number, required: true, default: 1 },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniSkuCreatePreview = mongoose.model("GiniSkuCreatePreview", giniSkuCreatePreviewSchema);
