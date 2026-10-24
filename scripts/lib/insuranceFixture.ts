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
