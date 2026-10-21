import mongoose from "mongoose";

const miswagSyncJobSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "miswag", index: true },
    status: {
      type: String,
      enum: ["preview", "running", "paused", "completed", "stopped", "auth_failed", "failed"],
      default: "preview",
      index: true,
    },
    mode: { type: String, enum: ["preview", "sync"], default: "preview" },
    batchSize: { type: Number, default: 15 },
    cursorIbsherId: { type: String, default: "" },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    inactive: { type: Number, default: 0 },
    ready: { type: Number, default: 0 },
    missingCategory: { type: Number, default: 0 },
    missingBrand: { type: Number, default: 0 },
    missingColor: { type: Number, default: 0 },
    missingImage: { type: Number, default: 0 },
    missingData: { type: Number, default: 0 },
    otherBlocked: { type: Number, default: 0 },
    categoryResolved: { type: Number, default: 0 },
    categoryAttempted: { type: Number, default: 0 },
    brandResolved: { type: Number, default: 0 },
    brandAttempted: { type: Number, default: 0 },
    failureSummary: { type: String, default: "" },
    lastError: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

miswagSyncJobSchema.index({ partner: 1, createdAt: -1 });

export const MiswagSyncJob = mongoose.model("MiswagSyncJob", miswagSyncJobSchema);
