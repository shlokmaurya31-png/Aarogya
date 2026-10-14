/**
 * Runs the Postgres integrity gates (scripts/verify-postgres-*.ts plus the
 * two Phase 6A inventory scripts) against a freshly reset, migrated and
 * seeded database, and writes a summary to .verify-report/latest.md.
 *
 * The gates are NOT idempotent (they consume appointment slots, roster
 * windows, document versions), so the database is always reset first:
 *
 *   default        reset + migrate + seed once, then run every script in order
 *   --fresh-each   reset + migrate + seed before EACH script (isolates failures)
 *   --only <pat>   run only scripts whose name contains <pat> (repeatable,
 *                  comma-separated also accepted)
 *   --timeout <s>  per-script timeout in seconds (default 300)
 *
 * Safety: resetting wipes the database, so this refuses to run unless
 * DATABASE_URL and DIRECT_URL point at localhost / 127.0.0.1 / ::1, or
 * ALLOW_REMOTE_VERIFY=1. Supabase (staging) hosts are refused even then.
 *
 * Usage: npm run verify:all -- [--fresh-each] [--only nhcx] [--timeout 600]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const REPORT_DIR = path.join(ROOT, ".verify-report");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PRISMA = path.join(ROOT, "node_modules", ".bin", "prisma");

// Roughly the order the phases were built in, so a failure in a foundation
// gate shows up before the later gates that depend on the same services.
// phase-b-final is the whole-system gate and always runs last
// (docs/PHASE_B_FINAL_INTEGRITY_GATE.md §7).
const ORDER = [
  // Phase 4 / 4.5 — diagnostics and resource scheduling
  "verify-postgres-diagnostics",
  "verify-postgres-scheduling",
  // Phase 5.5 — patient flow and billing concurrency
  "verify-postgres-bed-concurrency",
  "verify-postgres-appointment-concurrency",
  "verify-postgres-queue-concurrency",
  "verify-postgres-empi-adt-concurrency",
  "verify-postgres-billing-concurrency",
  // Phase 6.x — medication, nursing, pharmacy, inventory, procurement
  "verify-postgres-medication-concurrency",
  "verify-postgres-nursing-concurrency",
  "verify-postgres-inventory-concurrency",
  "verify-postgres-pharmacy",
  "verify-postgres-procurement-concurrency",
  "verify-postgres-inventory-procurement",
  "verify-inventory-e2e",
  "verify-inventory-security",
  // Phase B — departmental clinical modules
  "verify-postgres-emergency-department",
  "verify-postgres-icu-clinical",
  "verify-postgres-icu-concurrency",
  "verify-postgres-ot-concurrency",
  "verify-postgres-blood-bank",
  "verify-postgres-emr-documents",
  "verify-postgres-operations",
  // Phase C — interoperability (C1 first: C2–C6 build on its exchange model)
  "verify-postgres-interoperability",
  "verify-postgres-abdm-readiness",
  "verify-postgres-abdm-integration",
  "verify-postgres-trust-layer",
  "verify-postgres-nhcx",
  "verify-postgres-interoperability-control-plane",
  // Phase D — enterprise, commercial, platform
  "verify-postgres-enterprise-tenancy",
  "verify-postgres-commercial-entitlements",
  "verify-postgres-saas-billing",
  "verify-postgres-d4-billing",
  "verify-postgres-d5-commercial",
  "verify-postgres-d6-events",
  "verify-postgres-d7-workflows",
  "verify-postgres-d8-configuration",
  "verify-postgres-d9-builder",
  "verify-postgres-d10-command-center",
  "verify-postgres-d11-patient-experience",
  // Postgres cutover — dialect behaviour SQLite used to hide
  "verify-postgres-search",
  // Every hospital list/search/lookup endpoint over HTTP, as every role:
  // no other facility's rows (builds and starts the app itself)
  "verify-postgres-tenancy-sweep",
  // Week 2: identity and records
  "verify-postgres-ai-assistant",
  "verify-postgres-verification-uploads",
  "verify-postgres-patient-self-registration",
  "verify-postgres-patient-documents",
  // Gate 2: one patient, one record, everywhere (HTTP; builds the app)
  "verify-postgres-one-patient",
  // Week 2 duplicate merges (docs/DATA_DICTIONARY.md §1)
  "verify-postgres-consent-revocation",
  "verify-postgres-patient-identifiers",
  "verify-postgres-generated-documents",
  "verify-postgres-location-history",
  "verify-postgres-bookability",
  "verify-postgres-problem-list",
  // Runs last among the gates: checks every row the earlier gates created.
  "verify-postgres-facility-consistency",
  // Runs late: its whole-database check covers every earlier gate's orders.
  "verify-postgres-order-status",
];
const LAST = "verify-postgres-phase-b-final";

// verify-abdm-sandbox makes real network calls to dev.abdm.gov.in and needs
// ABDM sandbox credentials; without them it reports BLOCKED and exits 0,
// which would show up here as a misleading pass. Run it by hand when
// credentials exist.
const EXCLUDED = new Set(["verify-abdm-sandbox"]);

interface Options {
  freshEach: boolean;
  only: string[];
  timeoutMs: number;
}

interface Result {
  name: string;
  status: "PASS" | "FAIL" | "TIMEOUT";
  durationMs: number;
  tail: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { freshEach: false, only: [], timeoutMs: 300_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fresh-each") opts.freshEach = true;
    else if (arg === "--only") opts.only.push(...(argv[++i] ?? "").split(",").filter(Boolean));
    else if (arg.startsWith("--only=")) opts.only.push(...arg.slice(7).split(",").filter(Boolean));
    else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg.startsWith("--timeout=")) opts.timeoutMs = Number(arg.slice(10)) * 1000;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds");
  return opts;
}

function hostOf(name: string, url: string | undefined): string {
  if (!url) throw new Error(`${name} is not set (see .env.example).`);
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
}

// Both URLs are checked: `prisma migrate reset` connects through DIRECT_URL,
// the gates through DATABASE_URL.
function assertSafeTarget() {
  const host = hostOf("DATABASE_URL", process.env.DATABASE_URL);
  const hosts = [host, hostOf("DIRECT_URL", process.env.DIRECT_URL)];
  // Staging (Supabase) is never a valid target, whatever the override says.
  const staging = hosts.find((h) => /(^|\.)supabase\.(co|com)$/i.test(h));
  if (staging) {
    throw new Error(`Refusing to run: "${staging}" is the Supabase staging database. verify:all must never run against staging (docs/STAGING_SUPABASE.md).`);
  }
  const remote = hosts.find((h) => !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h));
  if (remote && process.env.ALLOW_REMOTE_VERIFY !== "1") {
    throw new Error(
      `Refusing to run: "${remote}" is not localhost. verify:all wipes the database. ` +
        "Set ALLOW_REMOTE_VERIFY=1 only if that database is disposable."
    );
  }
  // migrate reset (DIRECT_URL) and the gates (DATABASE_URL) must hit the
  // same database; otherwise overriding only DATABASE_URL would reset
  // whatever DIRECT_URL in .env points at, e.g. the dev database.
  const [db, direct] = [new URL(process.env.DATABASE_URL!), new URL(process.env.DIRECT_URL!)];
  if (db.hostname !== direct.hostname || db.pathname !== direct.pathname) {
    throw new Error(
      `Refusing to run: DATABASE_URL (${db.hostname}${db.pathname}) and DIRECT_URL (${direct.hostname}${direct.pathname}) name different databases. ` +
        "Set both to the database verify:all may wipe."
    );
  }
  return host;
}

function discover(opts: Options): string[] {
  const found = readdirSync(SCRIPTS_DIR)
    .filter((f) => /^verify-(postgres-.+|inventory-(e2e|security))\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((n) => !EXCLUDED.has(n));

  const unlisted = found.filter((n) => n !== LAST && !ORDER.includes(n)).sort();
  for (const n of unlisted) console.warn(`note: ${n} is not in the ORDER list; running it before ${LAST}.`);
  const missing = ORDER.filter((n) => !found.includes(n));
  for (const n of missing) console.warn(`note: ${n} is listed in ORDER but no longer exists; skipping.`);

  let names = [...ORDER.filter((n) => found.includes(n)), ...unlisted, ...(found.includes(LAST) ? [LAST] : [])];
  if (opts.only.length) names = names.filter((n) => opts.only.some((p) => n.includes(p)));
  return names;
}

/** Runs a command, streaming nothing; returns exit status and captured output. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    // detached: the child gets its own process group, so a timeout kills
    // tsx and everything it spawned.
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

async function resetDatabase() {
  const started = Date.now();
  process.stdout.write("  reset + migrate + seed ... ");
  const reset = await run(PRISMA, ["migrate", "reset", "--force", "--skip-seed"], 300_000);
  if (reset.code !== 0) {
    console.log("FAILED");
    throw new Error(`prisma migrate reset failed:\n${lastLines(reset.output, 40).join("\n")}`);
  }
  const seed = await run(TSX, ["prisma/seed.ts"], 600_000);
  if (seed.code !== 0) {
    console.log("FAILED");
    throw new Error(`Seed failed:\n${lastLines(seed.output, 40).join("\n")}`);
  }
  console.log(`done (${fmt(Date.now() - started)})`);
}

function lastLines(text: string, n: number): string[] {
  return text.replace(/\s+$/, "").split("\n").slice(-n);
}

function fmt(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function report(results: Result[], opts: Options, host: string, totalMs: number): string {
  const passed = results.filter((r) => r.status === "PASS").length;
  const lines = [
    "# verify:all report",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Database host: ${host}`,
    `- Mode: ${opts.freshEach ? "fresh database before each script" : "one fresh database for all scripts"}`,
    opts.only.length ? `- Filter: ${opts.only.join(", ")}` : "- Filter: none",
    `- Result: **${passed}/${results.length} passed** in ${fmt(totalMs)}`,
    `- Excluded: ${[...EXCLUDED].join(", ")} (needs external ABDM sandbox credentials)`,
    "",
    "| # | Script | Result | Duration |",
    "|---|--------|--------|----------|",
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.status === "PASS" ? "PASS" : `**${r.status}**`} | ${fmt(r.durationMs)} |`),
  ];
  for (const r of results.filter((x) => x.status !== "PASS")) {
    lines.push("", `## ${r.name}: ${r.status}`, "", "Last 40 lines of output:", "", "```", ...r.tail, "```");
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Same source Prisma uses; variables already set in the shell win, so the
  // safety check and every child process see one DATABASE_URL.
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const host = assertSafeTarget();
  if (!existsSync(TSX) || !existsSync(PRISMA)) throw new Error("tsx/prisma not found in node_modules; run npm ci first.");

  const names = discover(opts);
  if (names.length === 0) throw new Error(`No scripts match --only ${opts.only.join(", ")}.`);
  console.log(`verify:all — ${names.length} script(s) against ${host}${opts.freshEach ? ", fresh database each" : ""}`);

  const started = Date.now();
  const results: Result[] = [];
  if (!opts.freshEach) await resetDatabase();
  for (const [i, name] of names.entries()) {
    console.log(`[${i + 1}/${names.length}] ${name}`);
    if (opts.freshEach) await resetDatabase();
    const t0 = Date.now();
    const r = await run(TSX, [path.join("scripts", `${name}.ts`)], opts.timeoutMs);
    const status = r.timedOut ? "TIMEOUT" : r.code === 0 ? "PASS" : "FAIL";
    const result: Result = { name, status, durationMs: Date.now() - t0, tail: status === "PASS" ? [] : lastLines(r.output, 40) };
    results.push(result);
    console.log(`  ${status} (${fmt(result.durationMs)})`);
  }

  const md = report(results, opts, host, Date.now() - started);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "latest.md"), md);
  console.log("\n" + md.split("\n## ")[0]);
  console.log(`Full report: .verify-report/latest.md`);
  process.exitCode = results.every((r) => r.status === "PASS") ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
