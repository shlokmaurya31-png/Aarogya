import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { getAvailableSlots } from "@/lib/hospital/doctorSchedule";

/**
 * Week 5a — the next-slot projection (docs/DOCTOR_NETWORK_DESIGN.md §6.3).
 * DoctorNextSlot is read by search only; the booking screen asks the engine
 * live and bookAppointment decides under the doctor's lock, so a stale row can
 * never double-book. Refreshed by the directory-slots consumer on appointment
 * changes and on PracticeLocationChanged, and by the runner's sweep as the
 * backstop (schedule blocks and absences change without an event today).
 */
export const NEXT_SLOT_HORIZON_DAYS = 14;

export async function refreshNextSlot(locationId: string, now = new Date()): Promise<Date | null> {
  const loc = await prisma.practiceLocation.findUnique({ where: { id: locationId }, select: { id: true, staffId: true, facilityId: true, active: true } });
  if (!loc) return null;
  let next: Date | null = null;
  if (loc.active) {
    for (let i = 0; i < NEXT_SLOT_HORIZON_DAYS && !next; i++) {
      const day = new Date(now.getTime() + i * 86_400_000);
      const slot = (await getAvailableSlots(loc.staffId, day, { facilityId: loc.facilityId })).find((s) => Date.parse(s.start) > now.getTime());
      if (slot) next = new Date(slot.start);
    }
  }
  await prisma.doctorNextSlot.upsert({ where: { practiceLocationId: loc.id }, create: { practiceLocationId: loc.id, nextSlotAt: next, refreshedAt: now }, update: { nextSlotAt: next, refreshedAt: now } });
  return next;
}

/** The locations a staff profile's appointments affect (one doctor, one or more places). */
async function locationsOfStaff(staffId: string) {
  return (await prisma.practiceLocation.findMany({ where: { staffId }, select: { id: true } })).map((l) => l.id);
}

/** Runner sweep: refresh every active location whose projection is older than `maxAgeMs` (default 6 hours). */
export async function sweepNextSlots(opts: { now?: Date; maxAgeMs?: number; batchSize?: number } = {}): Promise<{ refreshed: number }> {
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - (opts.maxAgeMs ?? 6 * 3_600_000));
  const due = await prisma.practiceLocation.findMany({
    where: { active: true, OR: [{ nextSlot: null }, { nextSlot: { refreshedAt: { lt: stale } } }, { nextSlot: { nextSlotAt: { lt: now } } }] },
    select: { id: true }, take: opts.batchSize ?? 100,
  });
  for (const l of due) await refreshNextSlot(l.id, now);
  return { refreshed: due.length };
}

export const directorySlots: DomainEventConsumer = {
  name: "directory-slots",
  handles: ["AppointmentBooked", "AppointmentCancelled", "AppointmentStatusChanged", "PracticeLocationChanged"],
  async handle(event) {
    const p = event.payload as Record<string, unknown>;
    if (event.eventType === "PracticeLocationChanged") {
      await refreshNextSlot(String(p.locationId));
      return;
    }
    const staffId = typeof p.doctorStaffId === "string"
      ? p.doctorStaffId
      : (await prisma.appointment.findUnique({ where: { id: String(p.appointmentId) }, select: { doctorStaffId: true } }))?.doctorStaffId;
    if (!staffId) return;
    for (const id of await locationsOfStaff(staffId)) await refreshNextSlot(id);
  },
};
