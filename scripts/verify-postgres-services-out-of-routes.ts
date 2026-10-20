/**
 * Workflow spine §9 step 3: write paths moved out of route handlers into
 * services (registerPatient, openEncounter, placeLabOrder, placeImagingOrder).
 *
 *   1. Every way a Patient record is created emits PatientRegistered, in the
 *      same transaction: front-desk registration, self-registration with no
 *      match, and a front-desk "create new" decision on a link request.
 *   2. openEncounter refuses a patient of another facility.
 *   3. placeLabOrder: one order, envelope, specimen, charge and collection
 *      task; the encounter moves to INVESTIGATING; a resubmission within 15 s
 *      returns the same order with no second charge or task; a mismatched
 *      patient is 400; another facility's encounter is 404.
 *   4. placeImagingOrder: the same guarantees.
 * (HTTP behaviour through the routes is covered by the one-patient and
 * tenancy-sweep gates.)
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-services-out-of-routes.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { BadRequestError, NotFoundError } from "../src/lib/auth/rbac";
import { registerPatient } from "../src/lib/patient/registration";
import { registerPatientAccount, decideLinkRequest } from "../src/lib/patient/selfRegistration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { placeImagingOrder } from "../src/lib/hospital/imagingOrder";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const errorOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof NotFoundError ? "404" : e instanceof BadRequestError ? "400" : String(e)));
const registered = (patientId: string) => prisma.domainEventOutbox.count({ where: { eventType: "PatientRegistered", aggregateId: patientId } });

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const frontDesk = await prisma.user.findFirstOrThrow({ where: { email: "frontdesk@amc-demo.aarogya" } });

  // 1. Registration paths.
  const p1 = await registerPatient({ facilityId, byUserId: frontDesk.id, fullName: `Services Gate ${run}`, sex: "F", ageYears: 40, phone: "9000011111" });
  report("Front-desk registration emits PatientRegistered once", (await registered(p1.id)) === 1);
  report("…and records the age as an estimated date of birth", p1.dobPrecision === "ESTIMATED_FROM_AGE" && p1.dob !== null);
  const self = await registerPatientAccount({ fullName: `Unmatched Self ${run}`, email: `svc-self-${run}@verify.aarogya`, passwordHash: "x", sex: "M", phone: "9000022222", dob: new Date("1979-03-03") });
  if (self.status !== "LINKED_NEW") throw new Error(`expected a new record, got ${self.status}`);
  const selfPatientId = self.patientId;
  report("Self-registration with no match emits PatientRegistered (it didn't before)", (await registered(selfPatientId)) === 1, self.status);
  // A record self-registration will match (same name and dob) but can't verify (no phone) → front-desk review.
  await prisma.patient.create({ data: { uhid: `SVC-TWIN-${run}`, facilityId, fullName: `No Phone Twin ${run}`, sex: "F", dob: new Date("1988-08-08") } });
  const review = await registerPatientAccount({ fullName: `No Phone Twin ${run}`, email: `svc-review-${run}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1988-08-08") });
  const linkReq = await prisma.patientLinkRequest.findFirstOrThrow({ where: { userId: review.userId } });
  const created = await decideLinkRequest({ facilityId, requestId: linkReq.id, decision: "CREATE_NEW", reviewerUserId: frontDesk.id });
  report("A front-desk \"create new\" decision emits PatientRegistered (it didn't before)",
    created.status === "CREATED_NEW" && (await registered((created as { patientId: string }).patientId)) === 1, created.status);

  // 2. openEncounter tenancy.
  const noidaPatient = await prisma.patient.findFirstOrThrow({ where: { facilityId: "fac-amc-noida" } });
  report("openEncounter refuses another facility's patient", (await errorOf(openEncounter({ facilityId, patientId: noidaPatient.id, type: "OPD", byUserId: frontDesk.id }))) === "400");

  // 3. Lab orders.
  const enc = await openEncounter({ facilityId, patientId: p1.id, type: "OPD", chiefComplaint: "Services gate", byUserId: frontDesk.id });
  await prisma.encounter.update({ where: { id: enc.id }, data: { status: "IN_CONSULTATION" } });
  const labInput = { facilityId, staffId: doctor.id, byUserId: doctor.userId, encounterId: enc.id, patientId: p1.id, testName: `CBC ${run}`, category: "Haematology", priority: "URGENT" };
  const lab = await placeLabOrder(labInput);
  const labOrder = await prisma.labOrder.findUniqueOrThrow({ where: { id: lab.order.id }, include: { order: true } });
  report("placeLabOrder creates the order with its envelope and specimen", !lab.duplicate && labOrder.order !== null && lab.specimen !== null && labOrder.priority === "URGENT");
  const labCharges = () => prisma.charge.count({ where: { sourceType: "LabOrder", sourceId: lab.order.id } });
  const labTasks = () => prisma.task.count({ where: { orderId: labOrder.orderId!, type: "SPECIMEN_COLLECTION" } });
  report("…posts exactly one charge and one collection task", (await labCharges()) === 1 && (await labTasks()) === 1);
  report("…and moves the encounter to INVESTIGATING", (await prisma.encounter.findUniqueOrThrow({ where: { id: enc.id } })).status === "INVESTIGATING");
  const again = await placeLabOrder(labInput);
  report("A resubmission within 15 s returns the same order", again.duplicate && again.order.id === lab.order.id);
  report("…with no second charge or task", (await labCharges()) === 1 && (await labTasks()) === 1);
  report("A patient that isn't the encounter's is refused (400)", (await errorOf(placeLabOrder({ ...labInput, testName: `X ${run}`, patientId: selfPatientId }))) === "400");
  const noidaEnc = await prisma.encounter.findFirstOrThrow({ where: { facilityId: "fac-amc-noida" } });
  report("Another facility's encounter is 404", (await errorOf(placeLabOrder({ ...labInput, testName: `Y ${run}`, encounterId: noidaEnc.id, patientId: noidaEnc.patientId }))) === "404");
  report("An unknown priority is refused (400)", (await errorOf(placeLabOrder({ ...labInput, testName: `Z ${run}`, priority: "WHENEVER" }))) === "400");

  // 4. Imaging orders.
  const imgInput = { facilityId, staffId: doctor.id, byUserId: doctor.userId, encounterId: enc.id, patientId: p1.id, modality: "XRAY", studyDescription: `Chest PA ${run}` };
  const img = await placeImagingOrder(imgInput);
  const imgOrder = await prisma.imagingOrder.findUniqueOrThrow({ where: { id: img.order.id } });
  const imgCharges = () => prisma.charge.count({ where: { sourceType: "ImagingOrder", sourceId: img.order.id } });
  const imgTasks = () => prisma.task.count({ where: { orderId: imgOrder.orderId!, type: "IMAGING_PREP" } });
  report("placeImagingOrder creates the order with one charge and one prep task", !img.duplicate && imgOrder.orderId !== null && (await imgCharges()) === 1 && (await imgTasks()) === 1);
  const imgAgain = await placeImagingOrder(imgInput);
  report("…a resubmission returns the same order with no second charge or task", imgAgain.duplicate && imgAgain.order.id === img.order.id && (await imgCharges()) === 1 && (await imgTasks()) === 1);
  report("…and another facility's encounter is 404", (await errorOf(placeImagingOrder({ ...imgInput, studyDescription: `W ${run}`, encounterId: noidaEnc.id, patientId: noidaEnc.patientId }))) === "404");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
