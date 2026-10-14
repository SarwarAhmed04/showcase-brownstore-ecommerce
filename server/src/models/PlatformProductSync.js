import mongoose from "mongoose";

export const SYNC_STATUSES = ["pending", "synced", "failed", "skipped", "processing"];

const platformProductSyncSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    externalId: { type: String, default: "" },
    externalProductId: { type: String, default: "" },
    status: { type: String, enum: SYNC_STATUSES, default: "pending", index: true },
    lastSyncedAt: { type: Date },
    lastSuccessfulSyncAt: { type: Date },
    lastError: { type: String, default: "" },
    payloadHash: { type: String, default: "" },
    lastSyncedPrice: { type: Number, default: null },
    priceSyncError: { type: String, default: "" },
    asyncJobId: { type: String, default: "" },
    asyncJobStatus: { type: String, default: "" },
    publishedAt: { type: Date },
    publishError: { type: String, default: "" },
  },
  { timestamps: true }
);

platformProductSyncSchema.index({ partner: 1, product: 1 }, { unique: true });
platformProductSyncSchema.index({ partner: 1, status: 1 });
platformProductSyncSchema.index({ partner: 1, asyncJobId: 1 });

export const PlatformProductSync = mongoose.model("PlatformProductSync", platformProductSyncSchema);
