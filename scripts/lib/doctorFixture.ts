/**
 * Week 5a — fixtures shared by the doctor-network gates: DOCTOR logins with a
 * staff profile at a hospital, registered, verified (through the real
 * verification service) and listed, with a practice location and clinic
 * sessions; and a platform verifier.
 */
import { prisma } from "../../src/lib/db";
import { ensurePrimaryMembership } from "../../prisma/seedData/staffMembership";
import { registerDoctor, updateOwnProfile } from "../../src/lib/doctors/profile";
import { decideVerification, submitVerification } from "../../src/lib/doctors/verification";
import { addClinicLocation, addHospitalLocation, claimStaffProfile, decideStaffLink } from "../../src/lib/doctors/locations";
import { refreshNextSlot } from "../../src/lib/doctors/slots";
import { locationSlots } from "../../src/lib/doctors/directory";
import { tag } from "./shareFixture";
import { gateClock } from "./testClock";

let seq = 0;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export async function verifier() {
  seq += 1;
  return prisma.user.create({ data: { email: `dn-verifier-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role: "AAROGYA_ADMIN", displayName: `Verifier ${seq}` } });
}

export async function facilityAdmin(facilityId: string) {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `dn-admin-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: `Admin ${seq}` } });
  await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "Admin" } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: true });
  return { userId: user.id, facilityId };
}

/** A DOCTOR login with a staff profile at `facilityId`. */
export async function doctorLogin(facilityId: string, name?: string) {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `dn-doctor-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: name ?? `Dr Network ${seq}` } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "Physician" } });
  await ensurePrimaryMembership(prisma, user.id, facilityId);
  return { userId: user.id, staffId: staff.id, facilityId, email: user.email };
}

/** Morning clinic sessions every day (09:00–13:00 local, 15-minute slots) at a facility. */
export async function sessions(staffId: string, facilityId: string, opts: { startMinute?: number; endMinute?: number } = {}) {
  for (let dow = 0; dow < 7; dow++) {
    await prisma.doctorScheduleBlock.create({ data: { staffId, facilityId, dayOfWeek: dow, startMinute: opts.startMinute ?? 540, endMinute: opts.endMinute ?? 780, slotDurationMinutes: 15 } });
  }
}

export interface DoctorOpts {
  specialties: string[]; languages?: string[]; registrationYear?: number; modes?: ("IN_PERSON" | "VIDEO")[];
  point?: { lat: number; lng: number }; clinicFeeMinor?: number; listed?: boolean; verify?: boolean; name?: string;
}

/** A doctor through the real services: register, verify (by the verifier), list, a HOSPITAL location (or a CLINIC with a fee), sessions. */
export async function networkDoctor(facilityId: string, v: { id: string }, admin: { userId: string; facilityId: string }, o: DoctorOpts) {
  const login = await doctorLogin(facilityId, o.name);
  seq += 1;
  const doctor = await registerDoctor(login.userId, {
    registrationNumber: `G${tag}${seq}`.toUpperCase(), stateCouncil: "MMC", registrationYear: o.registrationYear ?? 2010,
    specialties: o.specialties, languages: o.languages ?? ["en"], qualifications: [{ degree: "MBBS", institution: "Gate Medical College", year: 2009 }],
  });
  if (o.verify !== false) {
    const c = await submitVerification(login.userId, [{ bytes: PDF, contentType: "application/pdf", originalName: "registration.pdf" }]);
    await decideVerification(v.id, c.caseId, { decision: "APPROVE" });
    if (o.listed !== false) await updateOwnProfile(login.userId, { listed: true });
  }
  let locationId: string | null = null;
  if (o.verify !== false) {
    if (o.clinicFeeMinor !== undefined) {
      const loc = await addClinicLocation(login.userId, { name: `Clinic ${tag} ${seq}`, feeMinor: o.clinicFeeMinor, modes: o.modes ?? ["IN_PERSON"], lat: o.point?.lat ?? 18.52, lng: o.point?.lng ?? 73.85, pincode: "411001" });
      locationId = loc.id;
      await sessions(login.staffId, loc.facilityId);
    } else {
      const link = await claimStaffProfile(login.userId, facilityId);
      await decideStaffLink(admin, link.id, true);
      const loc = await addHospitalLocation(login.userId, { facilityId, modes: o.modes ?? ["IN_PERSON"], lat: o.point?.lat ?? 18.52, lng: o.point?.lng ?? 73.85, pincode: "411001" });
      locationId = loc.id;
      await sessions(login.staffId, facilityId);
    }
    await refreshNextSlot(locationId);
  }
  return { ...login, doctorId: doctor.id, locationId };
}

/**
 * The gate clock's booking day (the India day after tomorrow, scripts/lib/testClock.ts)
 * at a location, with its free slots, which must number at least `need`. The whole
 * day lies ahead, so the count is the sessions' own whatever the time now (it used
 * to be "the next slot's day", which late in the India day had a slot or two left).
 */
export async function daySlots(locationId: string, need: number) {
  const day = gateClock.bookingDay();
  const slots = await locationSlots(locationId, day);
  if (slots.length < need) throw new Error(`only ${slots.length} free slots (need ${need}) at ${locationId} on ${day.toISOString()}`);
  return { day, slots };
}
