import bcrypt from "bcryptjs";
import { User } from "./models/User.js";
import { primaryAdminEmail } from "./utils/adminUser.js";

async function ensureAdmin(email, password) {
  const normalized = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalized });
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email: normalized, passwordHash, role: "admin" });
  console.log(`Seeded admin user: ${normalized}`);
  return user;
}

export async function seedAdmin() {
  await ensureAdmin(
    primaryAdminEmail(),
    process.env.ADMIN_PASSWORD || "karim0fadmin"
  );
  const extra = "admin@brownstore.com";
  if (extra !== primaryAdminEmail()) {
    await ensureAdmin(extra, "BrownStore!2026");
  }
}
