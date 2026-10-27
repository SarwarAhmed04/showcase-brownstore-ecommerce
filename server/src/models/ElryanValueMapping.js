import mongoose from "mongoose";

/** Brand / colour / warranty maps for Elryan only (isolated from Miswag/GINI). */
const elryanValueMappingSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ["brand", "color", "warranty"],
      index: true,
    },
    /** BrownStore brand._id, colour key, or warranty key. */
    brownKey: { type: String, required: true },
    brownLabel: { type: String, default: "" },
    elryanId: { type: String, default: "" },
    elryanCode: { type: String, default: "" },
    elryanLabel: { type: String, default: "" },
  },
  { timestamps: true }
);

elryanValueMappingSchema.index({ kind: 1, brownKey: 1 }, { unique: true });

export const ElryanValueMapping = mongoose.model("ElryanValueMapping", elryanValueMappingSchema);
