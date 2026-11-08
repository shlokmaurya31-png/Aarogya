/**
 * Flagship 2f — the concurrent load test: `npm run perf:load`.
 *
 * 50 simulated users for 5 minutes against a production build (`next start`)
 * on the perf seed (scripts/perf-seed.ts: a year of a 200-bed hospital), in a
 * realistic mix, each signed in as the role that does the work:
 *   10 front desk   patient search, the check-in desk, today's appointments
 *   15 doctors      their workspace, the chart (first and next pages), the
 *                   timeline, the ED board, a visit brief now and then
 *   13 nurses       the medication round, a chart, recording vitals (a write)
 *   10 patients     home, the household switcher, facts to confirm, the
 *                   doctor directory
 *    2 admins       the command centre
 * Each user waits 1–3 seconds between actions (a person at a screen). The
 * report gives each endpoint's count, p50/p95/p99 and error rate; it fails
 * (exit 1) when any endpoint's p95 is over 500 ms or any call errs.
 *
 *   --users <n>      simulated users (default 50, the mix scaled)
 *   --minutes <m>    duration (default 5)
 *   --fresh          reset aarogya_verify and seed first (needs the task's
 *                    reset consent, as verify:all)
 *   --no-build       reuse the existing build
 *
 * Writes .perf-report/load.md and load.json. Not part of verify:all. The
 * local verify database only (the same guard as perf:gate); the mocks, the
 * real-data switch off.
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
export const LOAD_P95_BUDGET_MS = 500;
const DEMO_PASSWORD = "Hospital@123";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]; };
const round = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Action { name: string; weight: number; method?: "GET" | "POST"; path: () => string; body?: () => Record<string, unknown> }
interface Role { role: string; users: number; logins: string[]; actions: Action[] }
interface Stat { name: string; times: number[]; errors: number; statuses: Record<string, number> }

function run(label: string, cmd: string, args: string[]) {
  process.stdout.write(`${label} … `);
  const r = spawnSync(cmd, args, { cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
  console.log("done");
}

async function main() {
  if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
  const target = resolveVerifyTarget();
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
  }
  const fixturePath = path.join(OUT, "fixture.json");
  if (!existsSync(fixturePath)) throw new Error("No perf seed: run `npm run perf:load -- --fresh` (or `npm run perf:seed`).");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as { facilityId: string; heavyPatientId: string; heavyIpdEncounterId: string; patientEmail: string; patientPassword: string };
  const { prisma } = await import("../src/lib/db");
  if (!(await prisma.patient.findUnique({ where: { id: fx.heavyPatientId }, select: { id: true } }))) throw new Error("The perf seed in .perf-report/fixture.json is not in this database: run with --fresh.");
  // Patients the front desk and doctors open: the heavy one and a spread of others.
  const patients = (await prisma.patient.findMany({ where: { facilityId: fx.facilityId, id: { startsWith: "pf-p-" } }, select: { id: true }, take: 400, orderBy: { id: "asc" } })).map((p) => p.id);
  const ipd = (await prisma.encounter.findMany({ where: { facilityId: fx.facilityId, type: "IPD", status: "ADMITTED" }, select: { id: true }, take: 100 })).map((e) => e.id);
  const doctorStaff = await Promise.all(Array.from({ length: 8 }, (_, i) => prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: `doctor${i + 1}@amc-demo.aarogya` } }, select: { id: true } }).then((s) => s.id)));
  await prisma.$disconnect();
  const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const somePatient = () => (Math.random() < 0.3 ? fx.heavyPatientId : pick(patients));
  const names = ["Sharma", "Patil", "Kumar", "Singh", "Rao", "Iyer", "Das", "Khan", "Joshi", "Nair"];
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  const { startServer, loginAs } = await import("./lib/appServer");
  const { base, child, serverLog } = await startServer({ SMS_PROVIDER: "outbox" });
  const stats = new Map<string, Stat>();
  try {
    const cookies = new Map<string, string>();
    const login = async (email: string, password = DEMO_PASSWORD) => { if (!cookies.has(email)) cookies.set(email, await loginAs(base, email, password)); return cookies.get(email)!; };
    // The next-page cursors, from a first page.
    const first = await (await fetch(`${base}/api/hospital/patients/${fx.heavyPatientId}/chart`, { headers: { cookie: await login("doctor1@amc-demo.aarogya") } })).json() as { nextCursors?: Record<string, string | null> };
    const labCursor = first.nextCursors?.labOrders ?? "";

    const doctorLogins = Array.from({ length: 8 }, (_, i) => `doctor${i + 1}@amc-demo.aarogya`);
    const nurseLogins = ["nurse1@amc-demo.aarogya"];
    const scale = Number(arg("--users") ?? 50) / 50;
    const n = (x: number) => Math.max(1, Math.round(x * scale));
    const roles: Role[] = [
      { role: "front desk", users: n(10), logins: ["frontdesk@amc-demo.aarogya"], actions: [
        { name: "Front desk: patient search", weight: 4, path: () => `/api/hospital/patients?q=${pick(names)}` },
        { name: "Front desk: check-in desk", weight: 3, path: () => `/api/hospital/checkins` },
        { name: "Front desk: today's appointments", weight: 3, path: () => `/api/hospital/appointments?date=${today}` },
      ] },
      { role: "doctor", users: n(15), logins: doctorLogins, actions: [
        { name: "Doctor: workspace", weight: 5, path: () => `/api/hospital/doctor/dashboard?staffId=${pick(doctorStaff)}` },
        { name: "Doctor: chart (first page)", weight: 5, path: () => `/api/hospital/patients/${somePatient()}/chart` },
        { name: "Doctor: chart (next page)", weight: 2, path: () => `/api/hospital/patients/${fx.heavyPatientId}/chart?section=labOrders&cursor=${encodeURIComponent(labCursor)}` },
        { name: "Doctor: timeline", weight: 3, path: () => `/api/hospital/patients/${somePatient()}/timeline` },
        { name: "Doctor: ED board", weight: 2, path: () => `/api/hospital/ed/board` },
        { name: "Doctor: visit brief (AI)", weight: 1, method: "POST", path: () => `/api/ai/ask`, body: () => ({ mode: "VISIT_BRIEF", patientId: fx.heavyPatientId }) }, // the AI needs the person's consent: the perf seed gave it for the heavy patient only (others are a correct 404)
      ] },
      { role: "nurse", users: n(13), logins: nurseLogins, actions: [
        { name: "Nurse: medication round", weight: 6, path: () => `/api/hospital/nurse/tasks` },
        { name: "Nurse: chart (first page)", weight: 2, path: () => `/api/hospital/patients/${somePatient()}/chart` },
        { name: "Nurse: record vitals (write)", weight: 2, method: "POST", path: () => `/api/hospital/encounters/${ipd.length ? pick(ipd) : fx.heavyIpdEncounterId}/vitals`, body: () => ({ hr: 60 + Math.floor(Math.random() * 40), sbp: 110 + Math.floor(Math.random() * 30), dbp: 70 + Math.floor(Math.random() * 15), spo2: 95 + Math.floor(Math.random() * 5), rr: 14, tempC: 36.8 }) },
      ] },
      { role: "patient", users: n(10), logins: [fx.patientEmail], actions: [
        { name: "Patient: home", weight: 4, path: () => `/api/patient/home` },
        { name: "Patient: household", weight: 2, path: () => `/api/patient/household` },
        { name: "Patient: facts to confirm", weight: 2, path: () => `/api/patient/person/facts` },
        { name: "Patient: doctor directory", weight: 2, path: () => `/api/doctors/search?specialty=${pick(["CARDIOLOGY", "GENERAL_MEDICINE", "PAEDIATRICS", "ORTHOPAEDICS"])}&lat=18.52&lng=73.85` },
      ] },
      { role: "admin", users: n(2), logins: ["admin@amc-demo.aarogya"], actions: [
        { name: "Admin: command centre", weight: 1, path: () => `/api/hospital/command-center/overview` },
      ] },
    ];
    for (const r of roles) for (const l of r.logins) await login(l, l === fx.patientEmail ? fx.patientPassword : DEMO_PASSWORD);

    const minutes = Number(arg("--minutes") ?? 5);
    const until = Date.now() + minutes * 60_000;
    const total = roles.reduce((a, r) => a + r.users, 0);
    console.log(`Load: ${total} users (${roles.map((r) => `${r.users} ${r.role}`).join(", ")}) for ${minutes} minutes against ${base}`);
    const user = async (r: Role, k: number) => {
      const cookie = cookies.get(r.logins[k % r.logins.length])!;
      const bag = r.actions.flatMap((a) => Array.from({ length: a.weight }, () => a));
      await sleep(Math.random() * 3000); // stagger the start
      while (Date.now() < until) {
        const a = pick(bag);
        const st = stats.get(a.name) ?? { name: a.name, times: [], errors: 0, statuses: {} };
        stats.set(a.name, st);
        const t0 = performance.now();
        try {
          const res = await fetch(base + a.path(), {
            method: a.method ?? "GET",
            headers: { cookie, accept: "application/json", ...(a.body ? { "content-type": "application/json" } : {}) },
            body: a.body ? JSON.stringify(a.body()) : undefined,
          });
          await res.arrayBuffer();
          st.times.push(performance.now() - t0);
          st.statuses[res.status] = (st.statuses[res.status] ?? 0) + 1;
          if (res.status >= 400) st.errors += 1;
        } catch (e) {
          st.times.push(performance.now() - t0);
          st.statuses[(e as Error).name] = (st.statuses[(e as Error).name] ?? 0) + 1;
          st.errors += 1;
        }
        await sleep(1000 + Math.random() * 2000);
      }
    };
    await Promise.all(roles.flatMap((r) => Array.from({ length: r.users }, (_, k) => user(r, k))));

    const rows = [...stats.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({
      name: s.name, count: s.times.length, p50: round(pct(s.times, 50)), p95: round(pct(s.times, 95)), p99: round(pct(s.times, 99)), max: round(Math.max(...s.times)),
      errorRate: s.times.length ? round((s.errors / s.times.length) * 100) : 0, statuses: s.statuses,
      ok: s.errors === 0 && pct(s.times, 95) <= LOAD_P95_BUDGET_MS,
    }));
    const all = [...stats.values()].flatMap((s) => s.times);
    const calls = all.length;
    const errors = [...stats.values()].reduce((a, s) => a + s.errors, 0);
    mkdirSync(OUT, { recursive: true });
    const json = { date: new Date().toISOString(), users: total, minutes, budgetP95Ms: LOAD_P95_BUDGET_MS, calls, errors, throughputPerSec: round(calls / (minutes * 60)), overall: { p50: round(pct(all, 50)), p95: round(pct(all, 95)), p99: round(pct(all, 99)) }, endpoints: rows };
    writeFileSync(path.join(OUT, "load.json"), JSON.stringify(json, null, 2));
    if (arg("--save")) writeFileSync(path.join(OUT, `load-${arg("--save")}.json`), JSON.stringify(json, null, 2));
    writeFileSync(path.join(OUT, "load.md"), [
      "# perf:load report", "", `- Date: ${json.date}`, `- ${total} simulated users for ${minutes} minutes, 1–3 s between actions; the perf seed (one year of a 200-bed hospital), local verify database, production build`,
      `- ${calls} calls (${json.throughputPerSec}/s), ${errors} errors; overall p50 ${json.overall.p50} ms, p95 ${json.overall.p95} ms, p99 ${json.overall.p99} ms`,
      `- Budget: every endpoint p95 ≤ ${LOAD_P95_BUDGET_MS} ms and no errors. Result: **${rows.filter((r) => r.ok).length}/${rows.length} within budget**`, "",
      "| Endpoint | Calls | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Errors | Result |", "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.name} | ${r.count} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errorRate}%${r.errorRate ? ` (${Object.entries(r.statuses).filter(([k]) => !/^2/.test(k)).map(([k, v]) => `${k}×${v}`).join(", ")})` : ""} | ${r.ok ? "PASS" : "**FAIL**"} |`),
      "",
    ].join("\n"));
    for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}: ${r.count} calls, p95 ${r.p95} ms, p99 ${r.p99} ms, errors ${r.errorRate}%`);
    console.log(`\n${calls} calls, ${errors} errors. Report: .perf-report/load.md`);
    if (rows.some((r) => !r.ok)) process.exitCode = 1;
  } catch (e) {
    console.error(`The app's log (last lines):\n${serverLog().slice(-3000)}`);
    throw e;
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
