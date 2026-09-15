import mongoose from "mongoose";

const enquirySchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    subject: { type: String, default: "" },
    message: { type: String, default: "" },
    productId: { type: String, default: "" },
    productName: { type: String, default: "" },
    status: { type: String, default: "new" },
  },
  { timestamps: true }
);

enquirySchema.index({ createdAt: -1 });

export const Enquiry = mongoose.model("Enquiry", enquirySchema);
