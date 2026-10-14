import mongoose from "mongoose";

const miswagVariationBarcodeSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "miswag" },
    variationExternalId: { type: String, required: true },
    variantId: { type: String, required: true },
    ibsherId: { type: String, default: "", index: true },
    barcode: { type: String, required: true },
    source: { type: String, enum: ["generated", "explicit", "legacy"], default: "generated" },
  },
  { timestamps: true }
);

miswagVariationBarcodeSchema.index({ partner: 1, variationExternalId: 1 }, { unique: true });
miswagVariationBarcodeSchema.index({ partner: 1, barcode: 1 }, { unique: true });
miswagVariationBarcodeSchema.index({ partner: 1, ibsherId: 1 });

export const MiswagVariationBarcode = mongoose.model("MiswagVariationBarcode", miswagVariationBarcodeSchema);
