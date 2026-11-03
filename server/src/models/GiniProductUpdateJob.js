import mongoose from "mongoose";

const giniProductUpdateJobSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    kind: { type: String, default: "json_put" },
    status: { type: String, default: "running", index: true },
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "" },
    productId: { type: String, default: "" },
    giniProductId: { type: String, default: "" },
    previewId: { type: String, default: "" },
    previewSignature: { type: String, default: "" },
    expectedChanges: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    requestSent: { type: Boolean, default: false },
    sentToGini: { type: Number, default: 0 },
    httpStatus: { type: Number, default: 0 },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniProductUpdateJob = mongoose.model("GiniProductUpdateJob", giniProductUpdateJobSchema);
