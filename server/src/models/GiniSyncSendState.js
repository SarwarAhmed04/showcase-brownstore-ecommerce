import mongoose from "mongoose";

const giniSyncSendStateSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    productId: { type: String, required: true, unique: true },
    sku: { type: String, default: "" },
    skuKey: { type: String, required: true, unique: true },
    giniProductId: { type: String, required: true },
    payloadHash: { type: String, default: "" },
    jobId: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniSyncSendState = mongoose.model("GiniSyncSendState", giniSyncSendStateSchema);
