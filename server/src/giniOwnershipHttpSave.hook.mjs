import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RELEASED = "export const OWNERSHIP_SAVE_RELEASED = false;";
const INDEXES = "export const OWNERSHIP_SAVE_INDEXES_READY = false;";
const RELEASED_OPEN = "export const OWNERSHIP_SAVE_RELEASED = true;";
const INDEXES_OPEN = "export const OWNERSHIP_SAVE_INDEXES_READY = true;";

/**
 * Evaluates the ownership audit module with both source locks open.
 * The file on disk stays closed. This hook is loaded only by the isolated HTTP save test.
 */
export async function load(url, context, nextLoad) {
  if (!url.includes("/giniVariantOwnershipAudit.js") || url.includes("?")) {
    return nextLoad(url, context);
  }
  const source = fs.readFileSync(fileURLToPath(url), "utf8");
  if (!source.includes(RELEASED) || !source.includes(INDEXES) || source.includes(RELEASED_OPEN) || source.includes(INDEXES_OPEN)) {
    throw new Error("ownership HTTP fixture refused to rewrite the lock lines");
  }
  const opened = source.replace(RELEASED, RELEASED_OPEN).replace(INDEXES, INDEXES_OPEN);
  return { format: "module", source: opened, shortCircuit: true };
}
