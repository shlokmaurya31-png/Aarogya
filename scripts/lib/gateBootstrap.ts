/**
 * The shared gate bootstrap. Every scripts/verify-*.ts imports this FIRST
 * (scripts/lib/gateGuard.test.ts enforces it), so the guard runs before any
 * Prisma client, app module or fixture is loaded.
 *
 * It checks the environment Prisma will actually see: variables already set
 * in the process win, and .env fills in the rest (Prisma loads .env the same
 * way). A refusal exits before a single query.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { gateDatabaseProblem } from "./gateGuard";
import { GATE_TZ } from "./testClock";

function effectiveEnv(): Record<string, string | undefined> {
  const file = path.resolve(__dirname, "..", "..", ".env");
  const fromFile = existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>) : {};
  return { ...fromFile, ...process.env };
}

const problem = gateDatabaseProblem(effectiveEnv());
if (problem) {
  console.error(`Refusing to start ${path.basename(process.argv[1] ?? "this gate")}: ${problem}`);
  console.error("Run gates through `npm run verify:all`, or set DATABASE_URL and DIRECT_URL to postgresql://…@localhost:5432/aarogya_verify.");
  process.exit(2);
}

// Flagship 1a: one time zone for every gate, however it was started (by hand,
// verify:all or CI), so the local day the clinic sessions use is the India day
// the check-ins and summaries use. Set before any module reads the time; Node
// re-reads TZ when it changes, and the apps a gate starts inherit it.
process.env.TZ = GATE_TZ;

// One insurance-card key for every gate of a run, however each was started.
// Each insurance gate used to make its own random key, so a card one gate
// stored could not be read by the app another gate started (the tenancy
// sweep, run after them, got a 500 from the card route). A fixed, test-only
// key, derived here and used only against the local verify database of
// synthetic data; a key already in the environment wins.
process.env.INSURANCE_CARD_KEY_VERSION ??= "1";
process.env.INSURANCE_CARD_KEY_1 ??= createHash("sha256").update("aarogya gate card key, synthetic data only").digest("base64");
