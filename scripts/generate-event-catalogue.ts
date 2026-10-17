/**
 * Writes docs/EVENT_CATALOGUE.md from the code (src/lib/events/catalogueDoc.ts).
 * src/lib/events/catalogueDoc.test.ts fails when the committed file drifts.
 *
 * Usage: npm run docs:events
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { EVENT_CONTRACTS } from "../src/lib/events/catalogue";
import { getConsumers } from "../src/lib/events/consumers";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { analyze, libFiles } from "../src/lib/events/emitCoverage";
import { EMITTING_HELPERS } from "../src/lib/events/emitExemptions";
import { emitSites, renderEventCatalogue } from "../src/lib/events/catalogueDoc";

const ROOT = path.resolve(__dirname, "..");
registerAllConsumers();
const out = path.join(ROOT, "docs", "EVENT_CATALOGUE.md");
writeFileSync(out, renderEventCatalogue(EVENT_CONTRACTS, getConsumers(), emitSites(analyze(libFiles(ROOT), ROOT), EMITTING_HELPERS)));
console.log(`wrote ${path.relative(ROOT, out)}`);
process.exit(0);
