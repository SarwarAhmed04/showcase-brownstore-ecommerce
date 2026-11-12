#!/usr/bin/env node
/**
 * Prints the one-index ownership migration and stops.
 * This process does not connect to MongoDB, create an index, change a
 * document, or call GINI. The migration remains disabled.
 */
import {
  OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED,
  SKUKEY_INDEX_COMMAND,
  runSkuKeyIndexMigration,
} from "../utils/giniOwnershipIndexPlan.js";

const result = await runSkuKeyIndexMigration({ dryRun: true, confirm: false });
console.log(JSON.stringify({
  released: OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED === true,
  dryRun: true,
  command: SKUKEY_INDEX_COMMAND,
  result,
}, null, 2));
