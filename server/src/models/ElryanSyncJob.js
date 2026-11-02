import mongoose from "mongoose";

const elryanSyncJobSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging", "production"], index: true },
    origin: { type: String, default: "" },
    status: {
      type: String,
      enum: ["preview", "running", "paused", "stopped", "failed"],
      default: "running",
      index: true,
    },
    mode: { type: String, enum: ["preview"], default: "preview" },
    strategy: { type: String, enum: ["full", "changed"], default: "full" },
    batchSize: { type: Number, default: 25 },
    cursorProductId: { type: String, default: "" },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    ready: { type: Number, default: 0 },
    newCount: { type: Number, default: 0 },
    changedCount: { type: Number, default: 0 },
    unchangedCount: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    inactive: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    missingCategory: { type: Number, default: 0 },
    missingBrand: { type: Number, default: 0 },
    missingColor: { type: Number, default: 0 },
    warrantyUnverified: { type: Number, default: 0 },
    pricingUnverified: { type: Number, default: 0 },
    missingRequired: { type: Number, default: 0 },
    variationBlocked: { type: Number, default: 0 },
    sentToElryan: { type: Number, default: 0 },
    warrantySummary: { type: mongoose.Schema.Types.Mixed, default: null },
    pricingSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    packageDimensions: { type: mongoose.Schema.Types.Mixed, default: null },
    dimensionSummary: {
      productOverride: { type: Number, default: 0 },
      collectionAuto: { type: Number, default: 0 },
      suggested: { type: Number, default: 0 },
      missing: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
    },
    lastError: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

elryanSyncJobSchema.index({ environment: 1, createdAt: -1 });

export const ElryanSyncJob = mongoose.model("ElryanSyncJob", elryanSyncJobSchema);
