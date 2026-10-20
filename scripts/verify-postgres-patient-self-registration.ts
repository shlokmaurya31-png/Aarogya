/**
 * Patient self-registration links to the hospital's Patient record, never
 * auto-merging or auto-linking (src/lib/patient/selfRegistration.ts and, from
 * Phase 0, src/lib/person/linking.ts). Every account owns a Person.
 *
 *   1. No likely match: a new record is created, linked to the Person
 *      (SELF_CREATED).
 *   2. Likely match with a phone confirmed within 12 months: nothing is
 *      created or linked; the person first gives their date of birth or the
 *      UHID (exact match), then a code goes to THE RECORD'S phone; a wrong
 *      factor or code links nothing; the right code links the record to the
 *      Person and re-confirms the phone.
 *   3. Five failed attempts: in-person verification, still unlinked; the
 *      right code is no longer accepted.
 *   4. Likely match whose phone is missing or not confirmed: in-person
 *      verification; the front desk can no longer LINK by deciding, can
 *      create a new record for the person (linked), or reject.
 *   5. A match already connected to a Person: front-desk review, never linked.
 *   6. Matching never crosses facilities.
 *   7. Another facility's front desk can't decide the request.
 *
 * Uses SMS_PROVIDER=outbox (.data/outbox/sms.jsonl) to read the code that was
 * sent. Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-patient-self-registration.ts
 */
process.env.SMS_PROVIDER = "outbox";

import "./lib/gateBootstrap";
import { readFile, rm } from "node:fs/promises";
import { prisma } from "../src/lib/db";
import { BadRequestError, NotFoundError } from "../src/lib/auth/rbac";
import { SMS_OUTBOX_FILE } from "../src/lib/messaging/sms";
import { registerPatientAccount, verifyLinkOtp, decideLinkRequest, linkStatusFor } from "../src/lib/patient/selfRegistration";
import { submitSecondFactor } from "../src/lib/person/linking";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const run = Date.now().toString(36);
const email = (tag: string) => `self-reg-${tag}-${run}@verify.aarogya`;
const digits = (p: string) => p.replace(/[^0-9]/g, "").slice(-10);

/** The last code sent to `phone` through the SMS outbox. */
async function lastCodeTo(phone: string): Promise<string | null> {
  const lines = (await readFile(SMS_OUTBOX_FILE, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  for (const line of lines.reverse()) {
    const m = JSON.parse(line) as { to: string; text: string };
    if (digits(m.to) === digits(phone)) return /\b(\d{6})\b/.exec(m.text)?.[1] ?? null;
  }
  return null;
}

async function freshRecord(tag: string, phone: string | null, phoneConfirmedAt: Date | null = new Date()) {
  return prisma.patient.create({
    data: { uhid: `SELFREG-${tag}-${run}`, facilityId: "fac-amc-pune", fullName: `Selfreg ${tag} ${run}`, sex: "F", phone, dob: new Date("1990-05-17"), phoneConfirmedAt: phone ? phoneConfirmedAt : null },
  });
}

const personOf = async (userId: string) => (await prisma.personAccount.findUniqueOrThrow({ where: { userId } })).personId;
const linkTo = (patientId: string) => prisma.personPatientLink.findFirst({ where: { patientId, status: "ACTIVE" } });

async function main() {
  await rm(SMS_OUTBOX_FILE, { force: true });
  const reviewer = await prisma.user.findFirstOrThrow({ where: { role: "FRONT_DESK" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const before = await prisma.patient.count();

  // 1. No match.
  const a = await registerPatientAccount({ fullName: `Unmatched Person ${run}`, email: email("new"), passwordHash: "x", sex: "M", phone: "9000000001", dob: new Date("1985-01-01") });
  const aLink = a.status === "LINKED_NEW" ? await linkTo(a.patientId) : null;
  report("No likely match: a new record is created and linked to the account's Person (SELF_CREATED)", a.status === "LINKED_NEW" && aLink?.personId === (await personOf(a.userId)) && aLink?.method === "SELF_CREATED");
  report("…and the registrant's typed phone is not treated as confirmed", a.status === "LINKED_NEW" && (await prisma.patient.findUniqueOrThrow({ where: { id: a.patientId } })).phoneConfirmedAt === null);

  // 2. Match with a recently confirmed phone → second factor, then a code.
  const rec = await freshRecord("otp", "+91 98111 22334");
  const countBefore = await prisma.patient.count();
  const b = await registerPatientAccount({ fullName: rec.fullName, email: email("otp"), passwordHash: "x", sex: "F", phone: "9811122334", dob: new Date("1990-05-17") });
  report("Likely match: verification required (second factor first), phone masked", b.status === "VERIFICATION_REQUIRED" && b.maskedPhone === "••••••2334" && b.next === "SECOND_FACTOR", b.status);
  report("Likely match: no record created, record not linked", (await prisma.patient.count()) === countBefore && (await linkTo(rec.id)) === null);
  report("No code is sent before the second factor", (await lastCodeTo(rec.phone!)) === null);
  const badFactor = await submitSecondFactor(b.userId, { kind: "DOB", value: "1990-05-18" });
  report("A second factor that doesn't match exactly sends nothing and links nothing", badFactor.status === "INVALID" && (await lastCodeTo(rec.phone!)) === null && (await linkTo(rec.id)) === null);
  const lowerUhid = await submitSecondFactor(b.userId, { kind: "UHID", value: rec.uhid.toLowerCase() });
  report("…the UHID must match exactly (case included)", lowerUhid.status === "INVALID");
  const factor = await submitSecondFactor(b.userId, { kind: "DOB", value: "1990-05-17" });
  report("The exact date of birth sends a code to the record's phone", factor.status === "CODE_SENT");
  const code = await lastCodeTo(rec.phone!);
  report("The code went to the phone on the record", code !== null);
  const wrong = await verifyLinkOtp(b.userId, code === "000000" ? "111111" : "000000");
  report("A wrong code links nothing", wrong.status === "INVALID" && (await linkTo(rec.id)) === null);
  const right = await verifyLinkOtp(b.userId, code ?? "");
  const bLink = await linkTo(rec.id);
  report("The right code links the record to the registrant's Person (OTP_RECORD_CONTACT)", right.status === "LINKED" && bLink?.personId === (await personOf(b.userId)) && bLink?.method === "OTP_RECORD_CONTACT");
  report("…the phone the person just proved becomes their verified contact",
    (await prisma.personContact.count({ where: { personId: await personOf(b.userId), kind: "PHONE", value: "+919811122334", verifiedAt: { not: null } } })) === 1);
  report("…Patient.userId is no longer written (retired)", (await prisma.patient.findUniqueOrThrow({ where: { id: rec.id } })).userId === null);
  report("The registrant's status shows LINKED", (await linkStatusFor(b.userId))?.status === "LINKED");
  const linkedEvents = await prisma.domainEventOutbox.findMany({ where: { eventType: "PersonPatientLinked", aggregateId: bLink?.id ?? "-" } });
  report("…and emits PersonPatientLinked once, with the personId on the event", linkedEvents.length === 1 && linkedEvents[0].personId === bLink?.personId && (linkedEvents[0].payload as { method?: string }).method === "OTP_RECORD_CONTACT");
  report("…and no retired PatientAccountLinked", (await prisma.domainEventOutbox.count({ where: { eventType: "PatientAccountLinked", aggregateId: rec.id } })) === 0);

  // 3. Too many failed attempts → in person.
  const rec3 = await freshRecord("lockout", "9822233344");
  const c = await registerPatientAccount({ fullName: rec3.fullName, email: email("lock"), passwordHash: "x", sex: "F", phone: "9822233344", dob: new Date("1990-05-17") });
  await submitSecondFactor(c.userId, { kind: "UHID", value: rec3.uhid });
  const good3 = await lastCodeTo(rec3.phone!);
  const bad3 = good3 === "000000" ? "111111" : "000000";
  let last: Awaited<ReturnType<typeof verifyLinkOtp>> | null = null;
  for (let i = 0; i < 5; i++) last = await verifyLinkOtp(c.userId, bad3);
  report("Five failed attempts move the request to in-person verification", last?.status === "IN_PERSON_REQUIRED" && (await linkStatusFor(c.userId))?.status === "IN_PERSON_REQUIRED");
  const afterLock = await verifyLinkOtp(c.userId, good3 ?? "").then(() => "accepted", (e) => (e instanceof NotFoundError ? "no pending code" : String(e)));
  report("After lockout even the right code is not accepted", afterLock === "no pending code" && (await linkTo(rec3.id)) === null);

  // 4. A phone missing, or not confirmed within 12 months → in person.
  const rec4 = await freshRecord("nophone", null);
  const d = await registerPatientAccount({ fullName: rec4.fullName, email: email("nophone"), passwordHash: "x", sex: "F", dob: new Date("1990-05-17") });
  report("No phone on the record: in-person verification", d.status === "IN_PERSON_REQUIRED");
  const recOld = await freshRecord("stalephone", "9833344455", new Date(Date.now() - 400 * 86_400_000));
  const dOld = await registerPatientAccount({ fullName: recOld.fullName, email: email("stale"), passwordHash: "x", sex: "F", phone: "9833344455", dob: new Date("1990-05-17") });
  report("A phone confirmed over 12 months ago: in-person verification, no code sent", dOld.status === "IN_PERSON_REQUIRED" && (await lastCodeTo(recOld.phone!)) === null);
  const recNever = await freshRecord("unconfirmed", "9844455566", null);
  const dNever = await registerPatientAccount({ fullName: recNever.fullName, email: email("never"), passwordHash: "x", sex: "F", phone: "9844455566", dob: new Date("1990-05-17") });
  report("A phone never confirmed: in-person verification", dNever.status === "IN_PERSON_REQUIRED");
  const req4 = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: d.userId } });
  // 7. Another facility's front desk can't see or decide it.
  const crossDecision = await decideLinkRequest({ facilityId: "fac-amc-noida", requestId: req4.id, decision: "REJECT", reviewerUserId: reviewer.id }).then(() => "decided", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Another facility's front desk gets 404", crossDecision === "404");
  const deskLink = await decideLinkRequest({ facilityId: "fac-amc-pune", requestId: req4.id, decision: "LINK" as never, reviewerUserId: reviewer.id }).then(() => "linked", (e) => (e instanceof BadRequestError ? "refused" : String(e)));
  report("The front desk can no longer LINK by deciding", deskLink === "refused" && (await linkTo(rec4.id)) === null);
  const reqStale = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: dOld.userId } });
  const created = await decideLinkRequest({ facilityId: "fac-amc-pune", requestId: reqStale.id, decision: "CREATE_NEW", reviewerUserId: reviewer.id });
  const createdLink = created.status === "CREATED_NEW" ? await linkTo(created.patientId) : null;
  report("CREATE_NEW makes a separate record for the person, linked to them", created.status === "CREATED_NEW" && created.patientId !== recOld.id && createdLink?.personId === (await personOf(dOld.userId)));

  // 5. Matching a record already connected to a Person → review, never linked to the new account.
  const e = await registerPatientAccount({ fullName: rec.fullName, email: email("owned"), passwordHash: "x", sex: "F", phone: "9811122334", dob: new Date("1990-05-17") });
  const ownedReq = await prisma.patientLinkRequest.findFirst({ where: { userId: e.userId } });
  report("A match already connected to an account goes to front-desk review", e.status === "PENDING_REVIEW" && ownedReq?.reviewReason === "the matched record is already connected to an account");
  report("…and stays linked to its original Person", (await linkTo(rec.id))?.personId === (await personOf(b.userId)));

  // 6. Never cross-facility.
  const f = await registerPatientAccount({ fullName: rec4.fullName, email: email("noida"), passwordHash: "x", sex: "F", dob: new Date("1990-05-17"), facilityId: "fac-amc-noida" });
  report("A Pune record is never a match for a Noida registration", f.status === "LINKED_NEW");

  console.log(`\n${pass} passed, ${fail} failed. (patients ${before} → ${await prisma.patient.count()})`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
