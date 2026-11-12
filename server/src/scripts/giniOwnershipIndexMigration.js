#!/usr/bin/env node
/**
 * Prints the ownership collection and index migration, then stops.
 * This process does not connect to MongoDB, create a collection, create an
 * index, change a document, or call GINI. The migration remains disabled.
 */
import {
  OWNERSHIP_INDEX_MIGRATION_RELEASED,
  OWNERSHIP_MIGRATION_COMMANDS,
  runOwnershipIndexMigration,
} from "../utils/giniOwnershipIndexPlan.js";

const result = await runOwnershipIndexMigration({ dryRun: true, confirm: false });
console.log(JSON.stringify({
  released: OWNERSHIP_INDEX_MIGRATION_RELEASED === true,
  dryRun: true,
  executes: false,
  commands: OWNERSHIP_MIGRATION_COMMANDS,
  result,
}, null, 2));
