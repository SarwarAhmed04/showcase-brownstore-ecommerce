import mongoose from "mongoose";

const giniUnifiedSyncJobSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    status: {
      type: String,
      enum: ["scanning", "preview", "running", "paused", "completed", "stopped", "failed"],
      default: "preview",
      index: true,
    },
    mode: { type: String, enum: ["preview", "sync"], default: "preview" },
    previewJobId: { type: String, default: "" },
    cursorProductId: { type: String, default: "" },
    scanned: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    create: { type: Number, default: 0 },
    update: { type: Number, default: 0 },
    unchanged: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    uncertain: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    writesEnabled: { type: Boolean, default: false },
    productionWritesEnabled: { type: Boolean, default: false },
    limitations: { type: [String], default: () => [] },
    lastError: { type: String, default: "" },
    errorCode: { type: String, default: "" },
  },
  { timestamps: true }
);

giniUnifiedSyncJobSchema.index({ partner: 1, createdAt: -1 });

export const GiniUnifiedSyncJob = mongoose.model("GiniUnifiedSyncJob", giniUnifiedSyncJobSchema);
