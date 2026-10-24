/**
 * Week 5c — fixtures for the insurance gates: a card key for the run, a
 * booked appointment some hours ahead at a facility, and the seeded insurer.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../../src/lib/db";

export const INSURER = "payer-demo-insurer";

export function cardKeyForRun() {
  process.env.INSURANCE_CARD_KEY_VERSION = "1";
  if (!process.env.INSURANCE_CARD_KEY_1) process.env.INSURANCE_CARD_KEY_1 = randomBytes(32).toString("base64");
}

/** A CONFIRMED appointment for a facility record, starting `hours` from now (30 minutes long). */
export async function appointmentIn(input: { patientId: string; facilityId: string; doctorStaffId: string }, hours: number) {
  const start = new Date(Date.now() + hours * 3_600_000);
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: input.facilityId }, select: { id: true } });
  return prisma.appointment.create({
    data: { facilityId: input.facilityId, departmentId: dept.id, doctorStaffId: input.doctorStaffId, patientId: input.patientId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60_000), status: "CONFIRMED", createdByStaffId: input.doctorStaffId, reason: "gate visit" },
  });
}

/** An admission (IPD encounter, a fresh bed) for a facility record. */
export async function admissionFor(patientId: string, facilityId: string, admittingStaffId: string) {
  const ward = await prisma.ward.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const bed = await prisma.bed.create({ data: { label: `INS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, wardId: ward.id, facilityId, status: "OCCUPIED" } });
  const enc = await prisma.encounter.create({ data: { patientId, facilityId, type: "IPD", status: "ADMITTED", chiefComplaint: "insurance gate" } });
  const adm = await prisma.admission.create({ data: { encounterId: enc.id, bedId: bed.id, admittingStaffId, reason: "insurance gate" } });
  return { encounterId: enc.id, admissionId: adm.id };
}

/** Posts charges (description, rupees) and issues the invoice: the itemised bill. */
export async function issueBill(input: { encounterId: string; patientId: string; facilityId: string; byUserId: string }, lines: [string, number][]) {
  const { createCharge } = await import("../../src/lib/hospital/billing/chargeCapture");
  const { draftInvoiceForAccount, addChargeToInvoice, issueInvoice } = await import("../../src/lib/hospital/billing/invoices");
  return prisma.$transaction(async (t) => {
    for (const [description, rupees] of lines) await createCharge(t, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId, description, category: "OTHER", unitPriceMinor: rupees * 100, postedByUserId: input.byUserId });
    const draft = await draftInvoiceForAccount(t, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId, generatedByUserId: input.byUserId });
    for (const c of await t.charge.findMany({ where: { encounterId: input.encounterId, status: "POSTED", invoiceLine: null }, select: { id: true } })) await addChargeToInvoice(t, draft.id, c.id);
    return issueInvoice(t, draft.id, { byUserId: input.byUserId });
  });
}
