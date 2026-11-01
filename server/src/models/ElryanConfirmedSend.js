import mongoose from "mongoose";

/**
 * Written only after a real successful Elryan product send.
 * Preview jobs must not insert rows here. An empty ledger means the product was never sent.
 */
const elryanConfirmedSendSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging", "production"] },
    productId: { type: String, required: true },
    sku: { type: String, default: "" },
    payloadHash: { type: String, required: true },
    elryanProductId: { type: String, default: "" },
    httpStatus: { type: Number, required: true },
    published: { type: Boolean, default: false },
    confirmedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

elryanConfirmedSendSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanConfirmedSend = mongoose.model("ElryanConfirmedSend", elryanConfirmedSendSchema);
