/**
 * Local dry-run only: scans catalog + resolves category/brand.
 * Does NOT POST any products to Miswag.
 *
 * Usage: node src/scripts/miswagSyncAllDryRun.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { runMiswagSyncPreview } from "../services/miswagSyncAll.js";

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/brownstore";
  if (!process.env.MEDIA_PUBLIC_ORIGIN) {
    process.env.MEDIA_PUBLIC_ORIGIN = "https://api.brownstore.net";
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("Running Miswag Sync All dry-run (zero products sent)...");

  const result = await runMiswagSyncPreview();
  const job = result.job || {};
  const blocked =
    (job.skipped || 0) +
    (job.inactive || 0);
  const categoryRate =
    job.categoryAttempted > 0
      ? `${Math.round((job.categoryResolved / job.categoryAttempted) * 1000) / 10}% (${job.categoryResolved}/${job.categoryAttempted})`
      : "n/a";
  const brandRate =
    job.brandAttempted > 0
      ? `${Math.round((job.brandResolved / job.brandAttempted) * 1000) / 10}% (${job.brandResolved}/${job.brandAttempted})`
      : "n/a";

  const summary = {
    dryRun: result.dryRun,
    sentToMiswag: result.sentToMiswag,
    batchSize: result.batchSize,
    batchSizeReason: result.batchSizeReason,
    categoryCatalogSize: result.categoryCatalogSize,
    totals: {
      total: job.total,
      processed: job.processed,
      ready: job.ready,
      inactive: job.inactive,
      skipped: job.skipped,
      blocked,
      missingCategory: job.missingCategory,
      missingBrand: job.missingBrand,
      missingImage: job.missingImage,
      missingData: job.missingData,
      otherBlocked: job.otherBlocked,
    },
    categoryResolutionRate: categoryRate,
    brandResolutionRate: brandRate,
    blockedSamples: (job.blockedSamples || []).slice(0, 15),
  };

  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Dry-run failed:", err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
