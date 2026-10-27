import mongoose from "mongoose";

/**
 * Global catalog blocks — hide products from BrownStore storefront and every platform.
 * - vendor-wide: brandId is ""
 * - vendor + brand: brandId set
 */
const catalogBlockSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true },
    brandId: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

catalogBlockSchema.index({ vendorId: 1, brandId: 1 }, { unique: true });
catalogBlockSchema.index({ vendorId: 1 });

export const CatalogBlock = mongoose.model("CatalogBlock", catalogBlockSchema);
