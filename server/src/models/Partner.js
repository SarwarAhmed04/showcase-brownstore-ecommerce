import mongoose from "mongoose";

export const PARTNER_DEFS = [
  { slug: "miswag", name: "Miswag", image: "/partners/miswag.png" },
  { slug: "gini", name: "Gini", image: "/partners/gini.png" },
  { slug: "elryan", name: "Elryan", image: "/partners/elryan.png" },
];

export const PARTNER_SLUGS = PARTNER_DEFS.map((item) => item.slug);

const partnerSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    image: { type: String, default: "" },
    apiKeyHash: { type: String, default: "" },
    apiKeyPrefix: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Partner = mongoose.model("Partner", partnerSchema);
