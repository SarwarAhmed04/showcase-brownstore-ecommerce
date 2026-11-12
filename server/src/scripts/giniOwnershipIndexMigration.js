#!/usr/bin/env node
/**
 * Prints the ownership index migration and stops.
 * A Hostinger execution path exists behind a one-shot token, but this file
 * never turns that token on. The source release gate stays false.
 */
import {
  OWNERSHIP_INDEX_MIGRATION_RELEASED,
  OWNERSHIP_MIGRATION_COMMANDS,
  runOwnershipIndexMigration,
} from "../utils/giniOwnershipIndexPlan.js";

const production = process.argv.includes("--execute")
  || process.argv.includes("--production-dry-run")
  || process.argv.includes("--confirm-ownership-index-migration");

if (!production) {
  const result = await runOwnershipIndexMigration({ dryRun: true, confirm: false });
  console.log(JSON.stringify({
    released: OWNERSHIP_INDEX_MIGRATION_RELEASED === true,
    dryRun: true,
    executes: false,
    commands: OWNERSHIP_MIGRATION_COMMANDS,
    result,
  }, null, 2));
} else {
  const { runProductionOwnershipIndexMigration } = await import("../utils/giniOwnershipIndexMigrationRun.js");
  const outcome = await runProductionOwnershipIndexMigration({ argv: process.argv, env: process.env });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.ok !== true && outcome.code !== "ready_to_create" && outcome.code !== "already_ready") process.exitCode = 2;
}
