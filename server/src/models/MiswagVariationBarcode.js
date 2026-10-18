import mongoose from "mongoose";

/**
 * Stable Miswag variation barcodes for Sync 1 Product / future Miswag sync.
 * One barcode per variation (not per size). Unique per partner.
 */
const miswagVariationBarcodeSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "miswag", index: true },
    variationExternalId: { type: String, required: true },
    variantId: { type: String, required: true },
    ibsherId: { type: String, default: "", index: true },
    barcode: { type: String, required: true },
    source: { type: String, enum: ["generated", "explicit"], default: "generated" },
  },
  { timestamps: true }
);

miswagVariationBarcodeSchema.index({ partner: 1, variationExternalId: 1 }, { unique: true });
miswagVariationBarcodeSchema.index({ partner: 1, barcode: 1 }, { unique: true });

export const MiswagVariationBarcode = mongoose.model("MiswagVariationBarcode", miswagVariationBarcodeSchema);
