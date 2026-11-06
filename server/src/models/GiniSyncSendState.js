import mongoose from "mongoose";

const resyncEventSchema = new mongoose.Schema(
  {
    previousGiniProductId: { type: String, default: "" },
    newGiniProductId: { type: String, default: "" },
    previousPayloadHash: { type: String, default: "" },
    payloadHash: { type: String, default: "" },
    auditId: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
  },
  { _id: false }
);

const giniSyncSendStateSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    productId: { type: String, required: true, unique: true },
    sku: { type: String, default: "" },
    skuKey: { type: String, required: true, unique: true },
    giniProductId: { type: String, required: true },
    originalGiniProductId: { type: String, default: "" },
    payloadHash: { type: String, default: "" },
    createPayloadHash: { type: String, default: "" },
    jobId: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
    lastUpdateConfirmedAt: { type: Date, default: null },
    lastUpdateAuditId: { type: String, default: "" },
    lastResyncConfirmedAt: { type: Date, default: null },
    lastResyncAuditId: { type: String, default: "" },
    resyncHistory: { type: [resyncEventSchema], default: () => [] },
  },
  { timestamps: true }
);

export const GiniSyncSendState = mongoose.model("GiniSyncSendState", giniSyncSendStateSchema);
