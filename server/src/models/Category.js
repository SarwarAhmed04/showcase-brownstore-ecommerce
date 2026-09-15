import mongoose from "mongoose";

const localized = { en: String, ar: String, ku: String };

const categorySchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true },
    name: localized,
    images: { type: Array, default: [] },
    isActive: { type: Boolean, default: true },
    overrides: {
      name: {
        ku: { type: String, default: "" },
        en: { type: String, default: "" },
        ar: { type: String, default: "" },
      },
      image: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

export const Category = mongoose.model("Category", categorySchema);
