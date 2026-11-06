import mongoose from "mongoose";

const giniResyncLockSchema = new mongoose.Schema(
  {
    skuKey: { type: String, required: true, unique: true },
    jobId: { type: String, required: true },
  },
  { timestamps: true, collection: "giniresynclocks", autoIndex: false, autoCreate: false }
);

export const GiniResyncLock = mongoose.model("GiniResyncLock", giniResyncLockSchema);
