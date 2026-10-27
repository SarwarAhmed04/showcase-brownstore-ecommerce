import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.Mixed, required: true },
    name: { type: String, default: "" },
    parentId: { type: mongoose.Schema.Types.Mixed, default: null },
    isParent: { type: Boolean, default: null },
    level: { type: Number, default: null },
    attributeSet: { type: String, default: "" },
    attributeSetId: { type: mongoose.Schema.Types.Mixed, default: null },
    hierarchy: { type: String, default: "" },
  },
  { _id: false }
);

const elryanCategoryCatalogSnapshotSchema = new mongoose.Schema(
  {
    /** Phase 3: staging-only snapshots (production forbidden). */
    environment: { type: String, required: true, enum: ["staging"], unique: true },
    status: {
      type: String,
      default: "idle",
      enum: ["idle", "running", "complete", "failed", "cancelled", "incomplete"],
    },
    categories: { type: [categorySchema], default: [] },
    uniqueCount: { type: Number, default: 0 },
    reportedTotal: { type: Number, default: null },
    pagesFetched: { type: Number, default: 0 },
    lastPage: { type: Number, default: null },
    warnings: { type: [String], default: [] },
    error: { type: String, default: "" },
    coverage: {
      type: String,
      default: "unknown",
      enum: ["unknown", "complete", "partial", "unreliable_meta"],
    },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cancelRequested: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ElryanCategoryCatalogSnapshot = mongoose.model(
  "ElryanCategoryCatalogSnapshot",
  elryanCategoryCatalogSnapshotSchema
);
