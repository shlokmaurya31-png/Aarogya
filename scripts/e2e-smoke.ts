/**
 * Week 4c (4b follow-up b) — browser smoke tests (Playwright, Chromium):
 *   npm run e2e:smoke            (builds the app first)
 *   npm run e2e:smoke -- --no-build
 *   npm run e2e:smoke -- --no-build e2e/opd.spec.ts   (anything else goes to Playwright)
 *
 * Against a LOCAL database only (E2E_DATABASE_URL, default the verify
 * database; the same refusals as verify:all: never Supabase, never a remote
 * host, never the dev database). It does NOT reset it: migrations are applied
 * (non-destructive), the seed runs only if the demo facility is missing, and
 * every fixture is synthetic and tagged for this run.
 *
 * Starts the app (next start) and the background worker on the mock
 * providers (no AI provider key reaches either), then runs e2e/*.spec.ts.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveVerifyTarget } from "./lib/verifyTarget";

const ROOT = path.resolve(__dirname, "..");
const BIN = (n: string) => path.join(ROOT, "node_modules", ".bin", n);
const OUT = path.join(ROOT, ".e2e");

async function main() {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const target = resolveVerifyTarget("E2E_DATABASE_URL");
  // Everything below (fixture, app, worker, tests) sees only this database and the mock providers.
  Object.assign(process.env, {
    DATABASE_URL: target.url, DIRECT_URL: target.url,
    DOCUMENT_AI_PROVIDER: "mock", RECORD_AI_PROVIDER: "mock", AI_PROVIDER: "mock", ANTHROPIC_API_KEY: "", VOYAGE_API_KEY: "",
    AI_REAL_DATA_ENABLED: "false", SMS_PROVIDER: "outbox",
    // This run's own key for the AI interaction text (never a real key).
    AI_TEXT_KEY_VERSION: "1", AI_TEXT_KEY_1: randomBytes(32).toString("base64"),
    // Week 5c: this run's card key, and the Pune facility's test-mode gateway secrets; order
    // creation is stubbed (no Razorpay test account here), the payment arrives as a signed webhook.
    INSURANCE_CARD_KEY_VERSION: "1", INSURANCE_CARD_KEY_1: randomBytes(32).toString("base64"),
    RAZORPAY_KEY_SECRET__E2E_SMOKE: randomBytes(18).toString("hex"), RAZORPAY_WEBHOOK_SECRET__E2E_SMOKE: randomBytes(18).toString("hex"),
    HOSPITAL_GATEWAY_STUB: "1",
  });
  console.log(`e2e:smoke — against ${target.host}/${target.name}`);

  const migrate = spawnSync(BIN("prisma"), ["migrate", "deploy"], { cwd: ROOT, env: process.env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed:\n${(migrate.stdout + migrate.stderr).slice(-2000)}`);
  const { prisma } = await import("../src/lib/db");
  const { PUNE, buildE2eFixture } = await import("./lib/e2eFixture");
  if (!(await prisma.facility.findUnique({ where: { id: PUNE }, select: { id: true } }))) {
    console.log("Seeding the demo data (the facility is missing)…");
    const seed = spawnSync(BIN("tsx"), ["prisma/seed.ts"], { cwd: ROOT, env: process.env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`seed failed:\n${(seed.stdout + seed.stderr).slice(-2000)}`);
  }
  const fixture = await buildE2eFixture(OUT);
  await prisma.$disconnect();
  console.log(`fixture ${fixture.tag}: patient, doctor, an active share, a sample report`);

  const { startServer } = await import("./lib/appServer");
  const children: ChildProcess[] = [];
  let code = 1;
  try {
    const app = await startServer();
    children.push(app.child);
    const worker = spawn(BIN("tsx"), ["scripts/worker.ts"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let workerLog = "";
    worker.stdout!.on("data", (d) => (workerLog += d));
    worker.stderr!.on("data", (d) => (workerLog += d));
    children.push(worker);
    const pw = spawnSync(BIN("playwright"), ["test", "--config", "playwright.config.ts", ...process.argv.slice(2).filter((a) => a !== "--no-build")], {
      cwd: ROOT, stdio: "inherit", env: { ...process.env, E2E_BASE_URL: app.base, E2E_FIXTURE: path.join(OUT, "fixture.json") },
    });
    code = pw.status ?? 1;
    if (code !== 0) console.log(`\n── app log (tail) ──\n${app.serverLog().slice(-3000)}\n── worker log (tail) ──\n${workerLog.slice(-2000)}`);
  } finally {
    for (const c of children) c.kill("SIGTERM");
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
