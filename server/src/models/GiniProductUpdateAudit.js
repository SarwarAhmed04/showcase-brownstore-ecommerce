import mongoose from "mongoose";

const giniProductUpdateAuditSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    jobId: { type: String, default: "" },
    productId: { type: String, default: "" },
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "", index: true },
    giniProductId: { type: String, default: "" },
    createJobId: { type: String, default: "" },
    kind: { type: String, default: "json_put" },
    method: { type: String, default: "PUT" },
    path: { type: String, default: "" },
    contentType: { type: String, default: "application/json" },
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    changes: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    previousPayloadHash: { type: String, default: "" },
    nextPayloadHash: { type: String, default: "" },
    confirmsPayloadHash: { type: Boolean, default: true },
    status: { type: String, default: "pending", index: true },
    requestSent: { type: Boolean, default: false },
    httpStatus: { type: Number, default: 0 },
    errorCode: { type: String, default: "", maxlength: 80 },
    errorMessage: { type: String, default: "", maxlength: 400 },
    requestId: { type: String, default: "", maxlength: 64 },
    retryAfter: { type: Number, default: null },
    retryUntil: { type: Date, default: null },
    responseGiniProductId: { type: String, default: "" },
    responseSku: { type: String, default: "" },
    deleteImageUrl: { type: String, default: "" },
    replacementImageUrl: { type: String, default: "" },
    previousRemoteImages: { type: [String], default: () => [] },
    reconcileReads: { type: Number, default: 0 },
    reconcileHistory: { type: [String], default: () => [] },
    lastReconcileState: { type: String, default: "" },
  },
  { timestamps: true }
);

giniProductUpdateAuditSchema.index({ skuKey: 1, createdAt: -1 });

export const GiniProductUpdateAudit = mongoose.model("GiniProductUpdateAudit", giniProductUpdateAuditSchema);
