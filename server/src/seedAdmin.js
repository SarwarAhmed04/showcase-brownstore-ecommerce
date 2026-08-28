import bcrypt from "bcryptjs";
import { User } from "./models/User.js";

export async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "admin@brownstore.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "BrownStore!2026";
  const existing = await User.findOne({ email });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash, role: "admin" });
  console.log(`Seeded admin user: ${email}`);
  return user;
}
