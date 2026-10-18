#!/usr/bin/env node
/**
 * Verify Miswag Seller API credentials from this machine (local Windows or VPS).
 *
 * Usage (from server/):
 *   node src/scripts/verifyMiswagConnection.js
 *
 * Reads MISWAG_BASE_URL, MISWAG_API_KEY, MISWAG_API_SECRET from the environment
 * (and optional Mongo-stored admin settings if MONGO_URL is available).
 *
 * Never prints the API secret.
 */
import "dotenv/config";
import mongoose from "mongoose";
import {
  MISWAG_AUTH_HEADERS,
  MISWAG_HEALTHCHECK_PATH,
  maskApiKey,
  testMiswagConnection,
} from "../services/miswag.js";

async function maybeConnectMongo() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  if (!uri) return false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    return true;
  } catch (err) {
    console.warn("Mongo unavailable; using environment credentials only:", err.message);
    return false;
  }
}

async function main() {
  const connectedMongo = await maybeConnectMongo();
  const result = await testMiswagConnection({ timeoutMs: 20000 });
  const keyHint = result.connection?.apiKeyPrefix || maskApiKey(process.env.MISWAG_API_KEY || "");

  console.log("Miswag connection verify");
  console.log("------------------------");
  console.log(`Mongo:            ${connectedMongo ? "connected" : "skipped"}`);
  console.log(`Base URL:         ${result.diagnostics.baseUrl}`);
  console.log(`Endpoint:         ${result.diagnostics.endpoint || MISWAG_HEALTHCHECK_PATH}`);
  console.log(`Headers:          ${MISWAG_AUTH_HEADERS.apiKey}, ${MISWAG_AUTH_HEADERS.apiSecret}`);
  console.log(`API Key:          ${keyHint || "(missing)"}`);
  console.log(`API Secret:       ${result.connection?.hasApiSecret || result.connection?.secretSet ? "(set)" : "(missing)"}`);
  console.log(`HTTP status:      ${result.httpStatus || "(none)"}`);
  console.log(`Response time:    ${result.diagnostics.responseMs}ms`);
  console.log(`Auth OK:          ${result.diagnostics.authOk}`);
  console.log(`Status:           ${result.status}`);
  console.log(`Message:          ${result.message}`);
  console.log(`Sync enabled:     ${result.syncEnabled}`);
  if (result.diagnostics.error) console.log(`Error:            ${result.diagnostics.error}`);

  if (mongoose.connection.readyState) await mongoose.disconnect().catch(() => {});
  process.exit(result.ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Verify failed:", err?.message || err);
  if (mongoose.connection.readyState) await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
