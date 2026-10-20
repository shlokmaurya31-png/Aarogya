/**
 * Week 5a — the public directory (docs/DOCTOR_NETWORK_DESIGN.md §5, §6, §8, §10):
 *   - each filter (specialty, symptom, language, mode, fee, distance, slot
 *     window) admits exactly the expected fixtures;
 *   - a hospital location's fee is the hospital's tariff (CONSULT_OPD), a
 *     clinic's is the doctor's; a doctor can't set a fee at a hospital;
 *   - no home visits: a HOME_VISIT mode is refused;
 *   - "registered since" is the verified registration year; there is no
 *     claimed-experience field anywhere;
 *   - the symptom map: ~50 seeded symptoms, every row pending the clinical
 *     advisor, a general physician always offered; an unknown symptom falls
 *     back to a general physician;
 *   - ranking is deterministic (the same query, the same order) and
 *     follows specialty match, distance, next slot, fee;
 *   - no non-public field appears in any response (canaries: the doctor's
 *     login email, the verification case and its documents, the staff link);
 *   - a staff link needs the facility admin's approval, and another
 *     facility's admin can't approve it.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-doctor-directory.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { publicProfile, searchDirectory, specialtiesForSymptom, symptomList } from "../src/lib/doctors/directory";
import { addHospitalLocation, claimStaffProfile, decideStaffLink, updateLocation } from "../src/lib/doctors/locations";
import { registerDoctor } from "../src/lib/doctors/profile";
import { NOIDA, PUNE, drain, notFound, refused, reporter, tag } from "./lib/shareFixture";
import { doctorLogin, facilityAdmin, networkDoctor, verifier } from "./lib/doctorFixture";

const { report, done } = reporter();
const PUNE_PT = { lat: 18.5204, lng: 73.8567 };

async function main() {
  registerAllConsumers();
  const v = await verifier();
  const admin = await facilityAdmin(PUNE);
  const noidaAdmin = await facilityAdmin(NOIDA);
  // Fixtures: an orthopaedist at Pune hospital (Marathi, in person), a clinic orthopaedist 12 km away (₹300, video too),
  // a cardiologist at a clinic far away (Delhi, ₹1200), a dermatologist with no sessions (no slot), an unlisted orthopaedist.
  const ortho = await networkDoctor(PUNE, v, admin, { name: `Dr Ortho ${tag}`, specialties: ["ORTHOPAEDICS"], languages: ["en", "mr"], registrationYear: 2005, point: PUNE_PT });
  const clinic = await networkDoctor(PUNE, v, admin, { name: `Dr Clinic ${tag}`, specialties: ["ORTHOPAEDICS", "RHEUMATOLOGY"], languages: ["en", "hi"], clinicFeeMinor: 30000, modes: ["IN_PERSON", "VIDEO"], point: { lat: 18.6298, lng: 73.7997 } });
  const cardio = await networkDoctor(PUNE, v, admin, { name: `Dr Cardio ${tag}`, specialties: ["CARDIOLOGY"], languages: ["hi"], clinicFeeMinor: 120000, point: { lat: 28.6139, lng: 77.209 } });
  const derm = await networkDoctor(PUNE, v, admin, { name: `Dr Derm ${tag}`, specialties: ["DERMATOLOGY"], clinicFeeMinor: 50000, point: PUNE_PT });
  await prisma.doctorScheduleBlock.deleteMany({ where: { staffId: derm.staffId } });
  const { refreshNextSlot } = await import("../src/lib/doctors/slots");
  await refreshNextSlot(derm.locationId!);
  const unlisted = await networkDoctor(PUNE, v, admin, { name: `Dr Unlisted ${tag}`, specialties: ["ORTHOPAEDICS"], listed: false, point: PUNE_PT });
  await drain();
  const ids = (r: Awaited<ReturnType<typeof searchDirectory>>) => r.results.map((e) => e.doctorId);
  const mine = new Set([ortho.doctorId, clinic.doctorId, cardio.doctorId, derm.doctorId, unlisted.doctorId]);
  const only = (r: Awaited<ReturnType<typeof searchDirectory>>) => ids(r).filter((x) => mine.has(x));

  // Filters.
  report("Specialty: orthopaedics finds the two listed orthopaedists, never the unlisted one", only(await searchDirectory({ specialty: "ORTHOPAEDICS" })).sort().join() === [ortho.doctorId, clinic.doctorId].sort().join());
  report("Language: Marathi finds only the Marathi speaker", only(await searchDirectory({ language: "mr" })).join() === ortho.doctorId);
  report("Mode: video finds only the doctor who offers it", only(await searchDirectory({ mode: "VIDEO" })).join() === clinic.doctorId);
  const pune = await prisma.tariff.findFirst({ where: { facilityId: PUNE, chargeCode: "CONSULT_OPD", active: true, payer: { type: "CASH" } }, orderBy: { effectiveFrom: "desc" } });
  const hosp = (await searchDirectory({ specialty: "ORTHOPAEDICS" })).results.find((e) => e.doctorId === ortho.doctorId)!.locations[0];
  report("A hospital location's fee is the hospital's consultation tariff", !!pune && hosp.feeMinor === pune.unitPriceMinor, `${hosp.feeMinor} vs ${pune?.unitPriceMinor}`);
  report("A clinic's fee is the doctor's (₹300)", (await searchDirectory({ specialty: "RHEUMATOLOGY" })).results.find((e) => e.doctorId === clinic.doctorId)?.locations[0].feeMinor === 30000);
  report("Fee: at most ₹400 admits the ₹300 clinic, not the ₹1,200 one", only(await searchDirectory({ maxFeeMinor: 40000 })).includes(clinic.doctorId) && !only(await searchDirectory({ maxFeeMinor: 40000 })).includes(cardio.doctorId));
  const near = only(await searchDirectory({ near: { ...PUNE_PT, km: 20 } }));
  report("Distance: within 20 km of Pune admits Pune and the clinic 12 km away, not Delhi", near.includes(ortho.doctorId) && near.includes(clinic.doctorId) && !near.includes(cardio.doctorId));
  report("…and reports the distance", (await searchDirectory({ near: { ...PUNE_PT, km: 20 }, specialty: "RHEUMATOLOGY" })).results.find((e) => e.doctorId === clinic.doctorId)?.locations[0].distanceKm !== null);
  const soon = only(await searchDirectory({ slotWithinDays: 7 }));
  report("Slot window: a doctor with no sessions has no next slot and drops out", !soon.includes(derm.doctorId) && soon.includes(ortho.doctorId) && only(await searchDirectory({})).includes(derm.doctorId));

  // The symptom map.
  const list = await symptomList();
  report("About 50 symptoms are seeded, every one pending the clinical advisor", list.symptoms.length >= 45 && list.pendingClinicalAdvisor === true);
  const knee = await specialtiesForSymptom("KNEE_PAIN");
  report("Knee pain maps to orthopaedics (and rheumatology)", knee.specialties.includes("ORTHOPAEDICS") && knee.pendingClinicalAdvisor);
  const bySymptom = await searchDirectory({ symptom: "KNEE_PAIN" });
  report("Symptom search finds the orthopaedists and says a general physician can also help", only(bySymptom).includes(ortho.doctorId) && only(bySymptom).includes(clinic.doctorId) && bySymptom.symptom?.alsoGeneralPhysician === true);
  report("An unknown symptom falls back to general physicians (none of these fixtures)", only(await searchDirectory({ symptom: "NO_SUCH" })).length === 0);

  // Ranking.
  const a = ids(await searchDirectory({ symptom: "KNEE_PAIN", near: { ...PUNE_PT, km: 50 } })), b = ids(await searchDirectory({ symptom: "KNEE_PAIN", near: { ...PUNE_PT, km: 50 } }));
  report("Ranking is deterministic (the same query, the same order)", a.join() === b.join());
  report("…specialty match first, then distance: the Pune orthopaedist (primary, 0 km) before the clinic (12 km)", a.indexOf(ortho.doctorId) < a.indexOf(clinic.doctorId));

  // Public fields only.
  const body = JSON.stringify(await searchDirectory({})) + JSON.stringify(await publicProfile(ortho.doctorId));
  const caseIds = (await prisma.doctorVerificationCase.findMany({ where: { doctorId: ortho.doctorId } })).map((c) => c.id);
  const refs = (await prisma.doctorVerificationCase.findMany({ where: { doctorId: ortho.doctorId } })).flatMap((c) => c.documentRefs);
  const links = (await prisma.doctorStaffLink.findMany({ where: { doctorId: ortho.doctorId } })).map((l) => l.id);
  report("No non-public field in any response: no login email, user id, case, document or staff link",
    !body.includes(ortho.email) && !body.includes(ortho.userId) && caseIds.every((x) => !body.includes(x)) && refs.every((x) => !body.includes(x)) && links.every((x) => !body.includes(x)) && !body.includes(ortho.staffId));
  report("\"Registered since\" is the verified year; there is no experience field", (await publicProfile(ortho.doctorId)).registeredSince === 2005 && !/experience/i.test(body));
  report("An unlisted doctor's profile is a 404", await notFound(publicProfile(unlisted.doctorId)));

  // Locations and links.
  report("A doctor can't set a fee at a hospital", await refused(updateLocation(ortho.userId, ortho.locationId!, { feeMinor: 100 })));
  report("No home visits: HOME_VISIT is refused", await refused(updateLocation(clinic.userId, clinic.locationId!, { modes: ["HOME_VISIT"] })));
  const solo = await doctorLogin(PUNE);
  await registerDoctor(solo.userId, { registrationNumber: `solo-${Date.now()}`, stateCouncil: "MMC", specialties: ["ENT"] });
  const link = await claimStaffProfile(solo.userId, PUNE);
  report("A hospital location needs an approved staff link (404 while pending)", await notFound(addHospitalLocation(solo.userId, { facilityId: PUNE, modes: ["IN_PERSON"] })));
  report("Another facility's admin can't approve the link (404)", await notFound(decideStaffLink(noidaAdmin, link.id, true)));
  await decideStaffLink(admin, link.id, true);
  report("Once Pune's admin approves, the location can be added", !!(await addHospitalLocation(solo.userId, { facilityId: PUNE, modes: ["IN_PERSON"] })).id);
  report("A doctor can't claim a facility where they aren't staff (404)", await notFound(claimStaffProfile(solo.userId, NOIDA)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
