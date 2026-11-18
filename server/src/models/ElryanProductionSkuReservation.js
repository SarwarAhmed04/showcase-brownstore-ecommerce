import mongoose from "mongoose";

/**
 * One Production create reservation per normalized SKU on the Elryan Production account.
 * The unique key is enforced by the database so two server processes cannot both create it.
 */
const elryanProductionSkuReservationSchema = new mongoose.Schema(
  {
    accountKey: { type: String, required: true },
    sku: { type: String, required: true },
    productId: { type: String, default: "" },
    status: {
      type: String,
      required: true,
      enum: ["in_progress", "succeeded", "failed", "uncertain"],
    },
    elryanProductId: { type: String, default: "" },
    listingStatus: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

elryanProductionSkuReservationSchema.index({ accountKey: 1, sku: 1 }, { unique: true });

export const ElryanProductionSkuReservation = mongoose.model(
  "ElryanProductionSkuReservation",
  elryanProductionSkuReservationSchema
);
