import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { notifyPersonAndProxiesTx } from "./claimDocuments";
import { CHECKIN_OPENS_HOURS, CHECKIN_CLOSES_HOURS } from "./vocab";

/**
 * Week 5c — telling the patient (docs/PATIENT_INSURANCE_DESIGN.md §5):
 * patient-insurance-notify writes a person notification (and one for each
 * household proxy with INSURANCE) when a pre-authorization, a cashless
 * decision at discharge, a bill or a claim changes. The text carries no
 * amounts, diagnoses or names: they open the app. One per event and person.
 * The person-notifier delivers it.
 */
const INSURANCE_EVENTS = ["PreauthStatusChanged", "PreauthDecided", "DischargeInitiated", "ClaimSubmitted", "ClaimStatusChanged", "ClaimSettled", "HospitalInvoiceIssued"] as const;

async function personOfPatient(patientId: string): Promise<string | null> {
  return (await prisma.personPatientLink.findFirst({ where: { patientId: { in: await resolvePatientIdsForRead(patientId) }, status: "ACTIVE" }, select: { personId: true } }))?.personId ?? null;
}

export const patientInsuranceNotify: DomainEventConsumer = {
  name: "patient-insurance-notify",
  handles: [...INSURANCE_EVENTS],
  async handle(event) {
    const p = event.payload as { patientId?: string; encounterId?: string; stage?: string; to?: string };
    // A settlement is news once (SETTLED), not at each reconciliation step; a draft claim isn't news.
    if (event.eventType === "ClaimSettled" && p.stage !== "SETTLED") return;
    let patientId = p.patientId;
    if (!patientId && p.encounterId) patientId = (await prisma.encounter.findUnique({ where: { id: p.encounterId }, select: { patientId: true } }))?.patientId;
    if (!patientId) return;
    if (event.eventType === "DischargeInitiated") {
      // Cashless at discharge: only for an admission with a pre-authorization.
      const enc = p.encounterId ? await prisma.encounter.findUnique({ where: { id: p.encounterId }, select: { _count: { select: { preAuthorizations: true } } } }) : null;
      if (!enc?._count.preAuthorizations) return;
    }
    const personId = await personOfPatient(patientId);
    if (!personId) return;
    const kind = event.eventType === "HospitalInvoiceIssued" ? "BILL_READY" : "INSURANCE_UPDATE";
    await prisma.$transaction((tx) => notifyPersonAndProxiesTx(tx, personId, kind, `${kind}:${event.eventId}`));
  },
};

/**
 * Runner sweep: when pre-arrival check-in opens for a booked visit (24 hours
 * before), the patient (or, for a child without a login, their proxies with
 * BOOK) is told once.
 */
export async function sweepCheckInOpen(now = new Date()) {
  const from = new Date(now.getTime() + CHECKIN_CLOSES_HOURS * 3_600_000);
  const to = new Date(now.getTime() + CHECKIN_OPENS_HOURS * 3_600_000);
  const appts = await prisma.appointment.findMany({ where: { status: { in: ["REQUESTED", "CONFIRMED", "RESCHEDULED"] }, scheduledStart: { gt: from, lte: to } }, select: { id: true, patientId: true }, take: 500 });
  let queued = 0;
  for (const a of appts) {
    if (await prisma.preArrivalCheckIn.findUnique({ where: { appointmentId: a.id }, select: { id: true } })) continue;
    const personId = await personOfPatient(a.patientId);
    if (!personId) continue;
    const before = await prisma.personNotification.count({ where: { dedupeKey: { startsWith: `CHECKIN_OPEN:${a.id}:` } } });
    if (before) continue;
    await prisma.$transaction((tx) => notifyPersonAndProxiesTx(tx, personId, "CHECKIN_OPEN", `CHECKIN_OPEN:${a.id}`, "BOOK")).catch((err) => {
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
    queued += 1;
  }
  return { queued };
}
