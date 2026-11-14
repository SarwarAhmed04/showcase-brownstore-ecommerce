import mongoose from "mongoose";

const catalogSyncHoldSchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true, index: true },
    missingSyncs: { type: Number, required: true },
    firstMissingAt: { type: Date, required: true },
    lastMissingAt: { type: Date, required: true },
    lastRemoteTotal: { type: Number, default: 0 },
    lastLocalTotal: { type: Number, default: 0 },
    approvalState: { type: String, default: "quarantine" },
  },
  { timestamps: false }
);

export const CatalogSyncHold = mongoose.models.CatalogSyncHold
  || mongoose.model("CatalogSyncHold", catalogSyncHoldSchema);
