import mongoose from "mongoose";

const giniResyncJobSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    status: { type: String, default: "running", index: true },
    previewId: { type: String, default: "" },
    previewSignature: { type: String, default: "" },
    scope: { type: String, default: "" },
    expectedCount: { type: Number, default: 0 },
    skus: { type: [String], default: () => [] },
    requestSent: { type: Boolean, default: false },
    sentToGini: { type: Number, default: 0 },
    results: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "giniresyncjobs", autoIndex: false, autoCreate: false }
);

export const GiniResyncJob = mongoose.model("GiniResyncJob", giniResyncJobSchema);
