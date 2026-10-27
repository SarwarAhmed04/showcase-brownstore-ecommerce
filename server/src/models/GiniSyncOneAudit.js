import mongoose from "mongoose";

const giniSyncOneAuditSchema = new mongoose.Schema(
  {
    partner: { type: String, default: "gini" },
    productId: { type: String, default: "" },
    sku: { type: String, default: "" },
    action: { type: String, default: "" },
    success: { type: Boolean, default: false },
    httpStatus: { type: Number, default: 0 },
    giniProductId: { type: String, default: "" },
    errorCode: { type: String, default: "", maxlength: 80 },
    errorMessage: { type: String, default: "", maxlength: 400 },
    responseContentType: { type: String, default: "", maxlength: 120 },
    requestId: { type: String, default: "", maxlength: 64 },
    edgeBlocked: { type: Boolean, default: false },
    responseSnippet: { type: String, default: "", maxlength: 400 },
  },
  { timestamps: true }
);

export const GiniSyncOneAudit = mongoose.model("GiniSyncOneAudit", giniSyncOneAuditSchema);
