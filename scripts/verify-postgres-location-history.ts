/**
 * D5: EncounterLocation is the only location history; a Transfer records the
 * move and points at the location rows it closed and opened.
 *
 *   1. Transfer has no bed or time columns of its own.
 *   2. A direct transfer closes the open location and opens one at the
 *      destination in the same transaction; the Transfer links both; exactly
 *      one location stays open; the admission's bed matches it.
 *   3. Completing a transfer request does the move, the location rows and the
 *      request's COMPLETED status in one transaction.
 *   4. A completion that fails (destination taken) changes nothing: request
 *      status, locations and transfers are as before.
 *   5. Across the database: every Transfer's locations belong to its
 *      admission's encounter, the closed one ends when the opened one starts,
 *      and no encounter has two open locations.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-location-history.ts
 */
import { prisma } from "../src/lib/db";
import { admitPatient, transferPatient, TRANSFER_WITH_LOCATIONS } from "../src/lib/hospital/admission";
import {
  createTransferRequest, acceptTransferRequest, reserveBedForTransfer, completeTransferRequest,
} from "../src/lib/hospital/transferRequest";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const run = Date.now().toString(36);
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facility.id), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const ward = await prisma.ward.create({ data: { facilityId: facility.id, name: `D5 Ward ${run}`, wardType: "GENERAL" } });
  const bed = (label: string) => prisma.bed.create({ data: { facilityId: facility.id, wardId: ward.id, label: `D5-${label}-${run}` } });
  const admit = async (bedId: string) => {
    const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
    return admitPatient({ encounterId: enc.id, bedId, admittingStaffId: staff.id, reason: "D5 gate", byUserId: staff.userId });
  };
  const openLocations = (encounterId: string) => prisma.encounterLocation.findMany({ where: { encounterId, releasedAt: null } });

  // 1. No location columns on Transfer.
  const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'Transfer'`;
  const names = cols.map((c) => c.column_name);
  report("Transfer has no bed or time columns of its own", !["fromBedId", "toBedId", "transferredAt"].some((c) => names.includes(c)), names.join(","));

  // 2. Direct transfer.
  const [a, b, c] = [await bed("A"), await bed("B"), await bed("C")];
  const adm = await admit(a.id);
  const [initial] = await openLocations(adm.encounterId);
  report("Admission opens a location at the admitted bed", initial?.bedId === a.id);
  const t1 = await transferPatient({ admissionId: adm.id, toBedId: b.id, reason: "step-down", byUserId: staff.userId });
  const t1Full = await prisma.transfer.findUniqueOrThrow({ where: { id: t1.id }, include: TRANSFER_WITH_LOCATIONS });
  report("The Transfer links the location it closed", t1Full.fromLocationId === initial.id && t1Full.fromLocation?.releasedAt !== null);
  report("…and the one it opened, at the destination bed", t1Full.toLocation.bedId === b.id && t1Full.toLocation.releasedAt === null);
  report("…which starts when the old one ends", t1Full.fromLocation?.releasedAt?.getTime() === t1Full.toLocation.assignedAt.getTime());
  const open1 = await openLocations(adm.encounterId);
  report("Exactly one location is open, and it is the admission's bed",
    open1.length === 1 && open1[0].bedId === (await prisma.admission.findUniqueOrThrow({ where: { id: adm.id } })).bedId);

  // 3. Transfer request completion.
  const request = await createTransferRequest({ admissionId: adm.id, facilityId: facility.id, patientId: patient.id, requestedByStaffId: staff.id, reason: "isolation", byUserId: staff.userId });
  await acceptTransferRequest(request.id, staff.id, staff.userId);
  await reserveBedForTransfer(request.id, c.id, staff.userId);
  const done = await completeTransferRequest(request.id, staff.userId);
  const t2 = await prisma.transfer.findUniqueOrThrow({ where: { id: done.transfer.id }, include: TRANSFER_WITH_LOCATIONS });
  report("Completing a request marks it COMPLETED and links the Transfer", done.request.status === "COMPLETED" && done.request.transferId === t2.id);
  report("…and writes the location history (closed B, opened C)", t2.fromLocationId === t1Full.toLocationId && t2.toLocation.bedId === c.id);
  report("…leaving one open location", (await openLocations(adm.encounterId)).length === 1);

  // 4. A failed completion changes nothing.
  const [d, e] = [await bed("D"), await bed("E")];
  const adm2 = await admit(d.id);
  const req2 = await createTransferRequest({ admissionId: adm2.id, facilityId: facility.id, patientId: patient.id, requestedByStaffId: staff.id, reason: "ward change", byUserId: staff.userId });
  await acceptTransferRequest(req2.id, staff.id, staff.userId);
  await reserveBedForTransfer(req2.id, e.id, staff.userId);
  await prisma.bed.update({ where: { id: e.id }, data: { status: "OCCUPIED" } }); // someone else took it
  const locsBefore = await prisma.encounterLocation.count({ where: { encounterId: adm2.encounterId } });
  const transfersBefore = await prisma.transfer.count({ where: { admissionId: adm2.id } });
  const failed = await completeTransferRequest(req2.id, staff.userId).then(() => "completed", (err: Error) => err.constructor.name);
  const reqAfter = await prisma.transferRequest.findUniqueOrThrow({ where: { id: req2.id } });
  report("Completing onto a taken bed fails", failed !== "completed", failed);
  report("…and leaves the request, locations and transfers unchanged",
    reqAfter.status === "BED_RESERVED" && reqAfter.transferId === null
      && (await prisma.encounterLocation.count({ where: { encounterId: adm2.encounterId } })) === locsBefore
      && (await prisma.transfer.count({ where: { admissionId: adm2.id } })) === transfersBefore
      && (await prisma.bed.findUniqueOrThrow({ where: { id: d.id } })).status === "OCCUPIED");

  // 5. Whole database.
  const all = await prisma.transfer.findMany({ include: { ...TRANSFER_WITH_LOCATIONS, admission: { select: { encounterId: true } } } });
  const wrongEncounter = all.filter((t) => t.toLocation.encounterId !== t.admission.encounterId || (t.fromLocation && t.fromLocation.encounterId !== t.admission.encounterId));
  report(`Every transfer's locations belong to its admission's encounter (${all.length} transfers)`, wrongEncounter.length === 0, wrongEncounter.map((t) => t.id).slice(0, 3).join(","));
  const gaps = all.filter((t) => t.fromLocation && t.fromLocation.releasedAt?.getTime() !== t.toLocation.assignedAt.getTime());
  report("Every closed location ends when the transfer's new one starts", gaps.length === 0, gaps.map((t) => t.id).slice(0, 3).join(","));
  const doubleOpen = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "encounterId" FROM "EncounterLocation" WHERE "releasedAt" IS NULL GROUP BY 1 HAVING count(*) > 1) x`;
  report("No encounter has two open locations", Number(doubleOpen[0].n) === 0, `${doubleOpen[0].n}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
