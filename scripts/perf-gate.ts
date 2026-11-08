/**
 * Flagship 1c — the performance gate: the 15 most-used screens and APIs,
 * over HTTP against a production build (`next start`), on the perf seed's
 * year of a 200-bed hospital (scripts/perf-seed.ts). Each endpoint is called
 * as the role that uses it: 3 warm-ups, then `--samples` calls one at a time;
 * its 95th percentile must be within its budget (300 ms), and every call must
 * answer 200. Not part of verify:all (it needs the perf seed, which the gates'
 * fixtures would only add noise to): `npm run perf:gate`.
 *
 *   --fresh        reset aarogya_verify, run the demo seed and the perf seed
 *                  first (the reset needs the task's consent, as verify:all)
 *   --no-build     reuse the existing build
 *   --samples <n>  calls per endpoint after the warm-ups (default 40)
 *   --save <name>  also keep the results as .perf-report/<name>.json
 *   --compare <name>  show a before column from .perf-report/<name>.json
 *   --seed-only    with --fresh: seed and stop (`npm run perf:seed`)
 *
 * Flagship 2d: the chart and timeline pages (first and next) also have a size
 * budget, PAGE_BYTES_BUDGET (60 KB for the heavy patient).
 *
 * Writes .perf-report/latest.md and latest.json. The local verify database
 * only: like verify:all it points DATABASE_URL and DIRECT_URL at
 * VERIFY_DATABASE_URL (default aarogya_verify on localhost) and applies the
 * gate guard before anything runs; providers are the mocks, the real-data
 * switch off.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { assertGateDatabase } from "./lib/gateGuard";
import { GATE_TZ } from "./lib/testClock";
import { resolveVerifyTarget } from "./lib/verifyTarget";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".perf-report");
const BIN = (n: string) => path.join(ROOT, "node_modules", ".bin", n);
export const P95_BUDGET_MS = 300;
const DEMO_PASSWORD = "Hospital@123";

/** Flagship 2d: the chart's and the timeline's pages must also stay small (the heavy patient's first page under 60 KB). */
export const PAGE_BYTES_BUDGET = 60 * 1024;
interface Endpoint { name: string; as: string | string[]; method?: "GET" | "POST"; path: string; body?: Record<string, unknown>; budgetMs?: number; maxBytes?: number }
interface Result { name: string; path: string; samples: number; p50: number; p95: number; max: number; budgetMs: number; bytes: number; maxBytes?: number; ok: boolean; error?: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const pct = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]; };
const round = (n: number) => Math.round(n * 10) / 10;

function run(label: string, cmd: string, args: string[]) {
  process.stdout.write(`${label} … `);
  const r = spawnSync(cmd, args, { cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
  console.log("done");
}

async function main() {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const target = resolveVerifyTarget();
  // The mocks, the switch off, this run's own keys (as the browser smoke).
  Object.assign(process.env, {
    DATABASE_URL: target.url, DIRECT_URL: target.url, TZ: GATE_TZ,
    DOCUMENT_AI_PROVIDER: "mock", RECORD_AI_PROVIDER: "mock", AI_PROVIDER: "mock", ANTHROPIC_API_KEY: "", VOYAGE_API_KEY: "",
    AI_REAL_DATA_ENABLED: "false", SMS_PROVIDER: "outbox",
    AI_TEXT_KEY_VERSION: "1", AI_TEXT_KEY_1: randomBytes(32).toString("base64"),
  });
  assertGateDatabase(process.env);
  if (process.argv.includes("--fresh")) {
    run("reset", BIN("prisma"), ["migrate", "reset", "--force", "--skip-seed"]);
    run("demo seed", BIN("tsx"), ["prisma/seed.ts"]);
    run("perf seed (about 3 minutes)", BIN("tsx"), ["scripts/perf-seed.ts"]);
    if (process.argv.includes("--seed-only")) return;
  }
  const fixturePath = path.join(OUT, "fixture.json");
  if (!existsSync(fixturePath)) throw new Error("No perf seed: run `npm run perf:gate -- --fresh` (or scripts/perf-seed.ts after a reset and seed).");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as { facilityId: string; heavyPatientId: string; heavyIpdEncounterId: string; reviewDocumentId: string; patientEmail: string; patientPassword: string };
  const { prisma } = await import("../src/lib/db");
  if (!(await prisma.patient.findUnique({ where: { id: fx.heavyPatientId }, select: { id: true } })) || !(await prisma.patient.findUnique({ where: { id: "pf-p-2" }, select: { id: true } }))) {
    throw new Error("The perf seed in .perf-report/fixture.json is not in this database: run with --fresh.");
  }
  const staffId = async (email: string) => (await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email } }, select: { id: true } })).id;
  const doctor1 = await staffId("doctor1@amc-demo.aarogya");
  await prisma.$disconnect();

  const { startServer, loginAs } = await import("./lib/appServer");
  const { base, child, serverLog } = await startServer({ SMS_PROVIDER: "outbox" });
  try {
    const cookies: Record<string, string> = {};
    const login = async (who: string, email: string, password = DEMO_PASSWORD) => { cookies[who] = await loginAs(base, email, password); };
    await login("frontdesk", "frontdesk@amc-demo.aarogya");
    await login("nurse", "nurse1@amc-demo.aarogya");
    await login("admin", "admin@amc-demo.aarogya");
    await login("billing", "billing@amc-demo.aarogya");
    await login("patient", fx.patientEmail, fx.patientPassword);
    // The AI's staff limit is 20 asks a minute per person: the AI endpoints rotate the eight doctors.
    const doctors: string[] = [];
    for (let i = 1; i <= 8; i++) { await login(`doctor${i}`, `doctor${i}@amc-demo.aarogya`); doctors.push(`doctor${i}`); }

    const P = fx.heavyPatientId;
    // The cursors for the second pages, from the first.
    const firstChart = await (await fetch(`${base}/api/hospital/patients/${P}/chart`, { headers: { cookie: cookies.doctor1 } })).json() as { nextCursors?: Record<string, string | null> };
    const firstTimeline = await (await fetch(`${base}/api/hospital/patients/${P}/timeline`, { headers: { cookie: cookies.doctor1 } })).json() as { nextCursor?: string | null };
    const labCursor = firstChart.nextCursors?.labOrders;
    const timelineCursor = firstTimeline.nextCursor;
    if (!labCursor || !timelineCursor) throw new Error("The heavy patient's chart or timeline has no second page: is the perf seed loaded?");
    const endpoints: Endpoint[] = [
      { name: "Front desk search", as: "frontdesk", path: `/api/hospital/patients?q=Sharma` },
      { name: "Chart", as: "doctor1", path: `/api/hospital/patients/${P}/chart`, maxBytes: PAGE_BYTES_BUDGET },
      { name: "Chart (next page of lab orders)", as: "doctor1", path: `/api/hospital/patients/${P}/chart?section=labOrders&cursor=${encodeURIComponent(labCursor)}`, maxBytes: PAGE_BYTES_BUDGET },
      { name: "Doctor workspace", as: "doctor1", path: `/api/hospital/doctor/dashboard?staffId=${doctor1}` },
      { name: "Nurse MAR (the medication round)", as: "nurse", path: `/api/hospital/nurse/tasks` },
      { name: "ED board", as: "doctor5", path: `/api/hospital/ed/board` },
      { name: "Command centre", as: "admin", path: `/api/hospital/command-center/overview` },
      { name: "Billing (an inpatient stay)", as: "billing", path: `/api/hospital/billing/${fx.heavyIpdEncounterId}` },
      { name: "Patient portal home", as: "patient", path: `/api/patient/home` },
      { name: "Timeline", as: "doctor1", path: `/api/hospital/patients/${P}/timeline`, maxBytes: PAGE_BYTES_BUDGET },
      { name: "Timeline (next page)", as: "doctor1", path: `/api/hospital/patients/${P}/timeline?cursor=${encodeURIComponent(timelineCursor)}`, maxBytes: PAGE_BYTES_BUDGET },
      { name: "Visit brief (AI)", as: doctors, method: "POST", path: `/api/ai/ask`, body: { mode: "VISIT_BRIEF", patientId: P } },
      { name: "Directory search", as: "patient", path: `/api/doctors/search?specialty=CARDIOLOGY&lat=18.52&lng=73.85` },
      { name: "Check-in desk", as: "frontdesk", path: `/api/hospital/checkins` },
      { name: "AI ask (retrieval)", as: doctors, method: "POST", path: `/api/ai/ask`, body: { mode: "CHART_QA", patientId: P, question: "What was the last hemoglobin?" } },
      { name: "Document review (facts to confirm)", as: "patient", path: `/api/patient/person/facts` },
      { name: "Household switcher", as: "patient", path: `/api/patient/household` },
    ];

    const samples = Number(arg("--samples") ?? 40);
    const results: Result[] = [];
    for (const e of endpoints) {
      const who = Array.isArray(e.as) ? e.as : [e.as];
      const times: number[] = [];
      let error: string | undefined;
      let bytes = 0;
      for (let i = 0; i < 3 + samples && !error; i++) {
        const t0 = performance.now();
        const res = await fetch(base + e.path, {
          method: e.method ?? "GET",
          headers: { cookie: cookies[who[i % who.length]], accept: "application/json", ...(e.body ? { "content-type": "application/json" } : {}) },
          body: e.body ? JSON.stringify(e.body) : undefined,
        });
        const body = Buffer.from(await res.arrayBuffer());
        bytes = body.length;
        if (process.env.PERF_DUMP) writeFileSync(path.join(OUT, `body-${endpoints.indexOf(e) + 1}.json`), body);
        const ms = performance.now() - t0;
        if (res.status !== 200) error = `HTTP ${res.status}`;
        else if (body.includes("\"passwordHash\"")) error = "the response carries a passwordHash";
        else if (i >= 3) times.push(ms);
      }
      const budgetMs = e.budgetMs ?? P95_BUDGET_MS;
      if (!error && e.maxBytes !== undefined && bytes > e.maxBytes) error = `${Math.round(bytes / 1024)} KB, over ${Math.round(e.maxBytes / 1024)} KB`;
      const r: Result = error
        ? { name: e.name, path: e.path, samples: times.length, p50: times.length ? round(pct(times, 50)) : NaN, p95: times.length ? round(pct(times, 95)) : NaN, max: times.length ? round(Math.max(...times)) : NaN, budgetMs, bytes, maxBytes: e.maxBytes, ok: false, error }
        : { name: e.name, path: e.path, samples: times.length, p50: round(pct(times, 50)), p95: round(pct(times, 95)), max: round(Math.max(...times)), budgetMs, bytes, maxBytes: e.maxBytes, ok: pct(times, 95) <= budgetMs };
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}: ${error ?? `p95 ${r.p95} ms (p50 ${r.p50}, max ${r.max}; budget ${budgetMs}; ${Math.round(bytes / 1024)} KB)`}`);
    }

    mkdirSync(OUT, { recursive: true });
    const before = arg("--compare") ? (JSON.parse(readFileSync(path.join(OUT, `${arg("--compare")}.json`), "utf8")) as { results: Result[] }).results : null;
    const json = { date: new Date().toISOString(), samples, budgetMs: P95_BUDGET_MS, results };
    writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(json, null, 2));
    if (arg("--save")) writeFileSync(path.join(OUT, `${arg("--save")}.json`), JSON.stringify(json, null, 2));
    const fmt = (n: number) => (Number.isNaN(n) ? "—" : `${n}`);
    writeFileSync(path.join(OUT, "latest.md"), [
      "# perf:gate report", "", `- Date: ${json.date}`, `- Data: the perf seed (one year of a 200-bed hospital), local verify database, production build`, `- ${samples} calls per endpoint after 3 warm-ups; budget p95 ≤ ${P95_BUDGET_MS} ms`,
      `- Result: **${results.filter((r) => r.ok).length}/${results.length} within budget**`, "",
      `| Screen / API | ${before ? "p95 before (ms) | " : ""}p50 (ms) | p95 (ms) | max (ms) | Response | Result |`,
      `|---|${before ? "---|" : ""}---|---|---|---|---|`,
      ...results.map((r) => `| ${r.name} | ${before ? `${fmt(before.find((b) => b.name === r.name)?.p95 ?? NaN)} | ` : ""}${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${Math.round(r.bytes / 1024)} KB | ${r.ok ? "PASS" : `**FAIL**${r.error ? ` (${r.error})` : ""}`} |`),
      "",
    ].join("\n"));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} within budget. Report: .perf-report/latest.md`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (e) {
    console.error(`The app's log (last lines):\n${serverLog().slice(-3000)}`);
    throw e;
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
