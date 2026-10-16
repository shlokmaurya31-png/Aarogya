import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError, type DomainEventEnvelope } from "@/lib/events/types";

/**
 * notification-dispatch (workflow spine §2), step 6 scope: critical lab
 * results, critical imaging reports and missed doses. (Transfusion reactions
 * and STAT tasks join at their steps.)
 *
 * Recipients: the ordering clinician; for a missed dose also the patient's
 * currently assigned nurse. Only ACTIVE staff; a recipient who is no longer
 * active is skipped, and an event with nobody to notify is processed with no
 * notification.
 *
 * Idempotent: Notification (sourceEventId, recipientStaffId) is unique and
 * inserts skip duplicates, so redelivery creates nothing. Titles carry no
 * clinical values; the link takes the reader to the record. Re-reads what it
 * needs and checks the event's tenant on every row.
 */
type Spec = {
  facilityId: string;
  recipients: string[];
  type: string;
  title: string;
  priority: "URGENT" | "CRITICAL";
  linkHref: string;
  patientId: string;
  encounterId: string | null;
  sourceType: string;
  sourceId: string;
};

function inTenant(event: DomainEventEnvelope, facilityId: string, what: string) {
  if (facilityId !== event.facilityId) throw new PermanentEventError(`${what} is not in the event's facility.`, "TENANT_MISMATCH");
}

async function labResult(event: DomainEventEnvelope): Promise<Spec | null> {
  const p = event.payload as { resultId: string; critical?: boolean };
  if (!p.critical) return null;
  const r = await prisma.labResult.findUnique({ where: { id: p.resultId }, select: { labOrder: { select: { id: true, patientId: true, encounterId: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } } } });
  if (!r) throw new PermanentEventError(`Lab result ${p.resultId} not found.`, "NOT_FOUND");
  inTenant(event, r.labOrder.encounter.facilityId, `Lab result ${p.resultId}`);
  return {
    facilityId: r.labOrder.encounter.facilityId, recipients: [r.labOrder.orderedByStaffId], type: "CRITICAL_RESULT",
    title: "Critical lab result needs acknowledgement", priority: "CRITICAL", linkHref: "/hospital-os/lab",
    patientId: r.labOrder.patientId, encounterId: r.labOrder.encounterId, sourceType: "LabResult", sourceId: p.resultId,
  };
}

async function imagingReport(event: DomainEventEnvelope): Promise<Spec | null> {
  const p = event.payload as { reportId: string; critical?: boolean };
  if (!p.critical) return null;
  const r = await prisma.imagingReport.findUnique({ where: { id: p.reportId }, select: { imagingOrder: { select: { patientId: true, encounterId: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } } } });
  if (!r) throw new PermanentEventError(`Imaging report ${p.reportId} not found.`, "NOT_FOUND");
  inTenant(event, r.imagingOrder.encounter.facilityId, `Imaging report ${p.reportId}`);
  return {
    facilityId: r.imagingOrder.encounter.facilityId, recipients: [r.imagingOrder.orderedByStaffId], type: "CRITICAL_RESULT",
    title: "Critical imaging report needs acknowledgement", priority: "CRITICAL", linkHref: "/hospital-os/radiology",
    patientId: r.imagingOrder.patientId, encounterId: r.imagingOrder.encounterId, sourceType: "ImagingReport", sourceId: p.reportId,
  };
}

async function missedDose(event: DomainEventEnvelope): Promise<Spec> {
  const p = event.payload as { administrationId: string; orderId: string };
  const o = await prisma.medicationOrder.findUnique({ where: { id: p.orderId }, select: { patientId: true, encounterId: true, orderedByStaffId: true, encounter: { select: { facilityId: true } } } });
  if (!o) throw new PermanentEventError(`Medication order ${p.orderId} not found.`, "NOT_FOUND");
  inTenant(event, o.encounter.facilityId, `Medication order ${p.orderId}`);
  const nurse = await prisma.nursingAssignment.findFirst({ where: { patientId: o.patientId, facilityId: o.encounter.facilityId, endAt: null }, select: { nurseStaffId: true } });
  return {
    facilityId: o.encounter.facilityId, recipients: [o.orderedByStaffId, ...(nurse ? [nurse.nurseStaffId] : [])], type: "MISSED_DOSE",
    title: "A scheduled dose was not recorded", priority: "URGENT", linkHref: "/hospital-os/nurse",
    patientId: o.patientId, encounterId: o.encounterId, sourceType: "MedicationAdministration", sourceId: p.administrationId,
  };
}

export const notificationDispatch: DomainEventConsumer = {
  name: "notification-dispatch",
  handles: ["LabResultReleased", "ImagingReportReleased", "MedicationDoseMissed"],
  async handle(event) {
    const spec =
      event.eventType === "LabResultReleased" ? await labResult(event) :
      event.eventType === "ImagingReportReleased" ? await imagingReport(event) :
      event.eventType === "MedicationDoseMissed" ? await missedDose(event) :
      null;
    if (!spec) return;
    const active = await prisma.hospitalStaffProfile.findMany({ where: { id: { in: [...new Set(spec.recipients)] }, status: "ACTIVE" }, select: { id: true } });
    if (!active.length) return;
    await prisma.notification.createMany({
      skipDuplicates: true,
      data: active.map((r) => ({
        facilityId: spec.facilityId, recipientStaffId: r.id, type: spec.type, category: "CLINICAL", priority: spec.priority,
        title: spec.title, linkHref: spec.linkHref, patientId: spec.patientId, encounterId: spec.encounterId,
        sourceType: spec.sourceType, sourceId: spec.sourceId, sourceEventId: event.eventId,
      })),
    });
  },
};
