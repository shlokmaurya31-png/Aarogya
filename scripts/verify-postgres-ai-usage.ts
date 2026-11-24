/**
 * RAG Phase 4, step 4.5 — the AI usage report (GET /api/ai/usage).
 *
 *   U1  by role: an organisation's administrator and a facility's
 *       administrator read it; a doctor, a nurse and a patient are refused
 *       (403); another organisation's administrator gets 404
 *   U2  scope: a facility administrator sees their facility only, never
 *       another (404) or the organisation's figures
 *   U3  per-user figures: the facility's administrator only; an organisation
 *       administrator who isn't that facility's is refused (403)
 *   U4  the totals reconcile with the AiInteraction rows (the same filter,
 *       summed directly), and every grouping's rows add up to the totals
 *   U5  no patient data: no patient or person id, no question or answer, no
 *       canary anywhere in any response
 *
 * Its own synthetic organisation with two facilities and known interaction
 * rows, so the sums are exact.
 */
import "./lib/gateBootstrap";
import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { BadRequestError, ForbiddenError, NotFoundError } from "../src/lib/auth/rbac";
import { aiUsageReport, USAGE_GROUPS, type UsageReport } from "../src/lib/rag/usage";
import { staffUser, GATE_PASSWORD } from "./lib/knowledgeGate";
import { loginAs, startServer } from "./lib/appServer";
import { ensureConfigSeed } from "../src/lib/config/seed";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);
const CANARY = `usagecanary${tag}`;
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof ForbiddenError ? 403 : e instanceof NotFoundError ? 404 : e instanceof BadRequestError ? 400 : 500));

async function main() {
  const org = await prisma.organization.create({ data: { name: `Usage gate network ${tag}` } });
  const facA = await prisma.facility.create({ data: { name: `Usage gate A ${tag}`, organizationId: org.id, dataClassification: "SYNTHETIC" } });
  const facB = await prisma.facility.create({ data: { name: `Usage gate B ${tag}`, organizationId: org.id, dataClassification: "SYNTHETIC" } });
  await prisma.department.createMany({ data: [{ facilityId: facA.id, name: "General medicine" }, { facilityId: facB.id, name: "General medicine" }] });
  const platform = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, select: { id: true } });
  await ensureConfigSeed(platform.id, org.id);
  // The organisation's administrator (also B's), A's own administrator, a doctor in A, another organisation's administrator.
  const orgAdmin = await staffUser(`ug-org-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", facB.id, { orgAdmin: true });
  const aAdmin = await staffUser(`ug-a-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", facA.id);
  const doctor = await staffUser(`ug-doc-${tag}@verify.aarogya`, "DOCTOR", facA.id);
  const nurse = await staffUser(`ug-nurse-${tag}@verify.aarogya`, "NURSE", facA.id);
  const outsider = await staffUser(`ug-out-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", "fac-amc-pune", { orgAdmin: true });

  // Known rows: three users, both facilities, several modes, models and modules; one well outside the period.
  const now = Date.now();
  const rows = [
    { u: doctor, f: facA.id, mode: "CHART_QA", model: "mock-record-1", module: "ASK", tier: 2, inT: 600, outT: 80, emb: 12, rr: 30, ch: 0, cost: 2000, at: now - 3_600_000 },
    { u: doctor, f: facA.id, mode: "CHART_QA", model: "none", module: "ASK", tier: 0, inT: 0, outT: 0, emb: 0, rr: 0, ch: 0, cost: 0, at: now - 7_200_000 },
    { u: nurse, f: facA.id, mode: "NURSE_HANDOFF", model: "mock-record-1", module: "ASK", tier: 2, inT: 1200, outT: 800, emb: 20, rr: 40, ch: 0, cost: 11000, at: now - 86_400_000 },
    { u: doctor, f: facA.id, mode: "KNOWLEDGE_QA", model: "mock-record-1", module: "CHAT", tier: 2, inT: 900, outT: 95, emb: 0, rr: 30, ch: 1, cost: 2800, at: now - 2 * 86_400_000 },
    { u: orgAdmin, f: facB.id, mode: "KNOWLEDGE_QA", model: "mock-record-1", module: "ASK", tier: 2, inT: 850, outT: 90, emb: 14, rr: 25, ch: 0, cost: 2700, at: now - 5 * 86_400_000 },
    { u: doctor, f: facA.id, mode: "CHART_QA", model: "mock-record-1", module: "ASK", tier: 2, inT: 500, outT: 70, emb: 10, rr: 30, ch: 0, cost: 1800, at: now - 90 * 86_400_000 },
  ];
  for (const r of rows) {
    await prisma.aiInteraction.create({ data: {
      id: randomUUID(), organizationId: org.id, facilityId: r.f, userId: r.u.userId, role: r.u.role, mode: r.mode, language: "en", model: r.model, embeddingModel: "mock-hash-1024", embeddingVersion: 1,
      outcome: r.tier === 0 || r.mode !== "NURSE_HANDOFF" ? "ANSWERED" : "NO_RECORD", retrievedChunkIds: [`chunk-${CANARY}`], citedChunkIds: [], latencyMs: 100, metadataExpiresAt: new Date(now + 365 * 86_400_000),
      createdAt: new Date(r.at), module: r.module, intent: `${r.mode}:${CANARY}`, tier: r.tier, provider: r.tier ? "mock" : null, inputTokens: r.inT, outputTokens: r.outT, embeddingTokens: r.emb, rerankUnits: r.rr,
      cacheHits: r.ch, estimatedCostMicroUsd: r.cost, retrievalMs: 40, generationMs: r.tier ? 300 : null, patientId: null, questionCiphertext: null,
    } });
  }
  const who = (a: { userId: string; role: string }) => ({ userId: a.userId, role: a.role as Role });

  // ── U1, U2, U3 (the service) ──
  report("U1: the organisation's administrator reads the organisation's usage", (await status(aiUsageReport(who(orgAdmin), { organizationId: org.id }))) === 200);
  report("U1: a facility's administrator reads their facility's usage", (await status(aiUsageReport(who(aAdmin), { facilityId: facA.id }))) === 200);
  report("U1: a doctor and a nurse are refused (403)", (await status(aiUsageReport(who(doctor), {}))) === 403 && (await status(aiUsageReport(who(nurse), {}))) === 403);
  report("U1: another organisation's administrator gets 404 for this organisation and its facilities", (await status(aiUsageReport(who(outsider), { organizationId: org.id }))) === 404 && (await status(aiUsageReport(who(outsider), { facilityId: facA.id }))) === 404);
  const aOnly = await aiUsageReport(who(aAdmin), {});
  report("U2: a facility administrator's default is their facility", aOnly.facilityId === facA.id && aOnly.organizationId === org.id);
  report("U2: never another facility (404) or the organisation as a whole (404)", (await status(aiUsageReport(who(aAdmin), { facilityId: facB.id }))) === 404 && (await status(aiUsageReport(who(aAdmin), { organizationId: org.id }))) === 404);
  report("U3: per-user figures for the facility's own administrator", (await status(aiUsageReport(who(aAdmin), { facilityId: facA.id, groupBy: "user" }))) === 200);
  report("U3: an organisation administrator who isn't that facility's gets no per-user figures (403), nor for the organisation", (await status(aiUsageReport(who(orgAdmin), { facilityId: facA.id, groupBy: "user" }))) === 403 && (await status(aiUsageReport(who(orgAdmin), { organizationId: org.id, groupBy: "user" }))) === 403);
  report("U3 control: the organisation administrator sees per-user figures for their own facility (B)", (await status(aiUsageReport(who(orgAdmin), { facilityId: facB.id, groupBy: "user" }))) === 200);

  // ── U4 ──
  const from = new Date(now - 31 * 86_400_000), to = new Date(now + 86_400_000);
  const fromDay = from.toISOString().slice(0, 10), toDay = to.toISOString().slice(0, 10);
  const direct = await prisma.aiInteraction.aggregate({ where: { organizationId: org.id, createdAt: { gte: new Date(`${fromDay}T00:00:00Z`), lt: new Date(`${toDay}T00:00:00Z`) } }, _count: true, _sum: { inputTokens: true, outputTokens: true, embeddingTokens: true, rerankUnits: true, cacheHits: true, estimatedCostMicroUsd: true } });
  const reports: UsageReport[] = [];
  for (const g of USAGE_GROUPS.filter((x) => x !== "user")) reports.push(await aiUsageReport(who(orgAdmin), { organizationId: org.id, groupBy: g, from: fromDay, to: toDay }));
  const t = reports[0].totals;
  report("U4: the totals equal the AiInteraction rows summed directly (requests, tokens, rerank units, cache hits, cost)",
    t.requests === direct._count && t.inputTokens === direct._sum.inputTokens && t.outputTokens === direct._sum.outputTokens && t.embeddingTokens === direct._sum.embeddingTokens
      && t.rerankUnits === direct._sum.rerankUnits && t.cacheHits === direct._sum.cacheHits && t.estimatedCostMicroUsd === direct._sum.estimatedCostMicroUsd && t.requests === 5,
    `${t.requests} requests, ${t.inputTokens} in, ${t.estimatedCostMicroUsd} µ$`);
  const adds = reports.every((r) => (["requests", "answered", "tier0", "inputTokens", "outputTokens", "embeddingTokens", "rerankUnits", "cacheHits", "estimatedCostMicroUsd"] as const).every((k) => r.rows.reduce((a, x) => a + x[k], 0) === r.totals[k]));
  report("U4: every grouping's rows add up to the totals (facility, role, module, model, request type)", adds);
  const byFac = reports.find((r) => r.groupBy === "facility")!;
  report("U4: by facility, each facility's figures are its own rows (A: 4 requests, B: 1); the 90-day-old row is outside the period", byFac.rows.find((r) => r.key === facA.id)?.requests === 4 && byFac.rows.find((r) => r.key === facB.id)?.requests === 1 && byFac.rows.find((r) => r.key === facA.id)?.label === facA.name);
  const perUser = await aiUsageReport(who(aAdmin), { facilityId: facA.id, groupBy: "user", from: fromDay, to: toDay });
  report("U4: per user (A's administrator): the doctor 3 requests, the nurse 1, named by display name", perUser.rows.find((r) => r.key === doctor.userId)?.requests === 3 && perUser.rows.find((r) => r.key === nurse.userId)?.requests === 1 && perUser.totals.requests === 4);

  // ── U5 + HTTP ──
  const { base, child } = await startServer();
  try {
    const cookies = new Map<string, string>();
    const get = async (email: string, q: string) => {
      if (!cookies.has(email)) cookies.set(email, await loginAs(base, email, GATE_PASSWORD));
      return fetch(`${base}/api/ai/usage?${q}`, { headers: { cookie: cookies.get(email)! } });
    };
    const ok = await get(orgAdmin.email, `organizationId=${org.id}&groupBy=requestType`);
    const body = await ok.text();
    report("HTTP: the organisation administrator's report (200)", ok.status === 200 && JSON.parse(body).totals.requests === 5, String(ok.status));
    report("HTTP: a doctor is refused (403); another organisation's administrator gets 404; no session 401",
      (await get(doctor.email, "")).status === 403 && (await get(outsider.email, `organizationId=${org.id}`)).status === 404 && (await fetch(`${base}/api/ai/usage`)).status === 401);
    report("HTTP: per-user for the organisation administrator at A: 403", (await get(orgAdmin.email, `facilityId=${facA.id}&groupBy=user`)).status === 403);
    await get(aAdmin.email, `facilityId=${facA.id}`); // signs in once, before the parallel requests
    const all = [body, ...(await Promise.all(USAGE_GROUPS.map(async (g) => (await get(aAdmin.email, `facilityId=${facA.id}&groupBy=${g}`)).text())))].join("\n");
    const keys = new Set<string>();
    const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    for (const t of all.split("\n")) walk(JSON.parse(t));
    const forbidden = [...keys].filter((k) => /patient|person|question|answerText|ciphertext|chunk|source|intent/i.test(k));
    report("U5: no patient or person field, no question or answer text, no chunk or source, and no canary in any response", forbidden.length === 0 && !all.includes(CANARY) && !all.includes("chunk-"), forbidden.join() || `${keys.size} keys`);
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
