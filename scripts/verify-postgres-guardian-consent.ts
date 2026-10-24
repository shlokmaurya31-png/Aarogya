/**
 * Week 5b follow-up — a guardian decides a managed minor's processing and AI
 * consents (docs/HOUSEHOLD_DESIGN.md §14):
 *   - a REAL child's upload is skipped (CONSENT_REQUIRED) until the guardian
 *     decides DOCUMENT_PROCESSING; then the upload is processed, and an
 *     earlier skipped one can be processed again by the guardian;
 *   - the parental-consent check: the declaration and a known relationship,
 *     a code to the guardian's own verified phone (a wrong, reused or expired
 *     code decides nothing; five wrong codes end the check);
 *   - recorded as the child's consent, decidedAs GUARDIAN with the check and
 *     the declaration's text, PersonConsentDecided v3 in the same
 *     transaction, and the child's access log;
 *   - AI_ASSISTANCE and AI_TEXT_RETENTION (SAFETY_REVIEW) the same way; the
 *     AI is then allowed over the REAL child's data;
 *   - only the holder of a GUARDIAN grant with the purpose's permission, for a
 *     MANAGED_MINOR under 18: another proxy, a dependent adult's proxy, a
 *     revoked guardian, an unknown purpose (sharing) are refused;
 *   - on the 18th birthday every guardian-given consent lapses, and the
 *     child's uploads are skipped again until they choose themselves.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-guardian-consent.ts
 */
import "./lib/gateBootstrap";
process.env.SMS_PROVIDER = "outbox";
process.env.AI_REAL_DATA_ENABLED = "true";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { uploadForMember } from "../src/lib/household/proxy";
import { confirmGuardianConsent, guardianConsents, startGuardianConsent } from "../src/lib/household/guardianConsent";
import { addDependentAdult } from "../src/lib/household/households";
import { requestReprocess } from "../src/lib/documents/patientView";
import { mayUseAiOver, mayProcessPersonData } from "../src/lib/ai/realData";
import { sweepConsentLapses, eighteenthBirthday } from "../src/lib/person/consentLapse";
import { GUARDIAN_CONSENT_DECLARATION } from "../src/lib/household/vocab";
import { drain, notFound, refused, reporter, sharer, tag } from "./lib/shareFixture";
import { child, lastSmsCode, manager, verifiedPhone } from "./lib/householdFixture";

const { report, done } = reporter();
const runOf = (documentId: string) => prisma.documentProcessing.findFirst({ where: { documentId }, orderBy: { run: "desc" }, include: { steps: true } });
const DECL = { relationship: "MOTHER", declaration: true };

async function main() {
  registerAllConsumers();
  const M = await manager();
  const c = await child(M, 9, `Real child ${tag}`);
  await prisma.person.update({ where: { id: c.childPersonId }, data: { dataClassification: "REAL" } });
  const pdf = async () => fixturePdf(fixtureById("lab-en-cbc")!);
  const upload = async (title: string) => uploadForMember(M.userId, c.childPersonId, { bytes: await pdf(), contentType: "application/pdf", originalName: "cbc.pdf", title, type: "REPORT" });

  // 1. Before any choice: a REAL child's upload is skipped.
  const d1 = await upload(`Before ${tag}`);
  await drain();
  const r1 = await runOf(d1.id);
  report("A REAL child's upload with no consent: SKIPPED (CONSENT_REQUIRED), nothing read", r1?.status === "SKIPPED" && r1.skipReason === "CONSENT_REQUIRED" && (await prisma.documentPage.count({ where: { processingId: r1.id } })) === 0);

  // 2. The parental-consent check.
  report("Without the declaration: refused", await refused(startGuardianConsent(M.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", relationship: "MOTHER" })));
  report("An unknown relationship: refused", await refused(startGuardianConsent(M.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", relationship: "NEIGHBOUR", declaration: true })));
  report("Sharing with hospitals isn't a guardian consent purpose (refused)", await refused(startGuardianConsent(M.userId, c.childPersonId, { purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED", ...DECL })));
  report("A scope the purpose doesn't define: refused", await refused(startGuardianConsent(M.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", scopes: ["SAFETY_REVIEW"], ...DECL })));
  const s1 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL });
  report("The code goes to the guardian's own verified phone (masked in the reply)", s1.sentTo.endsWith(M.phone.slice(-4)) && !s1.sentTo.includes(M.phone.slice(0, -4)) && /^\d{6}$/.test(lastSmsCode(M.phone)));
  report("Starting a check decides nothing", (await prisma.personConsent.count({ where: { personId: c.childPersonId } })) === 0);
  const other = await sharer();
  report("Someone else can't confirm the guardian's check (404)", await notFound(confirmGuardianConsent(other.userId, s1.checkId, lastSmsCode(M.phone))));
  report("A wrong code decides nothing", await refused(confirmGuardianConsent(M.userId, s1.checkId, "000000")) && (await prisma.personConsent.count({ where: { personId: c.childPersonId } })) === 0);
  const ok1 = await confirmGuardianConsent(M.userId, s1.checkId, lastSmsCode(M.phone));
  const consent = await prisma.personConsent.findFirstOrThrow({ where: { personId: c.childPersonId, purpose: "DOCUMENT_PROCESSING", status: "ACTIVE" } });
  const check = await prisma.guardianConsentCheck.findUniqueOrThrow({ where: { id: s1.checkId } });
  report("Confirmed: the child's DOCUMENT_PROCESSING is GRANTED, decidedAs GUARDIAN, by the guardian's login, with the check",
    ok1.decidedAs === "GUARDIAN" && consent.decision === "GRANTED" && consent.decidedAs === "GUARDIAN" && consent.decidedByUserId === M.userId && consent.guardianCheckId === s1.checkId && check.consentId === consent.id);
  report("…the declaration's text and the relationship are stored with the check", check.declarationText === GUARDIAN_CONSENT_DECLARATION && check.relationship === "MOTHER" && check.phoneLast4 === M.phone.slice(-4));
  const ev = await prisma.domainEventOutbox.findFirst({ where: { eventType: "PersonConsentDecided", aggregateId: c.childPersonId }, orderBy: { seq: "desc" } });
  const evp = ev?.payload as { purpose?: string; decidedAs?: string; consentId?: string } | undefined;
  report("…PersonConsentDecided v3 (decidedAs GUARDIAN), committed with the consent", ev?.eventVersion === 3 && evp?.purpose === "DOCUMENT_PROCESSING" && evp.decidedAs === "GUARDIAN" && evp.consentId === consent.id && ev.personId === c.childPersonId);
  report("…and in the child's access log", (await prisma.personAccessLogEntry.count({ where: { personId: c.childPersonId, kind: "CONSENT_DECIDED", actorUserId: M.userId } })) === 1);
  report("The code can't be used twice (404)", await notFound(confirmGuardianConsent(M.userId, s1.checkId, lastSmsCode(M.phone))));
  const s2 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "AI_ASSISTANCE", decision: "GRANTED", ...DECL });
  await prisma.guardianConsentCheck.update({ where: { id: s2.checkId }, data: { codeExpiresAt: new Date(Date.now() - 1000) } });
  report("An expired code decides nothing", await refused(confirmGuardianConsent(M.userId, s2.checkId, lastSmsCode(M.phone))) && (await prisma.personConsent.count({ where: { personId: c.childPersonId, purpose: "AI_ASSISTANCE" } })) === 0);
  const s3 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "AI_ASSISTANCE", decision: "GRANTED", ...DECL });
  for (let i = 0; i < 5; i++) await confirmGuardianConsent(M.userId, s3.checkId, "999999").catch(() => null);
  report("After five wrong codes even the right one is refused", await refused(confirmGuardianConsent(M.userId, s3.checkId, lastSmsCode(M.phone))));

  // 3. The upload is now processed; the earlier one can be processed again by the guardian.
  report("The pipeline's gate now allows the REAL child's data", (await mayProcessPersonData(c.childPersonId, "DOCUMENT_PROCESSING")).allowed);
  const d2 = await upload(`After ${tag}`);
  await drain();
  const r2 = await runOf(d2.id);
  report("A new upload is processed (pages read, not skipped)", !!r2 && r2.status !== "SKIPPED" && r2.status !== "FAILED" && (await prisma.documentPage.count({ where: { processingId: r2.id } })) > 0);
  await requestReprocess(M.userId, d1.id, "PATIENT_REQUEST", c.childPersonId);
  await drain();
  const r1b = await runOf(d1.id);
  report("The earlier skipped upload, processed again by the guardian (UPLOAD), is read", !!r1b && r1b.run === 2 && r1b.status !== "SKIPPED" && (await prisma.documentPage.count({ where: { processingId: r1b.id } })) > 0);
  report("…a proxy action in the child's access log", (await prisma.personAccessLogEntry.count({ where: { personId: c.childPersonId, kind: "PROXY_ACTION", actorUserId: M.userId, detail: { path: ["action"], equals: "REPROCESS" } } })) === 1);
  report("Someone without a grant can't reprocess the child's upload (404)", await notFound(requestReprocess(other.userId, d1.id, "PATIENT_REQUEST", c.childPersonId)));

  // 4. The AI consents.
  report("Before the AI consent: the AI is refused over the REAL child (CONSENT_REQUIRED)", (await mayUseAiOver({ personId: c.childPersonId })).allowed === false);
  const s4 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "AI_ASSISTANCE", decision: "GRANTED", ...DECL });
  await confirmGuardianConsent(M.userId, s4.checkId, lastSmsCode(M.phone));
  const ai = await mayUseAiOver({ personId: c.childPersonId });
  report("AI_ASSISTANCE by the guardian: the AI is allowed over the REAL child's data", ai.allowed && ai.real);
  const s5 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "AI_TEXT_RETENTION", decision: "GRANTED", scopes: ["SAFETY_REVIEW"], ...DECL });
  await confirmGuardianConsent(M.userId, s5.checkId, lastSmsCode(M.phone));
  const view = await guardianConsents(M.userId, c.childPersonId);
  report("AI_TEXT_RETENTION with SAFETY_REVIEW; the guardian sees all three as theirs",
    view.AI_TEXT_RETENTION?.decision === "GRANTED" && view.AI_TEXT_RETENTION.scopes.join() === "SAFETY_REVIEW" && (["DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"] as const).every((p) => view[p]?.decidedAs === "GUARDIAN"));
  const s6 = await startGuardianConsent(M.userId, c.childPersonId, { purpose: "AI_TEXT_RETENTION", decision: "DECLINED", ...DECL });
  await confirmGuardianConsent(M.userId, s6.checkId, lastSmsCode(M.phone));
  report("A guardian can decline too: the earlier choice is superseded", (await prisma.personConsent.findFirstOrThrow({ where: { personId: c.childPersonId, purpose: "AI_TEXT_RETENTION", status: "ACTIVE" } })).decision === "DECLINED" && (await prisma.personConsent.count({ where: { personId: c.childPersonId, purpose: "AI_TEXT_RETENTION", status: "SUPERSEDED" } })) === 1);

  // 5. Who may decide.
  const aunt = await sharer();
  await verifiedPhone(aunt.personId);
  await prisma.proxyGrant.create({ data: { memberPersonId: c.childPersonId, proxyPersonId: aunt.personId, householdId: M.householdId, basis: "MEMBER_CHOICE", permissions: ["VIEW", "UPLOAD", "USE_AI"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: M.personId } });
  report("A proxy whose grant isn't a GUARDIAN's can't decide (404)", await notFound(startGuardianConsent(aunt.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL })));
  report("Someone with no grant can't decide, nor see the choices (404)", await notFound(startGuardianConsent(other.userId, c.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL })) && await notFound(guardianConsents(other.userId, c.childPersonId)));
  const dep = await addDependentAdult(M.userId, M.householdId, { displayName: `Dep ${tag}`, relationship: "SIBLING" });
  await prisma.proxyGrant.update({ where: { id: dep.grantId }, data: { status: "ACTIVE", basis: "GUARDIAN" } });
  report("Not for a dependent adult, whatever the grant says (404)", await notFound(startGuardianConsent(M.userId, dep.adultPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL })));
  const c2 = await child(M, 7);
  await prisma.proxyGrant.update({ where: { id: c2.grantId }, data: { permissions: ["VIEW"] } });
  report("A guardian grant without UPLOAD can't decide document processing (404)", await notFound(startGuardianConsent(M.userId, c2.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL })));
  await prisma.proxyGrant.update({ where: { id: c2.grantId }, data: { permissions: ["VIEW", "UPLOAD"] } });
  const s7 = await startGuardianConsent(M.userId, c2.childPersonId, { purpose: "DOCUMENT_PROCESSING", decision: "GRANTED", ...DECL });
  await prisma.proxyGrant.update({ where: { id: c2.grantId }, data: { status: "REVOKED", revokedAt: new Date() } });
  report("A guardian whose grant ended after the code was sent can't confirm (404)", await notFound(confirmGuardianConsent(M.userId, s7.checkId, lastSmsCode(M.phone))) && (await prisma.personConsent.count({ where: { personId: c2.childPersonId } })) === 0);

  // 6. The 18th birthday.
  const dob = (await prisma.person.findUniqueOrThrow({ where: { id: c.childPersonId } })).dateOfBirth!;
  const at18 = new Date(eighteenthBirthday(dob).getTime() + 60_000);
  await sweepConsentLapses({ now: at18 });
  const lapsed = await prisma.personConsent.findMany({ where: { personId: c.childPersonId, purpose: { in: ["DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"] }, status: "LAPSED" } });
  report("At 18 every guardian-given consent lapses, each with PersonConsentLapsed",
    lapsed.length === 3 && lapsed.every((x) => x.decidedAs === "GUARDIAN") && (await prisma.domainEventOutbox.count({ where: { eventType: "PersonConsentLapsed", aggregateId: c.childPersonId } })) === 3);
  report("…processing is refused again (CONSENT_REQUIRED) until they choose", (await mayProcessPersonData(c.childPersonId, "DOCUMENT_PROCESSING")).allowed === false);
  const after = await mayUseAiOver({ personId: c.childPersonId });
  report("…and the AI (AI_CONSENT_LAPSED)", !after.allowed && after.reason === "AI_CONSENT_LAPSED");

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
