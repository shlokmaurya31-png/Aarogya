/**
 * The shared gate bootstrap. Every scripts/verify-*.ts imports this FIRST
 * (scripts/lib/gateGuard.test.ts enforces it), so the guard runs before any
 * Prisma client, app module or fixture is loaded.
 *
 * It checks the environment Prisma will actually see: variables already set
 * in the process win, and .env fills in the rest (Prisma loads .env the same
 * way). A refusal exits before a single query.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { gateDatabaseProblem } from "./gateGuard";

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
