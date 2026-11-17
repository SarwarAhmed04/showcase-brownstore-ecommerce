import mongoose from "mongoose";

const elryanSyncOnePreviewSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    productId: { type: String, required: true, index: true },
    payloadHash: { type: String, required: true },
    purpose: { type: String, default: "sync_one" },
    listingId: { type: String, default: "" },
    bindingHash: { type: String, default: "" },
    readiness: { type: String, default: "NOT_READY" },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ElryanSyncOnePreview = mongoose.model("ElryanSyncOnePreview", elryanSyncOnePreviewSchema);
