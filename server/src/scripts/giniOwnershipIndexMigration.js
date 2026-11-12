#!/usr/bin/env node
/**
 * Prints the ownership-operation index plan and stops.
 * This process does not connect to MongoDB, create a collection, create an
 * index, or call GINI. Run the commands only from a separate reviewed change.
 */
import { executeOwnershipIndexMigration, ownershipIndexMigrationPlan } from "../utils/giniOwnershipIndexPlan.js";

const result = executeOwnershipIndexMigration();
console.log(JSON.stringify({
  plan: ownershipIndexMigrationPlan(),
  result,
}, null, 2));
