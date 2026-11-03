import mongoose from "mongoose";

const giniProductUpdateLockSchema = new mongoose.Schema(
  {
    skuKey: { type: String, required: true, unique: true },
    jobId: { type: String, required: true },
  },
  { timestamps: true }
);

export const GiniProductUpdateLock = mongoose.model("GiniProductUpdateLock", giniProductUpdateLockSchema);
