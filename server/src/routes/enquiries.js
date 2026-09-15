import { Router } from "express";
import { Enquiry } from "../models/Enquiry.js";
import { logActivity } from "../utils/activity.js";

export const enquiriesRouter = Router();

enquiriesRouter.post("/", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const message = String(req.body?.message || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const productName = String(req.body?.productName || "").trim();

    const details = [];
    if (name.length < 2) details.push({ field: "name", message: "Tell us your name." });
    if (!/^\S+@\S+\.\S+$/.test(email)) details.push({ field: "email", message: "That address does not look right." });
    if (message.length < 5) details.push({ field: "message", message: "Add a little more detail." });
    if (details.length) {
      return res.status(400).json({ message: "Check the highlighted fields.", details });
    }

    const enquiry = await Enquiry.create({
      name,
      email,
      message,
      subject,
      productId,
      productName,
    });

    await logActivity(
      { user: { email: email.toLowerCase() } },
      "enquiry.create",
      {
        name,
        email,
        subject,
        productId,
        productName,
        enquiryId: enquiry._id.toString(),
      }
    );

    res.status(201).json({ ok: true, id: enquiry._id.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not send that just now." });
  }
});
