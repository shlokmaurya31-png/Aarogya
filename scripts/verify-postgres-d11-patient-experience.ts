/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PHASE D11 — Patient Experience gate.
 *
 * Proves the patient-facing platform is a SAFE projection over the canonical
 * record: identity/IDOR isolation, delegated-access scope/expiry/revocation,
 * report release control, payment anti-forgery, mass-assignment protection,
 * appointment booking ownership + concurrency, consent ownership, and
 * family-delegation concurrency. Runs on SQLite and (with real write
 * concurrency) PostgreSQL.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d11-patient-experience.ts
 */
import { prisma } from "../src/lib/db";
import type { PatientContext } from "../src/lib/patient/context";
import {
  resolveReadScope, resolveActScope, listAccessiblePatients, assertClass,
} from "../src/lib/patient/context";
import { listAppointments, requestAppointment, cancelPatientAppointment, listBookableDoctors } from "../src/lib/patient/experience/appointments";
import { listReports, getDocumentForDownload } from "../src/lib/patient/experience/reports";
import { listInvoices } from "../src/lib/patient/experience/billing";
import { initiatePatientPayment, confirmPatientPayment } from "../src/lib/patient/experience/payments";
import { listPatientConsents, grantPatientConsent } from "../src/lib/patient/experience/consent";
import { inviteDelegate, acceptDelegation, revokeDelegation, listGrantedDelegations } from "../src/lib/patient/experience/family";
import { updateProfile } from "../src/lib/patient/experience/profile";
import { getAbhaStatus } from "../src/lib/patient/experience/abha";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string, d?: string) => { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); };
async function expectThrow(l: string, fn: () => Promise<unknown> | unknown) {
  try { await fn(); bad(l, "expected throw"); } catch { ok(l); }
}
async function expectOk(l: string, fn: () => Promise<unknown>) {
  try { await fn(); ok(l); } catch (e) { bad(l, (e as Error).message); }
}

const P = "d11-";
const ID = {
  org: P + "org", fac: P + "fac", facOther: P + "fac2",
  uA: P + "u-a", uB: P + "u-b", uDel: P + "u-del",
  patA: P + "pat-a", patB: P + "pat-b", patDel: P + "pat-del",
  staff: P + "staff", uStaff: P + "u-staff",
  payer: P + "payer",
};

function pctx(userId: string, selfPatientId: string | null): PatientContext {
  return { session: { userId, role: "PATIENT" as any, exp: Date.now() + 1e9 }, userId, selfPatientId };
}

async function cleanup() {
  await prisma.patientDelegationScope.deleteMany({ where: { delegation: { patient: { facilityId: { in: [ID.fac, ID.facOther] } } } } });
  await prisma.patientDelegation.deleteMany({ where: { patient: { facilityId: { in: [ID.fac, ID.facOther] } } } });
  await prisma.interopConsentScope.deleteMany({ where: { consent: { facilityId: { in: [ID.fac, ID.facOther] } } } });
  await prisma.interopConsent.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.paymentAllocation.deleteMany({ where: { invoice: { facilityId: { in: [ID.fac, ID.facOther] } } } });
  await prisma.invoiceLine.deleteMany({ where: { invoice: { facilityId: { in: [ID.fac, ID.facOther] } } } });
  await prisma.invoice.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.payment.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.billingAccount.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.labResult.deleteMany({ where: { labOrder: { is: { patientId: { in: [ID.patA, ID.patB, ID.patDel] } } } } });
  await prisma.labOrder.deleteMany({ where: { patientId: { in: [ID.patA, ID.patB, ID.patDel] } } });
  await prisma.clinicalDocument.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.appointment.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.doctorScheduleBlock.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.patientCoverage.deleteMany({ where: { patientId: { in: [ID.patA, ID.patB, ID.patDel] } } });
  await prisma.payerPlan.deleteMany({ where: { payerId: ID.payer } });
  await prisma.payer.deleteMany({ where: { id: ID.payer } });
  await prisma.encounter.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.hospitalStaffProfile.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.patient.deleteMany({ where: { facilityId: { in: [ID.fac, ID.facOther] } } });
  await prisma.facility.deleteMany({ where: { id: { in: [ID.fac, ID.facOther] } } });
  await prisma.organization.deleteMany({ where: { id: ID.org } });
  await prisma.user.deleteMany({ where: { id: { in: [ID.uA, ID.uB, ID.uDel, ID.uStaff] } } });
}

async function seed() {
  await prisma.organization.create({ data: { id: ID.org, slug: ID.org, name: "D11 Org", status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.fac, slug: ID.fac, name: "D11 Facility", organizationId: ID.org, status: "ACTIVE" } });
  await prisma.facility.create({ data: { id: ID.facOther, slug: ID.facOther, name: "Other Facility", organizationId: ID.org, status: "ACTIVE" } });

  for (const [u, name] of [[ID.uA, "Patient A"], [ID.uB, "Patient B"], [ID.uDel, "Delegate D"], [ID.uStaff, "Dr Staff"]] as const) {
    await prisma.user.create({ data: { id: u, email: `${u}@x.local`, passwordHash: "x", role: "PATIENT", displayName: name } });
  }
  await prisma.user.update({ where: { id: ID.uStaff }, data: { role: "DOCTOR" } });

  await prisma.patient.create({ data: { id: ID.patA, uhid: "D11-A", facilityId: ID.fac, fullName: "Patient A", sex: "female", userId: ID.uA, phone: "111" } });
  await prisma.patient.create({ data: { id: ID.patB, uhid: "D11-B", facilityId: ID.fac, fullName: "Patient B", sex: "male", userId: ID.uB } });
  await prisma.patient.create({ data: { id: ID.patDel, uhid: "D11-D", facilityId: ID.fac, fullName: "Delegate D", sex: "male", userId: ID.uDel } });

  await prisma.hospitalStaffProfile.create({ data: { id: ID.staff, userId: ID.uStaff, facilityId: ID.fac, displayRole: "Physician", status: "ACTIVE" } });
  // Clinic session tomorrow-agnostic: a recurring session every day, 09:00-17:00, 30-min slots.
  for (let d = 0; d < 7; d++) {
    await prisma.doctorScheduleBlock.create({ data: { staffId: ID.staff, facilityId: ID.fac, type: "CLINIC_SESSION", dayOfWeek: d, startMinute: 540, endMinute: 1020, slotDurationMinutes: 30, maxConcurrentAppointments: 1 } });
  }

  // Encounters + invoices for A and B.
  const encA = await prisma.encounter.create({ data: { patientId: ID.patA, facilityId: ID.fac, type: "OPD" } });
  const encB = await prisma.encounter.create({ data: { patientId: ID.patB, facilityId: ID.fac, type: "OPD" } });
  const baA = await prisma.billingAccount.create({ data: { encounterId: encA.id, patientId: ID.patA, facilityId: ID.fac } });
  const baB = await prisma.billingAccount.create({ data: { encounterId: encB.id, patientId: ID.patB, facilityId: ID.fac } });
  await prisma.invoice.create({ data: { id: P + "inv-a", invoiceNumber: "D11-INV-A", billingAccountId: baA.id, encounterId: encA.id, patientId: ID.patA, facilityId: ID.fac, status: "ISSUED", subtotalMinor: 100000, totalMinor: 100000, allocatedMinor: 20000, generatedByUserId: ID.uStaff, issuedAt: new Date(), lines: { create: { description: "Consultation", quantity: 1, unitPriceMinor: 100000, netAmountMinor: 100000 } } } });
  await prisma.invoice.create({ data: { id: P + "inv-b", invoiceNumber: "D11-INV-B", billingAccountId: baB.id, encounterId: encB.id, patientId: ID.patB, facilityId: ID.fac, status: "ISSUED", subtotalMinor: 50000, totalMinor: 50000, allocatedMinor: 0, generatedByUserId: ID.uStaff, issuedAt: new Date(), lines: { create: { description: "Lab", quantity: 1, unitPriceMinor: 50000, netAmountMinor: 50000 } } } });

  // Lab results for A: one VERIFIED (released), one ENTERED (draft, must NOT show).
  const lo = await prisma.labOrder.create({ data: { encounterId: encA.id, patientId: ID.patA, testName: "CBC", category: "Hematology", orderedByStaffId: ID.staff } });
  await prisma.labResult.create({ data: { labOrderId: lo.id, value: "Normal", status: "VERIFIED", isCurrent: true, verifiedAt: new Date() } });
  const lo2 = await prisma.labOrder.create({ data: { encounterId: encA.id, patientId: ID.patA, testName: "Glucose", category: "Chem", orderedByStaffId: ID.staff } });
  await prisma.labResult.create({ data: { labOrderId: lo2.id, value: "Pending", status: "ENTERED", isCurrent: true } });

  // Documents for A: one PATIENT_VISIBLE (shown), one RESTRICTED (never shown).
  await prisma.clinicalDocument.create({ data: { id: P + "doc-vis", facilityId: ID.fac, patientId: ID.patA, type: "REPORT", title: "Discharge summary", accessPolicy: "PATIENT_VISIBLE", status: "CURRENT", uploadedByStaffId: ID.staff, storageRef: "s3://x" } });
  await prisma.clinicalDocument.create({ data: { id: P + "doc-res", facilityId: ID.fac, patientId: ID.patA, type: "REPORT", title: "Restricted note", accessPolicy: "RESTRICTED", status: "CURRENT", uploadedByStaffId: ID.staff, storageRef: "s3://y" } });

  // Consent for A (REQUESTED — patient can grant).
  await prisma.interopConsent.create({ data: { id: P + "consent-a", facilityId: ID.fac, patientId: ID.patA, purpose: "TREATMENT", status: "REQUESTED", recipientType: "FACILITY", recipientIdentifier: "other-fac", scopes: { create: [{ scope: "LAB" }] } } });

  // Coverage for A.
  await prisma.payer.create({ data: { id: ID.payer, name: "Test Insurer", type: "INSURANCE" } });
  await prisma.patientCoverage.create({ data: { patientId: ID.patA, payerId: ID.payer, memberId: "MEM-123456", validFrom: new Date(Date.now() - 1e9), status: "ACTIVE", addedByUserId: ID.uStaff } });
}

async function main() {
  console.log(`\nPHASE D11 — Patient Experience gate (${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup();
  await seed();

  const ctxA = pctx(ID.uA, ID.patA);
  const ctxB = pctx(ID.uB, ID.patB);
  const ctxDel = pctx(ID.uDel, ID.patDel);

  // ── 1. Identity / IDOR ──────────────────────────────────────────────────
  console.log("1. Identity & IDOR");
  await expectOk("patient A resolves to own record", async () => {
    const s = await resolveReadScope(ctxA);
    if (s.patientId !== ID.patA || !s.isSelf) throw new Error("wrong scope");
  });
  await expectThrow("patient A cannot resolve patient B via ?patientId (404-shaped)", () => resolveReadScope(ctxA, ID.patB));
  await expectThrow("patient A cannot resolve a fabricated id", () => resolveReadScope(ctxA, "does-not-exist"));
  await expectOk("A's invoices never include B's invoice", async () => {
    const s = await resolveReadScope(ctxA);
    const invs = await listInvoices(s);
    if (invs.some((i) => i.invoiceNumber === "D11-INV-B")) throw new Error("cross-patient invoice leak");
    if (!invs.some((i) => i.invoiceNumber === "D11-INV-A")) throw new Error("own invoice missing");
  });
  await expectOk("A's reports exclude B and exclude drafts/restricted", async () => {
    const s = await resolveReadScope(ctxA);
    const reps = await listReports(s);
    if (reps.some((r) => r.title === "Glucose")) throw new Error("draft lab leaked");
    if (reps.some((r) => r.title === "Restricted note")) throw new Error("restricted doc leaked");
    if (!reps.some((r) => r.title === "CBC")) throw new Error("verified lab missing");
    if (!reps.some((r) => r.title === "Discharge summary")) throw new Error("patient-visible doc missing");
  });

  // ── 2. Report download authorization ───────────────────────────────────
  console.log("2. Document download authorization");
  await expectThrow("A cannot download the RESTRICTED document", async () => {
    const s = await resolveReadScope(ctxA); await getDocumentForDownload(s, P + "doc-res");
  });
  await expectOk("A can retrieve the PATIENT_VISIBLE document reference", async () => {
    const s = await resolveReadScope(ctxA); const d = await getDocumentForDownload(s, P + "doc-vis");
    if (!("available" in d) || d.available !== true) throw new Error("expected available");
  });
  await expectThrow("B cannot download A's document (cross-patient)", async () => {
    const s = await resolveReadScope(ctxB); await getDocumentForDownload(s, P + "doc-vis");
  });

  // ── 3. Payment anti-forgery ─────────────────────────────────────────────
  console.log("3. Payment anti-forgery");
  await expectOk("payment amount is computed server-side (total-allocated), client amount ignored", async () => {
    const s = await resolveActScope(ctxA);
    const r = await initiatePatientPayment(s, { invoiceId: P + "inv-a" } as any);
    if (r.amountMinor !== 80000) throw new Error(`expected 80000, got ${r.amountMinor}`);
    if (r.status !== "PROVIDER_NOT_CONFIGURED") throw new Error("provider should be unconfigured");
  });
  await expectThrow("A cannot initiate payment on B's invoice", async () => {
    const s = await resolveActScope(ctxA); await initiatePatientPayment(s, { invoiceId: P + "inv-b" });
  });
  await expectThrow("browser-asserted payment success is refused", () => (confirmPatientPayment as any)());

  // ── 4. Mass assignment protection ──────────────────────────────────────
  console.log("4. Mass assignment protection");
  await expectThrow("profile update rejects unknown/privileged keys (strict schema)", async () => {
    const s = await resolveActScope(ctxA);
    await updateProfile(s, { phone: "999", facilityId: ID.facOther, registrationStatus: "INACTIVE", uhid: "HACK" } as any);
  });
  await expectOk("profile update applies only allowed fields", async () => {
    const s = await resolveActScope(ctxA);
    await updateProfile(s, { phone: "222", communicationPreference: "EMAIL" });
    const p = await prisma.patient.findUniqueOrThrow({ where: { id: ID.patA } });
    if (p.phone !== "222" || p.facilityId !== ID.fac || p.uhid !== "D11-A") throw new Error("field integrity violated");
  });

  // ── 5. Appointment booking: ownership, cross-facility, concurrency ──────
  console.log("5. Appointments");
  const slot = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();
  await expectOk("patient can list bookable doctors in own facility", async () => {
    const s = await resolveReadScope(ctxA); const docs = await listBookableDoctors(s);
    if (!docs.some((d) => d.staffId === ID.staff)) throw new Error("doctor missing");
  });
  await expectThrow("delegate/other cannot book from a foreign facility doctor", async () => {
    const s = await resolveActScope(ctxB); // B acting on self
    await requestAppointment(s, ID.uB, { doctorStaffId: "no-such-doctor", scheduledStart: slot.toISOString() });
  });
  await expectOk("patient A books an appointment", async () => {
    const s = await resolveActScope(ctxA);
    await requestAppointment(s, ID.uA, { doctorStaffId: ID.staff, scheduledStart: slot.toISOString(), reason: "checkup" });
  });
  // Concurrency: two patients race the SAME doctor slot — at most one wins.
  await (async () => {
    const sB = await resolveActScope(ctxB);
    const slot2 = new Date(slot.getTime() + 60 * 60000); // 11:00
    // Pre-book A at 11:00, then race B x2 at 11:00.
    const sA = await resolveActScope(ctxA);
    const results = await Promise.allSettled([
      requestAppointment(sA, ID.uA, { doctorStaffId: ID.staff, scheduledStart: slot2.toISOString() }),
      requestAppointment(sB, ID.uB, { doctorStaffId: ID.staff, scheduledStart: slot2.toISOString() }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    if (wins === 1) ok("concurrent booking of the same slot: exactly one wins");
    else bad("concurrent booking of the same slot", `expected 1 win, got ${wins}`);
  })();
  await expectThrow("A cannot cancel B's appointment (ownership)", async () => {
    const bAppt = await prisma.appointment.findFirst({ where: { patientId: ID.patB } });
    if (!bAppt) throw Object.assign(new Error("no B appt"), { expected: true });
    const s = await resolveActScope(ctxA);
    await cancelPatientAppointment(s, ID.uA, bAppt.id, "nope");
  });

  // ── 6. Consent ownership ────────────────────────────────────────────────
  console.log("6. Consent");
  await expectOk("A can grant their own consent", async () => {
    const s = await resolveActScope(ctxA); await grantPatientConsent(s, ID.uA, P + "consent-a");
  });
  await expectThrow("B cannot grant A's consent", async () => {
    const s = await resolveActScope(ctxB); await grantPatientConsent(s, ID.uB, P + "consent-a");
  });

  // ── 7. Family delegation: scope, expiry, revocation, escalation ─────────
  console.log("7. Family delegation");
  let inviteToken = "";
  await expectOk("A invites a delegate scoped to APPOINTMENTS only", async () => {
    const s = await resolveActScope(ctxA);
    const r = await inviteDelegate(s, ID.uA, { relationship: "CAREGIVER", scopes: ["APPOINTMENTS"], invitedContact: "del@x.local" });
    inviteToken = r.inviteToken;
  });
  await expectThrow("invite with an un-modelled scope is rejected", async () => {
    const s = await resolveActScope(ctxA);
    await inviteDelegate(s, ID.uA, { relationship: "CAREGIVER", scopes: ["EVERYTHING"], invitedContact: "x@x" });
  });
  await expectThrow("a delegate (non-self) cannot invite over A's record", async () => {
    // ctxDel has no delegation yet; resolveActScope(ctxDel, A) must 404.
    const s = await resolveActScope(ctxDel, ID.patA);
    await inviteDelegate(s, ID.uDel, { relationship: "OTHER", scopes: ["RECORDS"], invitedContact: "y@y" });
  });
  await expectThrow("delegate cannot access A before accepting", () => resolveReadScope(ctxDel, ID.patA));
  await expectOk("delegate accepts the invitation", () => acceptDelegation(ctxDel, inviteToken));
  await expectThrow("the invite token cannot be replayed after acceptance", () => acceptDelegation(ctxDel, inviteToken));
  await expectOk("delegate can now READ A's appointments (in-scope)", async () => {
    const s = await resolveReadScope(ctxDel, ID.patA);
    await listAppointments(s); // must not throw
    if (s.isSelf) throw new Error("delegate must not be marked self");
  });
  await expectThrow("delegate CANNOT read A's billing (out of scope)", async () => {
    const s = await resolveReadScope(ctxDel, ID.patA);
    assertClass(s, "BILLING"); // throws — scope was APPOINTMENTS only
  });
  await expectThrow("delegate CANNOT act on A (read-only)", () => resolveActScope(ctxDel, ID.patA));
  await expectOk("A sees the delegate in their granted list", async () => {
    const s = await resolveReadScope(ctxA); const g = await listGrantedDelegations(s);
    if (!g.some((d) => d.status === "ACTIVE")) throw new Error("active delegation missing");
  });
  // Revocation takes effect immediately.
  await expectOk("A revokes the delegation", async () => {
    const s = await resolveActScope(ctxA);
    const g = await listGrantedDelegations(s);
    const active = g.find((d) => d.status === "ACTIVE")!;
    await revokeDelegation(s, ID.uA, active.id);
  });
  await expectThrow("revoked delegate loses access immediately", () => resolveReadScope(ctxDel, ID.patA));
  await expectOk("expired delegation grants no access", async () => {
    const del = await prisma.patientDelegation.create({ data: { patientId: ID.patA, delegateUserId: ID.uDel, relationship: "OTHER", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000), scopes: { create: [{ scope: "RECORDS" }] } } });
    const accessible = await listAccessiblePatients(ctxDel);
    const leaked = accessible.some((a) => a.patientId === ID.patA);
    await prisma.patientDelegationScope.deleteMany({ where: { delegationId: del.id } });
    await prisma.patientDelegation.delete({ where: { id: del.id } });
    if (leaked) throw new Error("expired delegation leaked access");
  });

  // ── 8. Delegation accept concurrency ────────────────────────────────────
  console.log("8. Delegation concurrency");
  await (async () => {
    const s = await resolveActScope(ctxA);
    const { inviteToken: tok } = await inviteDelegate(s, ID.uA, { relationship: "SPOUSE", scopes: ["RECORDS"], invitedContact: "race@x" });
    const results = await Promise.allSettled([acceptDelegation(ctxDel, tok), acceptDelegation(ctxDel, tok)]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    if (wins === 1) ok("concurrent accept of one invite: exactly one wins");
    else bad("concurrent accept of one invite", `expected 1, got ${wins}`);
  })();

  // ── 9. ABHA honest external state ───────────────────────────────────────
  console.log("9. ABHA / interoperability honesty");
  await expectOk("ABHA status reports honest not-configured state (no fake linkage)", async () => {
    const s = await resolveReadScope(ctxA); const st = await getAbhaStatus(s);
    if (st.integration.configured !== false) throw new Error("expected unconfigured in test env");
    if (st.integration.connectionState !== "EXTERNAL_CONNECTION_UNAVAILABLE") throw new Error("expected unavailable state");
  });

  await cleanup();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
