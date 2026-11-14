import mongoose from "mongoose";

const categorySyncHoldSchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true, index: true },
    missingSyncs: { type: Number, required: true },
    firstMissingAt: { type: Date, required: true },
    lastMissingAt: { type: Date, required: true },
    lastRemoteTotal: { type: Number, default: 0 },
    lastLocalTotal: { type: Number, default: 0 },
    approvalState: { type: String, default: "quarantine" },
  },
  { timestamps: false, autoIndex: false, autoCreate: false }
);

export const CategorySyncHold = mongoose.models.CategorySyncHold
  || mongoose.model("CategorySyncHold", categorySyncHoldSchema);
