import mongoose from "mongoose";

/**
 * Brand and color maps for Miswag only (isolated from Elryan/GINI).
 * Color rows store a verified HEX. The original BrownStore color name is never
 * replaced by that HEX. Manual rows are never overwritten by automatic matching.
 */
const miswagValueMappingSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ["brand", "color"],
      index: true,
    },
    /** BrownStore brand._id or normalized English color name. */
    brownKey: { type: String, required: true },
    brownLabel: { type: String, default: "" },
    /** Miswag brand id (numeric string). Empty for color rows. */
    miswagId: { type: String, default: "" },
    miswagLabel: { type: String, default: "" },
    /** Verified HEX for color rows (#RRGGBB). */
    hex: { type: String, default: "" },
    mode: {
      type: String,
      enum: ["manual", "auto"],
      default: "manual",
      index: true,
    },
  },
  { timestamps: true }
);

miswagValueMappingSchema.index({ kind: 1, brownKey: 1 }, { unique: true });

export const MiswagValueMapping = mongoose.model("MiswagValueMapping", miswagValueMappingSchema);
