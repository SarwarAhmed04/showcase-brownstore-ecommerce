import mongoose from "mongoose";

const giniResyncAuditSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    jobId: { type: String, default: "" },
    productId: { type: String, default: "" },
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "", index: true },
    attempt: { type: Number, default: 1 },
    method: { type: String, default: "POST" },
    path: { type: String, default: "" },
    previousGiniProductId: { type: String, default: "" },
    responseGiniProductId: { type: String, default: "" },
    previousPayloadHash: { type: String, default: "" },
    nextPayloadHash: { type: String, default: "" },
    savedJobId: { type: String, default: "" },
    savedConfirmedAt: { type: Date, default: null },
    status: { type: String, default: "pending", index: true },
    requestSent: { type: Boolean, default: false },
    httpStatus: { type: Number, default: 0 },
    errorCode: { type: String, default: "", maxlength: 80 },
    errorMessage: { type: String, default: "", maxlength: 400 },
    reconcileHistory: { type: [String], default: () => [] },
  },
  { timestamps: true, collection: "giniresyncaudits", autoIndex: false, autoCreate: false }
);

giniResyncAuditSchema.index({ skuKey: 1, createdAt: -1 });

export const GiniResyncAudit = mongoose.model("GiniResyncAudit", giniResyncAuditSchema);
