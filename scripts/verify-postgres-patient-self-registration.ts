/**
 * Patient self-registration links to the hospital's Patient record, never
 * auto-merging (src/lib/patient/selfRegistration.ts).
 *
 *   1. No likely match: a new record is created and linked.
 *   2. Likely match with a phone on record: nothing is created or linked; a
 *      code goes to THE RECORD'S phone; a wrong code links nothing; the right
 *      code links the account to that record.
 *   3. Too many wrong codes: front-desk review, still unlinked.
 *   4. Likely match with no phone on record: front-desk review; LINK links.
 *   5. A match that already has an account: front-desk review, never linked.
 *   6. Matching never crosses facilities.
 *   7. Another facility's front desk can't decide the request.
 *
 * Uses SMS_PROVIDER=outbox (.data/outbox/sms.jsonl) to read the code that was
 * sent. Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-patient-self-registration.ts
 */
process.env.SMS_PROVIDER = "outbox";

import { readFile, rm } from "node:fs/promises";
import { prisma } from "../src/lib/db";
import { NotFoundError } from "../src/lib/auth/rbac";
import { SMS_OUTBOX_FILE } from "../src/lib/messaging/sms";
import { registerPatientAccount, verifyLinkOtp, decideLinkRequest, linkStatusFor } from "../src/lib/patient/selfRegistration";

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

async function freshRecord(tag: string, phone: string | null) {
  return prisma.patient.create({
    data: { uhid: `SELFREG-${tag}-${run}`, facilityId: "fac-amc-pune", fullName: `Selfreg ${tag} ${run}`, sex: "F", phone, dob: new Date("1990-05-17") },
  });
}

async function main() {
  await rm(SMS_OUTBOX_FILE, { force: true });
  const reviewer = await prisma.user.findFirstOrThrow({ where: { role: "FRONT_DESK" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const before = await prisma.patient.count();

  // 1. No match.
  const a = await registerPatientAccount({ fullName: `Unmatched Person ${run}`, email: email("new"), passwordHash: "x", sex: "M", phone: "9000000001", dob: new Date("1985-01-01") });
  const aPatient = a.status === "LINKED_NEW" ? await prisma.patient.findUnique({ where: { id: a.patientId } }) : null;
  report("No likely match: a new record is created and linked", a.status === "LINKED_NEW" && aPatient?.userId === a.userId);

  // 2. Match with a phone on record → OTP.
  const rec = await freshRecord("otp", "+91 98111 22334");
  const countBefore = await prisma.patient.count();
  const b = await registerPatientAccount({ fullName: rec.fullName, email: email("otp"), passwordHash: "x", sex: "F", phone: "9811122334", dob: new Date("1990-05-17") });
  report("Likely match: verification required, phone masked", b.status === "VERIFICATION_REQUIRED" && b.maskedPhone === "••••••2334", b.status);
  report("Likely match: no record created, record not linked", (await prisma.patient.count()) === countBefore && (await prisma.patient.findUniqueOrThrow({ where: { id: rec.id } })).userId === null);
  const code = await lastCodeTo(rec.phone!);
  report("The code went to the phone on the record", code !== null);
  const wrong = await verifyLinkOtp(b.userId, code === "000000" ? "111111" : "000000");
  report("A wrong code links nothing", wrong.status === "INVALID" && (await prisma.patient.findUniqueOrThrow({ where: { id: rec.id } })).userId === null);
  const right = await verifyLinkOtp(b.userId, code ?? "");
  report("The right code links the account to the existing record", right.status === "LINKED" && (await prisma.patient.findUniqueOrThrow({ where: { id: rec.id } })).userId === b.userId);
  report("The registrant's status shows LINKED", (await linkStatusFor(b.userId))?.status === "LINKED");

  // 3. Too many wrong codes → front desk.
  const rec3 = await freshRecord("lockout", "9822233344");
  const c = await registerPatientAccount({ fullName: rec3.fullName, email: email("lock"), passwordHash: "x", sex: "F", phone: "9822233344", dob: new Date("1990-05-17") });
  const good3 = await lastCodeTo(rec3.phone!);
  const bad3 = good3 === "000000" ? "111111" : "000000";
  let last: Awaited<ReturnType<typeof verifyLinkOtp>> | null = null;
  for (let i = 0; i < 5; i++) last = await verifyLinkOtp(c.userId, bad3);
  report("Five wrong codes send the request to front-desk review", last?.status === "PENDING_REVIEW" && (await linkStatusFor(c.userId))?.status === "FRONT_DESK_REVIEW");
  const afterLock = await verifyLinkOtp(c.userId, good3 ?? "").then(() => "accepted", (e) => (e instanceof NotFoundError ? "no pending code" : String(e)));
  report("After lockout even the right code is not accepted", afterLock === "no pending code" && (await prisma.patient.findUniqueOrThrow({ where: { id: rec3.id } })).userId === null);

  // 4. Match without a phone → front desk; LINK links.
  const rec4 = await freshRecord("nophone", null);
  const d = await registerPatientAccount({ fullName: rec4.fullName, email: email("nophone"), passwordHash: "x", sex: "F", dob: new Date("1990-05-17") });
  report("No phone on the record: front-desk review", d.status === "PENDING_REVIEW");
  const req4 = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: d.userId } });
  // 7. Another facility's front desk can't see or decide it.
  const crossDecision = await decideLinkRequest({ facilityId: "fac-amc-noida", requestId: req4.id, decision: "LINK", reviewerUserId: reviewer.id }).then(() => "decided", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Another facility's front desk gets 404", crossDecision === "404");
  const decided = await decideLinkRequest({ facilityId: "fac-amc-pune", requestId: req4.id, decision: "LINK", reviewerUserId: reviewer.id });
  report("Front desk LINK links the account to the record", decided.status === "LINKED" && (await prisma.patient.findUniqueOrThrow({ where: { id: rec4.id } })).userId === d.userId);
  const audited = await prisma.auditEvent.count({ where: { type: "patient.account.linked", detail: { path: ["linkRequestId"], equals: req4.id } } });
  report("The front-desk link is audited", audited === 1);

  // 5. Matching an already-owned record → review, never linked to the new account.
  const e = await registerPatientAccount({ fullName: rec.fullName, email: email("owned"), passwordHash: "x", sex: "F", phone: "9811122334", dob: new Date("1990-05-17") });
  const ownedReq = await prisma.patientLinkRequest.findFirst({ where: { userId: e.userId } });
  report("A match that already has an account goes to front-desk review", e.status === "PENDING_REVIEW" && ownedReq?.reviewReason === "the matched record already has an account");
  report("…and stays linked to its original account", (await prisma.patient.findUniqueOrThrow({ where: { id: rec.id } })).userId === b.userId);

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
