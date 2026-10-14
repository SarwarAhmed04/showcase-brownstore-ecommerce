import mongoose from "mongoose";

const platformBrandMappingSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    normalizedName: { type: String, required: true },
    brownBrandId: { type: String, default: "" },
    externalBrandId: { type: Number, default: null },
    externalName: { type: String, default: "" },
    externalAlias: { type: String, default: "" },
    status: { type: String, enum: ["mapped", "unmapped"], default: "unmapped", index: true },
    lastCheckedAt: { type: Date },
  },
  { timestamps: true }
);

platformBrandMappingSchema.index({ partner: 1, normalizedName: 1 }, { unique: true });

export const PlatformBrandMapping = mongoose.model("PlatformBrandMapping", platformBrandMappingSchema);
