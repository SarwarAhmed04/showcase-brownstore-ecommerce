/**
 * Local dry-run for IT Lobby variant parent 38104.
 * Uses the fixture confirmed by the read-only production checks: parent and both
 * child SKUs absent, category 3 / 3 active. It does not connect to MongoDB or GINI.
 *
 *   node src/scripts/giniVariant38104DryRun.js
 */
import { dryRunItLobby38104 } from "../utils/giniVariant38104DryRun.js";

console.log(JSON.stringify(dryRunItLobby38104(), null, 2));
