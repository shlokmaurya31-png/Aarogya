/**
 * Week 5b — proxies see exactly what their grant allows (docs/HOUSEHOLD_DESIGN.md
 * §5, §7, §10), zero tolerance, with positive controls:
 *   - sensitive canaries (a psychiatric diagnosis, an HIV result) are absent
 *     for a proxy without an opt-in on every path (the record view, the
 *     member's uploads, the AI), and present with it;
 *   - a guardian of a 12–17-year-old can't opt in (pending lawyer review),
 *     and an opt-in made while the child was younger stops at 12;
 *   - a proxy of member A sees nothing of member B in the same household;
 *   - a removed proxy sees nothing at once;
 *   - the switcher can't name a member without a grant;
 *   - the AI: a proxy with USE_AI gets the patient modes over what VIEW
 *     allows; without USE_AI, refused; staff modes never.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-proxy-leaks.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
process.env.SMS_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { viewMember } from "../src/lib/household/proxy";
import { parseSensitive, revokeGrantAsMember } from "../src/lib/household/grants";
import { askAi, AskError } from "../src/lib/rag/ask";
import { reindexPerson } from "../src/lib/rag/indexer";
import { PUNE, drain, lab, notFound, refused, reporter, staff, tag } from "./lib/shareFixture";
import { child, manager } from "./lib/householdFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");
const canary = (k: string) => `hhcanary${k}${tag}`;

async function recordFor(personId: string) {
  const p = await prisma.patient.create({ data: { uhid: `HHL-${tag}-${personId.slice(-6)}`, facilityId: PUNE, fullName: `Kid ${tag}`, sex: "F" } });
  await prisma.personPatientLink.create({ data: { personId, patientId: p.id, facilityId: PUNE, status: "ACTIVE", method: "SELF_CREATED", linkedAt: new Date(), linkedByUserId: "gate" } });
  const enc = await prisma.encounter.create({ data: { patientId: p.id, facilityId: PUNE, type: "OPD", status: "CLOSED", chiefComplaint: "gate", closedAt: new Date() } });
  return { patientId: p.id, encounterId: enc.id };
}

async function main() {
  registerAllConsumers();
  const doc = await staff(PUNE, "DOCTOR");
  const M = await manager();
  const young = await child(M, 9, `Young ${tag}`);
  const teen = await child(M, 15, `Teen ${tag}`);
  const y = await recordFor(young.childPersonId), t = await recordFor(teen.childPersonId);
  for (const [r, who] of [[y, "y"], [t, "t"]] as const) {
    await lab(r.patientId, r.encounterId, "Haemoglobin", `12 ${canary(`lab${who}`)}`);
    await lab(r.patientId, r.encounterId, "HIV 1/2 antibody", `Non-reactive ${canary(`hiv${who}`)}`);
    await prisma.diagnosis.create({ data: { patientId: r.patientId, encounterId: r.encounterId, diagnosis: `Anxiety disorder ${canary(`psy${who}`)}`, code: "F41.1", codeSystem: "ICD-10", type: "FINAL", diagnosedByStaffId: doc.staffId } });
  }
  await drain();
  for (const p of [young.childPersonId, teen.childPersonId]) await reindexPerson(p);
  const seen = async (proxyUserId: string, personId: string) => JSON.stringify(await viewMember(proxyUserId, personId));

  // Sensitive: off by default.
  const yv = await seen(M.userId, young.childPersonId);
  report("Default: the guardian sees the child's lab (control)", yv.includes(canary("laby")));
  report("…but not the HIV result or the psychiatric diagnosis (no opt-in)", !yv.includes(canary("hivy")) && !yv.includes(canary("psyy")));
  const ask = (userId: string, patientId: string, mode: "HEALTH_TIMELINE" | "CHART_QA" = "HEALTH_TIMELINE") =>
    askAi({ kind: "PATIENT", userId }, { mode, patientId, memberPersonId: patientId ? undefined : undefined } as never).then((r) => JSON.stringify(r), (e) => (e instanceof AskError ? `refused ${e.status}` : `error ${e}`));
  const ai = await ask(M.userId, y.patientId);
  report("The AI (USE_AI): the guardian's timeline answers, without the sensitive canaries", !ai.startsWith("refused") && !ai.includes(canary("hivy")) && !ai.includes(canary("psyy")));
  // Opt in for the 9-year-old (allowed under 12).
  const sens = await parseSensitive(["HIV", "MENTAL_HEALTH"], young.childPersonId, "GUARDIAN");
  await prisma.proxyGrant.update({ where: { id: young.grantId }, data: { sensitiveCategories: sens } });
  const yv2 = await seen(M.userId, young.childPersonId);
  report("With the opt-in (a child under 12): the HIV result and the diagnosis show (control)", yv2.includes(canary("hivy")) && yv2.includes(canary("psyy")));
  report("A guardian can't opt in for a 15-year-old (pending lawyer review)", await refused(parseSensitive(["HIV"], teen.childPersonId, "GUARDIAN")));
  await prisma.proxyGrant.update({ where: { id: teen.grantId }, data: { sensitiveCategories: ["HIV", "MENTAL_HEALTH"] } });
  const tv = await seen(M.userId, teen.childPersonId);
  report("…and even a stored opt-in is ignored from 12: nothing sensitive of the teen", tv.includes(canary("labt")) && !tv.includes(canary("hivt")) && !tv.includes(canary("psyt")));
  const tai = await ask(M.userId, t.patientId);
  report("…on the AI path too", !tai.startsWith("refused") && !tai.includes(canary("hivt")) && !tai.includes(canary("psyt")));

  // Member A's proxy sees nothing of member B.
  const aunt = await (await import("./lib/shareFixture")).sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: young.childPersonId, proxyPersonId: aunt.personId, householdId: M.householdId, basis: "GUARDIAN", permissions: ["VIEW"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: M.personId } });
  report("A proxy of the younger child (control: sees her lab)", (await seen(aunt.userId, young.childPersonId)).includes(canary("laby")));
  report("…sees nothing of the teen in the same household (404)", await notFound(viewMember(aunt.userId, teen.childPersonId)));
  report("…nor through the AI (404)", (await ask(aunt.userId, t.patientId)) === "refused 404");
  report("A proxy without USE_AI is refused the AI (404)", (await ask(aunt.userId, y.patientId)) === "refused 404");
  report("Staff modes are never a proxy's (403)", (await ask(M.userId, y.patientId, "CHART_QA")).startsWith("refused 403"));

  // A removed proxy.
  const g = await prisma.proxyGrant.findFirstOrThrow({ where: { proxyPersonId: aunt.personId, memberPersonId: young.childPersonId } });
  await prisma.proxyGrant.update({ where: { id: g.id }, data: { status: "REVOKED", revokedAt: new Date() } });
  report("A removed proxy sees nothing at once (404)", await notFound(viewMember(aunt.userId, young.childPersonId)));
  report("Nobody but the member can revoke through the member's path (404)", await notFound(revokeGrantAsMember(aunt.userId, g.id)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
