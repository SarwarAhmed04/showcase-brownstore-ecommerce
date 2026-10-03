import mongoose from "mongoose";

const localized = { en: String, ar: String, ku: String };

const categorySchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true },
    name: localized,
    images: { type: Array, default: [] },
    isActive: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
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

categorySchema.index({ displayOrder: 1, createdAt: 1 });

export const categoryListSort = { displayOrder: 1, createdAt: 1 };

export const Category = mongoose.model("Category", categorySchema);
