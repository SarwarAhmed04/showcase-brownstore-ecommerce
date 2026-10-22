import mongoose from "mongoose";

const miswagProductSyncStateSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "miswag" },
    productId: { type: String, default: "" },
    ibsherId: { type: String, default: "" },
    externalId: { type: String, required: true },
    lastPayloadHash: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
    lastHttpStatus: { type: Number, default: 0 },
    miswagProductId: { type: String, default: "" },
    hashVersion: { type: Number, default: 1 },
  },
  { collection: "miswagproductsyncstates" }
);

miswagProductSyncStateSchema.index({ partner: 1, externalId: 1 }, { unique: true });

export const MiswagProductSyncState =
  mongoose.models.MiswagProductSyncState ||
  mongoose.model("MiswagProductSyncState", miswagProductSyncStateSchema);
