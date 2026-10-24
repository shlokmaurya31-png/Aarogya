/**
 * Week 4a, step 1: the real-data switch (src/lib/ai/realData.ts).
 *
 *   1. Every new Person and facility is REAL; only the seed's demo
 *      facilities are SYNTHETIC.
 *   2. A REAL Person's data is refused while the switch is off, whatever
 *      they consented to.
 *   3. With the switch on, it still needs the purpose's consent (document
 *      processing and AI assistance are separate purposes).
 *   4. A SYNTHETIC Person's data is processed without the switch.
 *   5. A closed Person's data is never processed.
 *   6. Consent scopes: SAFETY_REVIEW only on AI_TEXT_RETENTION, only when
 *      granted (service and database).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-ai-switch.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { mayProcessPersonData } from "../src/lib/ai/realData";
import { decidePersonConsent } from "../src/lib/person/consent";
import { closePersonAccount } from "../src/lib/person/closure";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const run = Date.now().toString(36);
const OFF = { AI_REAL_DATA_ENABLED: undefined } as unknown as NodeJS.ProcessEnv;
const ON = { AI_REAL_DATA_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;

async function main() {
  const demo = await prisma.facility.findMany({ where: { id: { in: ["fac-amc-pune", "fac-amc-noida"] } }, select: { dataClassification: true } });
  report("The seed's demo facilities are SYNTHETIC", demo.length === 2 && demo.every((f) => f.dataClassification === "SYNTHETIC"));
  const org = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fresh = await prisma.facility.create({ data: { id: `fac-switch-${run}`, name: `Switch ${run}`, city: "Pune", organizationId: org.organizationId } });
  report("A new facility is REAL by default (nothing is assumed synthetic)", fresh.dataClassification === "REAL");

  const a = await registerPatientAccount({ fullName: `Switch Person ${run}`, email: `switch-${run}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1977-07-07") });
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  report("A new Person is REAL by default", (await prisma.person.findUniqueOrThrow({ where: { id: personId } })).dataClassification === "REAL");

  const off = await mayProcessPersonData(personId, "DOCUMENT_PROCESSING", OFF);
  report("Switch off: a REAL Person's data is refused (REAL_DATA_DISABLED)", !off.allowed && off.reason === "REAL_DATA_DISABLED");
  await decidePersonConsent({ userId: a.userId, purpose: "DOCUMENT_PROCESSING", decision: "GRANTED" });
  const offConsented = await mayProcessPersonData(personId, "DOCUMENT_PROCESSING", OFF);
  report("…even after they consent", !offConsented.allowed && offConsented.reason === "REAL_DATA_DISABLED");
  const onDoc = await mayProcessPersonData(personId, "DOCUMENT_PROCESSING", ON);
  const onAi = await mayProcessPersonData(personId, "AI_ASSISTANCE", ON);
  report("Switch on: allowed for the purpose consented to (document processing)", onDoc.allowed);
  report("…and refused for one not consented to (AI assistance: CONSENT_REQUIRED)", !onAi.allowed && onAi.reason === "CONSENT_REQUIRED");
  await decidePersonConsent({ userId: a.userId, purpose: "DOCUMENT_PROCESSING", decision: "DECLINED" });
  const onDeclined = await mayProcessPersonData(personId, "DOCUMENT_PROCESSING", ON);
  report("…and refused again once they decline", !onDeclined.allowed && onDeclined.reason === "CONSENT_REQUIRED");

  const b = await registerPatientAccount({ fullName: `Switch Synthetic ${run}`, email: `switch-syn-${run}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1978-08-08") });
  const synth = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: b.userId } })).personId;
  await prisma.person.update({ where: { id: synth }, data: { dataClassification: "SYNTHETIC" } });
  report("A SYNTHETIC Person's data is processed without the switch", (await mayProcessPersonData(synth, "DOCUMENT_PROCESSING", OFF)).allowed && (await mayProcessPersonData(synth, "AI_ASSISTANCE", OFF)).allowed);
  await closePersonAccount(b.userId, "CLOSE");
  const closed = await mayProcessPersonData(synth, "DOCUMENT_PROCESSING", ON);
  report("A closed Person's data is never processed", !closed.allowed && closed.reason === "PERSON_NOT_ACTIVE");

  report("SAFETY_REVIEW is refused on another purpose", await refused(decidePersonConsent({ userId: a.userId, purpose: "AI_ASSISTANCE", decision: "GRANTED", scopes: ["SAFETY_REVIEW"] })));
  report("…and on a declined choice", await refused(decidePersonConsent({ userId: a.userId, purpose: "AI_TEXT_RETENTION", decision: "DECLINED", scopes: ["SAFETY_REVIEW"] })));
  const kept = await decidePersonConsent({ userId: a.userId, purpose: "AI_TEXT_RETENTION", decision: "GRANTED", scopes: ["SAFETY_REVIEW"] });
  report("…and accepted on AI_TEXT_RETENTION, granted", kept.decision === "GRANTED" && kept.scopes.join() === "SAFETY_REVIEW");
  report("CHECK: the database refuses a scope on another purpose",
    await refused(prisma.personConsent.create({ data: { personId, purpose: "AI_ASSISTANCE", decision: "GRANTED", scopes: ["SAFETY_REVIEW"], decidedByUserId: a.userId, status: "SUPERSEDED", supersededAt: new Date() } })));
  const ev = await prisma.domainEventOutbox.findFirst({ where: { eventType: "PersonConsentDecided", aggregateId: personId }, orderBy: { seq: "desc" } });
  // v3 since Week 5b (decidedAs: SELF here, GUARDIAN for a guardian's choice for a child).
  report("PersonConsentDecided is v3 and carries the purpose, scopes and who decided, nothing else", ev?.eventVersion === 3 && (ev.payload as { purpose?: string; scopes?: string[] }).purpose === "AI_TEXT_RETENTION" && (ev.payload as { scopes?: string[] }).scopes?.join() === "SAFETY_REVIEW" && (ev.payload as { decidedAs?: string }).decidedAs === "SELF" && Object.keys(ev.payload as object).sort().join() === "consentId,decidedAs,decision,personId,previous,purpose,scopes");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
