/**
 * Week 5c — the guard for scripts the browser smoke runs between steps
 * (scripts/lib/e2eInsuranceSteps.ts): imported FIRST, before any Prisma
 * client. Both DATABASE_URL and DIRECT_URL must be exactly the smoke run's
 * database (E2E_DATABASE_URL, default the local verify database), which must
 * be on localhost, never Supabase, and never named like the dev database in
 * .env. Anything else exits before a single query.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { DEFAULT_VERIFY_URL } from "./verifyTarget";

const LOCAL = ["localhost", "127.0.0.1", "::1", "[::1]"];
const nameOf = (u: string) => decodeURIComponent(new URL(u).pathname.replace(/^\//, ""));

function problem(): string | null {
  const target = process.env.E2E_DATABASE_URL || DEFAULT_VERIFY_URL;
  const host = new URL(target).hostname;
  if (/(^|\.)supabase\.(co|com)$/i.test(host) || !LOCAL.includes(host)) return `"${host}" is not a local database.`;
  if (process.env.DATABASE_URL !== target || process.env.DIRECT_URL !== target) return "DATABASE_URL and DIRECT_URL must both be the smoke run's database.";
  const file = path.resolve(__dirname, "..", "..", ".env");
  const dev = existsSync(file) ? (parseEnv(readFileSync(file, "utf8")) as Record<string, string>).DATABASE_URL : undefined;
  if (dev && nameOf(dev) === nameOf(target)) return `the smoke database "${nameOf(target)}" is named like the dev database.`;
  return null;
}

let p: string | null;
try { p = problem(); } catch (err) { p = err instanceof Error ? err.message : String(err); }
if (p) {
  console.error(`Refusing to run: ${p}`);
  process.exit(2);
}
