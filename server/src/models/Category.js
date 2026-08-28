import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true },
    name: { en: String, ar: String, ku: String },
    images: { type: Array, default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Category = mongoose.model("Category", categorySchema);
