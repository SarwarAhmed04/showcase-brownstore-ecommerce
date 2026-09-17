import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { AUTH_COOKIE } from "../utils/authCookie.js";

function readToken(req) {
  const cookieToken = String(req.cookies?.[AUTH_COOKIE] || "").trim();
  if (cookieToken) return cookieToken;
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function requireAdmin(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user || user.role !== "admin") {
      return res.status(401).json({ message: "Unauthorized" });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
