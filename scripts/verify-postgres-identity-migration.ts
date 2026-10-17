/**
 * Phase 0, part 1 (d): the identity migration refuses rather than guesses
 * (src/lib/person/migration.ts). Fixtures recreate pre-Phase-0 state
 * directly (accounts linked through the retired Patient.userId):
 *
 *   U1 sign-up created its record          → ACTIVE, SELF_CREATED
 *   U2 linked by a code on the record      → ACTIVE, OTP_RECORD_CONTACT
 *   U3 linked by a front-desk decision     → REVERIFICATION_REQUIRED
 *   U4 linked with no evidence             → REVERIFICATION_REQUIRED
 *   U5 linked to a record since merged     → refused, untouched
 *   U6 no record, an old open code request → Person; request re-routed
 *   U7 record already linked to a Person   → refused, untouched
 *
 * Checks: the dry run writes nothing; the run's report and rows; events;
 * Patient.userId cleared only where migrated; old uploads owned by the
 * Person and still visible to their facility until the person chooses
 * (then hidden on "no"); a second run changes nothing; a REVERIFICATION
 * link becomes ACTIVE in place through the normal second-factor + code flow.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-identity-migration.ts
 */
process.env.SMS_PROVIDER = "outbox";

import { readFile, rm } from "node:fs/promises";
import { prisma } from "../src/lib/db";
import { SMS_OUTBOX_FILE } from "../src/lib/messaging/sms";
import { migrateIdentities } from "../src/lib/person/migration";
import { staffDocumentVisibility } from "../src/lib/person/access";
import { decidePersonConsent } from "../src/lib/person/consent";
import { startReverification, submitSecondFactor, verifyLinkCode } from "../src/lib/person/linking";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const run = Date.now().toString(36);
const facilityId = "fac-amc-pune";

async function lastCodeTo(phone: string): Promise<string | null> {
  const lines = (await readFile(SMS_OUTBOX_FILE, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).reverse();
  for (const l of lines) {
    const m = JSON.parse(l) as { to: string; text: string };
    if (m.to.replace(/\D/g, "").endsWith(phone.replace(/\D/g, "").slice(-10))) return /\b(\d{6})\b/.exec(m.text)?.[1] ?? null;
  }
  return null;
}

async function main() {
  await rm(SMS_OUTBOX_FILE, { force: true });
  const desk = await prisma.user.findFirstOrThrow({ where: { role: "FRONT_DESK" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const account = (tag: string) => prisma.user.create({ data: { email: `idmig-${tag}-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: `Idmig ${tag}` } });
  const record = (tag: string, data: Record<string, unknown> = {}) =>
    prisma.patient.create({ data: { uhid: `IDMIG-${tag}-${run}`, facilityId, fullName: `Idmig ${tag} ${run}`, sex: "F", dob: new Date("1988-03-04"), ...data } });
  const request = (userId: string, patientId: string | null, status: "LINKED" | "OTP_SENT", resolvedByUserId: string | null) =>
    prisma.patientLinkRequest.create({ data: {
      userId, facilityId, candidatePatientId: patientId, status, resolvedByUserId, resolvedAt: status === "LINKED" ? new Date() : null,
      otpHash: status === "OTP_SENT" ? "stale-hash" : null, matchConfidence: "HIGH", matchScore: 90, matchedOn: ["name"], claimedName: "x", claimedSex: "F",
    } });

  // ── Fixtures: pre-Phase-0 state ──
  const [u1, u2, u3, u4, u5, u6, u7, uOther] = await Promise.all(["self", "code", "desk", "none", "merged", "norecord", "taken", "other"].map(account));
  const p1 = await record("self", { userId: u1.id });
  await prisma.auditEvent.create({ data: { type: "patient.account.registered", userId: u1.id, detail: { patientId: p1.id, facilityId }, facilityId, patientId: p1.id } });
  const p2 = await record("code", { userId: u2.id });
  await request(u2.id, p2.id, "LINKED", null);
  const p3 = await record("desk", { userId: u3.id });
  await request(u3.id, p3.id, "LINKED", desk.id);
  const p4phone = `97${String(Date.now()).slice(-8)}`;
  const p4 = await record("none", { userId: u4.id, phone: p4phone, phoneConfirmedAt: new Date() });
  const p6 = await record("mergetarget");
  const p5 = await record("merged", { userId: u5.id, mergedIntoId: p6.id, mergedAt: new Date() });
  const p7 = await record("candidate", { phone: "9700000007" });
  await request(u6.id, p7.id, "OTP_SENT", null);
  const p8 = await record("taken", { userId: u7.id });
  const other = await prisma.person.create({ data: { displayName: "Other", accounts: { create: { userId: uOther.id, role: "OWNER" } } } });
  await prisma.personPatientLink.create({ data: { personId: other.id, patientId: p8.id, facilityId, status: "ACTIVE", method: "SELF_CREATED", linkedAt: new Date(), linkedByUserId: uOther.id } });
  const d1 = await prisma.clinicalDocument.create({ data: { facilityId, patientId: p1.id, type: "REPORT", title: `Old upload ${run}`, accessPolicy: "PATIENT_VISIBLE", uploadedByUserId: u1.id } });
  const d4 = await prisma.clinicalDocument.create({ data: { facilityId, patientId: p4.id, type: "REPORT", title: `Old upload 4 ${run}`, accessPolicy: "PATIENT_VISIBLE", uploadedByUserId: u4.id } });
  const ours = [u1, u2, u3, u4, u5, u6, u7].map((u) => u.id);
  const visibleToFacility = async (docId: string, patientId: string) =>
    (await prisma.clinicalDocument.count({ where: { AND: [{ id: docId }, await staffDocumentVisibility(facilityId, [patientId])] } })) === 1;
  report("Before migration, an old upload is visible to its facility (the pre-Phase-0 rule)", await visibleToFacility(d1.id, p1.id));

  // ── Dry run ──
  const personsBefore = await prisma.person.count();
  const dry = await migrateIdentities({ dryRun: true, onlyUserIds: ours });
  report("The dry run writes nothing", (await prisma.person.count()) === personsBefore && (await prisma.patient.findUniqueOrThrow({ where: { id: p1.id } })).userId === u1.id);
  report("…and plans: 2 ACTIVE (self-created, code), 2 to reverify (desk, no evidence), 1 without a record, 2 refused",
    dry.linksActive.SELF_CREATED === 1 && dry.linksActive.OTP_RECORD_CONTACT === 1 && dry.linksReverificationRequired.FRONT_DESK_LINK === 1
      && dry.linksReverificationRequired.NO_EVIDENCE === 1 && dry.accountsWithoutRecord === 1 && dry.refusals.length === 2, JSON.stringify(dry));

  // ── Run ──
  const res = await migrateIdentities({ dryRun: false, onlyUserIds: ours });
  report("The run matches the plan", JSON.stringify({ ...res, dryRun: true }) === JSON.stringify(dry), JSON.stringify(res));
  const personOf = async (userId: string) => (await prisma.personAccount.findUnique({ where: { userId } }))?.personId ?? null;
  const linkOf = (patientId: string) => prisma.personPatientLink.findFirst({ where: { patientId, status: { in: ["ACTIVE", "REVERIFICATION_REQUIRED"] } } });
  const l1 = await linkOf(p1.id); const l2 = await linkOf(p2.id); const l3 = await linkOf(p3.id); const l4 = await linkOf(p4.id);
  report("U1 (sign-up created the record): ACTIVE, SELF_CREATED", l1?.status === "ACTIVE" && l1.method === "SELF_CREATED" && l1.personId === (await personOf(u1.id)));
  report("U2 (code on the record): ACTIVE, OTP_RECORD_CONTACT", l2?.status === "ACTIVE" && l2.method === "OTP_RECORD_CONTACT" && l2.personId === (await personOf(u2.id)));
  report("U3 (front-desk link) and U4 (no evidence): REVERIFICATION_REQUIRED, no method",
    l3?.status === "REVERIFICATION_REQUIRED" && l4?.status === "REVERIFICATION_REQUIRED" && !l3.method && !l4.method);
  const refused = new Map(res.refusals.map((r) => [r.userId, r.reason]));
  report("U5 (merged record) refused, nothing written", refused.get(u5.id) === "MERGED_RECORD" && (await personOf(u5.id)) === null && (await prisma.patient.findUniqueOrThrow({ where: { id: p5.id } })).userId === u5.id);
  report("U7 (record already linked) refused, nothing written", refused.get(u7.id) === "RECORD_ALREADY_LINKED" && (await personOf(u7.id)) === null && (await prisma.patient.findUniqueOrThrow({ where: { id: p8.id } })).userId === u7.id);
  report("Patient.userId cleared where migrated",
    (await prisma.patient.count({ where: { id: { in: [p1.id, p2.id, p3.id, p4.id] }, userId: { not: null } } })) === 0);
  const r6 = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: u6.id } });
  report("U6: a Person; the old open code request re-routed (unconfirmed phone → in person), the old code discarded",
    (await personOf(u6.id)) !== null && r6.personId === (await personOf(u6.id)) && r6.status === "IN_PERSON_REQUIRED" && r6.otpHash === null);
  const migratedPersons = (await prisma.personAccount.findMany({ where: { userId: { in: ours } }, select: { personId: true } })).map((p) => p.personId);
  const created = await prisma.domainEventOutbox.findMany({ where: { eventType: "PersonCreated", aggregateId: { in: migratedPersons } } });
  report("PersonCreated (source MIGRATION) once per migrated account", created.length === 5 && created.every((e) => (e.payload as { source: string }).source === "MIGRATION"));
  const reverify = await prisma.domainEventOutbox.count({ where: { eventType: "PersonLinkReverificationRequired", aggregateId: { in: [l3!.id, l4!.id] } } });
  const linkedEv = await prisma.domainEventOutbox.count({ where: { eventType: "PersonPatientLinked", aggregateId: { in: [l1!.id, l2!.id] } } });
  report("PersonPatientLinked for the trusted links, PersonLinkReverificationRequired for the others", linkedEv === 2 && reverify === 2);

  // ── Old uploads: owned, still visible to their facility until the person chooses ──
  const d1After = await prisma.clinicalDocument.findUniqueOrThrow({ where: { id: d1.id } });
  report("Old uploads now belong to the uploader's Person, flagged as pre-Phase-0", d1After.personId === (await personOf(u1.id)) && d1After.legacyFacilityVisible === true);
  report("…and stay visible to the facility they were uploaded to (no choice yet)", await visibleToFacility(d1.id, p1.id));
  report("…including for a link awaiting reverification", await visibleToFacility(d4.id, p4.id));
  await decidePersonConsent({ userId: u1.id, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED" });
  report("Once the person declines, the old upload is hidden from the facility", !(await visibleToFacility(d1.id, p1.id)));

  // ── Idempotent ──
  const again = await migrateIdentities({ dryRun: false, onlyUserIds: ours });
  report("A second run changes nothing (5 already migrated, the 2 refusals again)", again.alreadyMigrated === 5 && again.personsCreated === 0 && again.refusals.length === 2 && (await prisma.person.count()) === personsBefore + 5);

  // ── Reverification through the normal flow ──
  const rv = await startReverification(u4.id, l4!.id);
  report("Reverifying U4 routes to the second factor (its phone was confirmed recently)", rv.status === "SECOND_FACTOR_REQUIRED");
  const sf = await submitSecondFactor(u4.id, { kind: "UHID", value: p4.uhid });
  const code = await lastCodeTo(p4phone);
  const done = await verifyLinkCode(u4.id, code ?? "");
  const l4After = await prisma.personPatientLink.findUniqueOrThrow({ where: { id: l4!.id } });
  report("…and the same link becomes ACTIVE in place after the UHID and the code", sf.status === "CODE_SENT" && done.status === "LINKED" && l4After.status === "ACTIVE" && l4After.method === "OTP_RECORD_CONTACT");
  report("…with no second live link for the record", (await prisma.personPatientLink.count({ where: { patientId: p4.id, status: { in: ["ACTIVE", "PENDING_VERIFICATION", "REVERIFICATION_REQUIRED"] } } })) === 1);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
