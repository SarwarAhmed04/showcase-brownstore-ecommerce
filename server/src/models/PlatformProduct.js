import mongoose from "mongoose";

const platformProductSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

platformProductSchema.index({ partner: 1, product: 1 }, { unique: true });

export const PlatformProduct = mongoose.model("PlatformProduct", platformProductSchema);
