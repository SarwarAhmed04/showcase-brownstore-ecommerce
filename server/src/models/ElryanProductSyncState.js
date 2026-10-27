import mongoose from "mongoose";

/** Placeholder sync ledger — not populated by live writes in this phase. */
const elryanProductSyncStateSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, unique: true, index: true },
    sku: { type: String, default: "", index: true },
    elryanProductId: { type: String, default: "" },
    lastReadiness: { type: String, default: "" },
    lastPreviewAt: { type: Date, default: null },
    lastSyncAttemptAt: { type: Date, default: null },
    lastSyncStatus: { type: String, default: "never" },
    lastError: { type: String, default: "" },
    approvalStatus: { type: String, default: "" },
  },
  { timestamps: true }
);

export const ElryanProductSyncState = mongoose.model(
  "ElryanProductSyncState",
  elryanProductSyncStateSchema
);
