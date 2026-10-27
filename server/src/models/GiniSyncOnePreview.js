import mongoose from "mongoose";

const giniSyncOnePreviewSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    productId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniSyncOnePreview = mongoose.model("GiniSyncOnePreview", giniSyncOnePreviewSchema);
