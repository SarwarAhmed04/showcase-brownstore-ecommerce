import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { productsRouter } from "./routes/products.js";
import { categoriesRouter } from "./routes/categories.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter, syncFromIbsher } from "./routes/admin.js";
import { partnersRouter } from "./routes/partners.js";
import { enquiriesRouter } from "./routes/enquiries.js";
import { bannersRouter } from "./routes/banners.js";
import { mediaRouter } from "./routes/media.js";
import { seedAdmin } from "./seedAdmin.js";
import { seedPartners } from "./seedPartners.js";
import { Product } from "./models/Product.js";
import { Category } from "./models/Category.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 5000;
const isProd = process.env.NODE_ENV === "production";

function allowedOrigins() {
  const listed = String(process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.env.RENDER_EXTERNAL_URL) listed.push(process.env.RENDER_EXTERNAL_URL);
  return [...new Set(listed)];
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api/partners")) {
    return cors({
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"],
    })(req, res, next);
  }
  return cors({ origin: allowedOrigins(), credentials: true })(req, res, next);
});
app.use(cookieParser());
app.use(express.json({ limit: "8mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "brownstore" });
});

app.use("/api/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/partners", partnersRouter);
app.use("/api/enquiries", enquiriesRouter);
app.use("/api/banners", bannersRouter);
app.use("/api/media", mediaRouter);
app.use("/media", mediaRouter);

const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api(?:\/|$)|\/media(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Server error" });
});

async function connectDatabase() {
  const uri =
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/brownstore";
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: isProd ? 8000 : 2500 });
    console.log("MongoDB connected");
    return;
  } catch (err) {
    if (isProd) {
      console.error("MongoDB connection failed:", err.message);
      throw err;
    }
    console.warn("Local MongoDB unavailable:", err.message);
  }

  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri("brownstore"));
  console.log("MongoDB Memory Server connected (install local MongoDB to persist data)");
}

function stripMeta(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const { _id, save, toObject, __v, ...rest } = doc;
  return rest;
}

async function importFileCache() {
  const file = path.resolve(__dirname, "../data/store.json");
  if (!fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const products = (parsed.products || []).map(stripMeta);
  const categories = (parsed.categories || []).map(stripMeta);
  if (!products.length) return false;
  if (categories.length) {
    await Category.insertMany(categories, { ordered: false }).catch(() => {});
  }
  await Product.insertMany(products, { ordered: false }).catch(() => {});
  console.log(`Imported ${products.length} products from local cache into MongoDB`);
  return true;
}

async function start() {
  if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-this-to-a-long-random-secret")) {
    throw new Error("Set a strong JWT_SECRET before running in production");
  }

  await connectDatabase();
  await seedAdmin();
  await seedPartners();

  app.listen(port, "0.0.0.0", () => {
    console.log(`BrownStore listening on port ${port}`);
  });

  const count = await Product.countDocuments();
  if (count === 0) {
    const imported = await importFileCache();
    if (!imported) {
      console.log("No products yet — syncing catalog…");
      try {
        const result = await syncFromIbsher();
        console.log(
          `Initial sync: ${result.products} products, ${result.categories} categories`
        );
      } catch (err) {
        console.error("Initial sync failed:", err.message);
      }
    }
  } else {
    console.log(`Loaded ${count} products from MongoDB`);
  }
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
