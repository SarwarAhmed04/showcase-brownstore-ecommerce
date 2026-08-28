import mongoose from "mongoose";

const localized = { en: String, ar: String, ku: String };

const productSchema = new mongoose.Schema(
  {
    ibsherId: { type: String, required: true, unique: true, index: true },
    name: localized,
    description: localized,
    itemCode: { type: String, default: "", index: true },
    price: { type: Number, default: 0 },
    discountPrice: { type: Number, default: 0 },
    variants: { type: Array, default: [] },
    category: { type: mongoose.Schema.Types.Mixed },
    subCategory: { type: mongoose.Schema.Types.Mixed },
    collectionName: { type: mongoose.Schema.Types.Mixed },
    brand: { type: mongoose.Schema.Types.Mixed },
    status: String,
    warranty: mongoose.Schema.Types.Mixed,
    keyword: [String],
    is_featured: { type: Boolean, default: false },
    is_new_arrival: { type: Boolean, default: false },
    is_hot: { type: Boolean, default: false },
    is_best_seller: { type: Boolean, default: false },
    badge: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    rating: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    cashback: { type: Number, default: 0 },
    createdBy: mongoose.Schema.Types.Mixed,
    sourceUpdatedAt: Date,
    overrides: {
      sku: { type: String, default: null },
      price: { type: Number, default: null },
      stock: { type: Number, default: null },
    },
    lastSyncedAt: Date,
  },
  { timestamps: true }
);

productSchema.index({ "category._id": 1 });
productSchema.index({ isActive: 1, status: 1 });

export const Product = mongoose.model("Product", productSchema);
