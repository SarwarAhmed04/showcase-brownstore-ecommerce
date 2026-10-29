import mongoose from "mongoose";

/**
 * Brand maps for Miswag only (isolated from Elryan/GINI).
 * kind "color" may still exist historically; color mapping is no longer used —
 * Miswag payloads send original BrownStore color names without HEX.
 * Manual brand rows are never overwritten by automatic matching.
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
