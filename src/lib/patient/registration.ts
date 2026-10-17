import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { facilityOrganizationId } from "@/lib/events/tenant";
import { createPatientWithUhid } from "@/lib/hospital/uhid";
import { estimatedDobFromAge } from "@/lib/patient/age";

type Tx = Prisma.TransactionClient;

/**
 * Every new Patient record is created here, in the caller's transaction, with
 * PatientRegistered emitted in that same transaction (workflow spine §1.1:
 * the event used to be emitted from a route handler, and patient
 * self-registration created records without it).
 */
export async function createRegisteredPatient(tx: Tx, input: {
  facilityId: string;
  uhid: string;
  fullName: string;
  sex: string;
  phone?: string | null;
  bloodGroup?: string | null;
  dob?: Date | null;
  dobPrecision?: "DAY" | "MONTH" | "YEAR" | "ESTIMATED_FROM_AGE";
  userId?: string | null;
  actorUserId?: string | null;
  /** Phase 0: staff entered the phone with the patient present (never true for self-registration). */
  phoneConfirmed?: boolean;
}) {
  const patient = await tx.patient.create({
    data: {
      uhid: input.uhid,
      facilityId: input.facilityId,
      fullName: input.fullName,
      sex: input.sex,
      phone: input.phone ?? undefined,
      bloodGroup: input.bloodGroup ?? undefined,
      dob: input.dob ?? undefined,
      ...(input.dobPrecision ? { dobPrecision: input.dobPrecision } : {}),
      userId: input.userId ?? undefined,
      ...(input.phoneConfirmed && input.phone ? { phoneConfirmedAt: new Date(), phoneSetByStaffAt: new Date() } : {}),
    },
  });
  await emitDomainEvent(tx, {
    type: "PatientRegistered",
    aggregateId: patient.id,
    organizationId: await facilityOrganizationId(tx, input.facilityId),
    facilityId: input.facilityId,
    actorUserId: input.actorUserId ?? null,
    payload: { patientId: patient.id, uhid: patient.uhid },
  });
  return patient;
}

/**
 * Front-desk registration (POST /api/hospital/patients). An age given instead
 * of a date of birth is recorded as an estimated dob.
 */
export async function registerPatient(input: {
  facilityId: string;
  byUserId: string;
  fullName: string;
  sex: string;
  ageYears?: number;
  phone?: string;
  bloodGroup?: string;
}) {
  const patient = await createPatientWithUhid(input.facilityId, (uhid) =>
    prisma.$transaction((tx) =>
      createRegisteredPatient(tx, {
        facilityId: input.facilityId,
        uhid,
        fullName: input.fullName,
        sex: input.sex,
        phone: input.phone,
        bloodGroup: input.bloodGroup,
        ...(input.ageYears !== undefined ? { dob: estimatedDobFromAge(input.ageYears), dobPrecision: "ESTIMATED_FROM_AGE" as const } : {}),
        actorUserId: input.byUserId,
        // The front desk entered the phone with the patient present (Phase 0: confirmed).
        phoneConfirmed: true,
      })
    )
  );
  await recordAuditEvent("hospital.patient.registered", input.byUserId, { patientId: patient.id }, { facilityId: input.facilityId, patientId: patient.id });
  return patient;
}
