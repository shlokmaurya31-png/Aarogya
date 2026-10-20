/**
 * Week 5a — booking through the directory, with a record share
 * (docs/DOCTOR_NETWORK_DESIGN.md §7, §10):
 *   - a booking lands on the location's facility and staff profile, on a slot
 *     the engine offers; a time it doesn't offer is refused;
 *   - concurrent bookings of one slot: exactly one wins (the doctor's lock);
 *   - a stale next-slot projection never double-books;
 *   - at a facility where the patient has no record, one is created from
 *     their Person (SELF_CREATED, by their own action) and linked;
 *   - the attached share: kind BOOKING, the doctor and facility as recipient,
 *     the categories chosen (default: every non-sensitive one, uploads in),
 *     valid from a day before the slot to a day after; the doctor's view and
 *     AI read it inside that window and not before it; another doctor never;
 *   - cancelling the appointment ends the share (APPOINTMENT_CANCELLED), with
 *     its event, and the doctor reads nothing at once;
 *   - VIDEO books a TELEMEDICINE appointment; a mode the location lacks is refused;
 *   - a doctor's own patient login can't book them (the same human), and a
 *     doctor's tools never open their own record through a share;
 *   - DirectoryBookingCreated in the booking's transaction.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-directory-booking.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { bookThroughDirectory, cancelOwnDirectoryBooking, doctorSharedBookings } from "../src/lib/doctors/booking";
import { locationSlots } from "../src/lib/doctors/directory";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { askAi } from "../src/lib/rag/ask";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { NOIDA, PUNE, drain, eventsOf, lab, notFound, refused, reporter, sharer, tag } from "./lib/shareFixture";
import { facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");

async function main() {
  registerAllConsumers();
  const v = await verifier();
  const admin = await facilityAdmin(NOIDA);
  const doc = await networkDoctor(NOIDA, v, admin, { name: `Dr Book ${tag}`, specialties: ["GENERAL_MEDICINE"], modes: ["IN_PERSON", "VIDEO"] });
  const doc2 = await networkDoctor(NOIDA, v, admin, { name: `Dr Other ${tag}`, specialties: ["GENERAL_MEDICINE"] });
  const P = await sharer();
  await lab(P.pune, P.punEnc, "Haemoglobin", `10.2 dirlab${tag}`);
  await drain();
  const day = (await prisma.doctorNextSlot.findUniqueOrThrow({ where: { practiceLocationId: doc.locationId! } })).nextSlotAt!;
  const slots = await locationSlots(doc.locationId!, day);
  const [s1, s2, s3, s4] = slots;

  // 1. Booking at a facility where the patient has no record.
  report("The patient has no Noida record before booking", (await prisma.personPatientLink.count({ where: { personId: P.personId, facilityId: NOIDA } })) === 0);
  report("A time the engine doesn't offer is refused", await refused(bookThroughDirectory(P.userId, { locationId: doc.locationId, start: new Date(Date.parse(s1.start) + 7 * 60_000).toISOString() })));
  const b1 = await bookThroughDirectory(P.userId, { locationId: doc.locationId, start: s1.start, reason: "Fatigue", share: {} });
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: b1.appointmentId } });
  const noidaLink = await prisma.personPatientLink.findFirst({ where: { personId: P.personId, facilityId: NOIDA, status: "ACTIVE" } });
  report("Booking creates the patient's Noida record from their Person (SELF_CREATED) and lands on it", !!noidaLink && noidaLink.method === "SELF_CREATED" && appt.patientId === noidaLink.patientId);
  report("…on the location's facility and the doctor's staff profile, at the slot", appt.facilityId === NOIDA && appt.doctorStaffId === doc.staffId && appt.scheduledStart.toISOString() === s1.start && appt.type === "NEW");
  report("…with DirectoryBookingCreated in the same transaction", (await eventsOf(b1.bookingId, "DirectoryBookingCreated")).length === 1 && (await eventsOf(b1.appointmentId, "AppointmentBooked")).length === 1);
  const share = await prisma.recordShare.findUniqueOrThrow({ where: { id: b1.shareId! } });
  report("The share: BOOKING, ACTIVE, for that doctor at Noida, the default categories (uploads in, notes out, nothing sensitive)",
    share.kind === "BOOKING" && share.status === "ACTIVE" && share.recipientUserId === doc.userId && share.recipientFacilityId === NOIDA && share.categories.includes("UPLOADS") && !share.categories.includes("CLINICAL_NOTES") && share.sensitiveCategories.length === 0);
  report("…valid from a day before the slot to a day after it", share.validFrom!.getTime() === appt.scheduledStart.getTime() - 86_400_000 && share.expiresAt.getTime() === appt.scheduledEnd.getTime() + 86_400_000);
  report("…with RecordShareCreated (v2, kind BOOKING)", (await eventsOf(share.id, "RecordShareCreated")).some((e) => e.eventVersion === 2 && (e.payload as { kind?: string }).kind === "BOOKING"));

  // 2. Reading through it.
  const actor = { userId: doc.userId, facilityId: NOIDA, role: "DOCTOR" };
  const inWindow = share.validFrom!.getTime() <= Date.now();
  if (!inWindow) await prisma.recordShare.update({ where: { id: share.id }, data: { validFrom: new Date(Date.now() - 60_000) } });
  const view = (await viewSharedRecord(actor, share.id, "SHARED_RECORD_VIEW")).history;
  report("Inside the window the doctor reads the patient's Pune lab result through the share", JSON.stringify(view.labResults).includes(`dirlab${tag}`));
  const brief = await askAi({ kind: "STAFF", userId: doc.userId, role: "DOCTOR", facilityId: NOIDA }, { mode: "VISIT_BRIEF", patientId: appt.patientId, shareId: share.id });
  report("…and the visit brief cites it", brief.outcome === "ANSWERED" && JSON.stringify(brief.sentences).includes(`dirlab${tag}`));
  report("The doctor's list of shared bookings shows it", (await doctorSharedBookings(doc.userId, NOIDA)).some((r) => r.shareId === share.id));
  report("Another doctor at Noida reads nothing through it (404)", await notFound(viewSharedRecord({ userId: doc2.userId, facilityId: NOIDA, role: "DOCTOR" }, share.id, "SHARED_RECORD_VIEW")));
  await prisma.recordShare.update({ where: { id: share.id }, data: { validFrom: new Date(Date.now() + 3_600_000) } });
  report("Before the window opens the share reads nothing (404)", await notFound(viewSharedRecord(actor, share.id, "SHARED_RECORD_VIEW")));
  await prisma.recordShare.update({ where: { id: share.id }, data: { validFrom: new Date(Date.now() - 60_000) } });

  // 3. Cancelling ends the share.
  await cancelOwnDirectoryBooking(P.userId, b1.bookingId);
  await drain();
  const ended = await prisma.recordShare.findUniqueOrThrow({ where: { id: share.id } });
  report("Cancelling the appointment ends the share (REVOKED, APPOINTMENT_CANCELLED), with its event",
    ended.status === "REVOKED" && ended.endedReason === "APPOINTMENT_CANCELLED" && (await eventsOf(share.id, "RecordShareStatusChanged")).some((e) => (e.payload as { endedReason?: string }).endedReason === "APPOINTMENT_CANCELLED"));
  report("…and the doctor reads nothing at once (404)", await notFound(viewSharedRecord(actor, share.id, "SHARED_RECORD_VIEW")));

  // 4. Concurrency, the stale projection, modes.
  const Q = await sharer(), R = await sharer();
  const race = await Promise.allSettled([bookThroughDirectory(Q.userId, { locationId: doc.locationId, start: s2.start }), bookThroughDirectory(R.userId, { locationId: doc.locationId, start: s2.start })]);
  report("Two patients booking the same slot at once: exactly one wins", race.filter((x) => x.status === "fulfilled").length === 1 && (await prisma.appointment.count({ where: { doctorStaffId: doc.staffId, scheduledStart: new Date(s2.start), status: { notIn: ["CANCELLED", "NO_SHOW"] } } })) === 1);
  await prisma.doctorNextSlot.update({ where: { practiceLocationId: doc.locationId! }, data: { nextSlotAt: new Date(s2.start) } });
  report("A stale next-slot projection (pointing at a taken slot) never double-books", await refused(bookThroughDirectory(P.userId, { locationId: doc.locationId, start: s2.start })));
  const video = await bookThroughDirectory(P.userId, { locationId: doc.locationId, start: s3.start, mode: "VIDEO" });
  report("VIDEO books a TELEMEDICINE appointment, no share unless asked", (await prisma.appointment.findUniqueOrThrow({ where: { id: video.appointmentId } })).type === "TELEMEDICINE" && video.shareId === null);
  report("A mode the location lacks is refused", await refused(bookThroughDirectory(P.userId, { locationId: doc2.locationId, start: s4.start, mode: "VIDEO" })));

  // 5. The same human.
  const self = await registerPatientAccount({ facilityId: PUNE, fullName: "Dr Self as patient", email: `self-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1980-01-01") });
  const selfPerson = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: self.userId } })).personId;
  const docEmail = (await prisma.user.findUniqueOrThrow({ where: { id: doc.userId }, select: { email: true } })).email;
  await prisma.personContact.create({ data: { personId: selfPerson, kind: "EMAIL", value: docEmail, verifiedAt: new Date() } });
  report("A doctor's own patient login can't book them (the same human)", await refused(bookThroughDirectory(self.userId, { locationId: doc.locationId, start: s4.start })));
  const selfBooking = await bookThroughDirectory(self.userId, { locationId: doc2.locationId, start: (await locationSlots(doc2.locationId!, day))[0].start, share: {} });
  await prisma.recordShare.update({ where: { id: selfBooking.shareId! }, data: { recipientUserId: doc.userId, validFrom: new Date(Date.now() - 60_000) } });
  report("A share naming the doctor's own record never opens through doctor tools (404)", await notFound(viewSharedRecord(actor, selfBooking.shareId!, "SHARED_RECORD_VIEW")));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
