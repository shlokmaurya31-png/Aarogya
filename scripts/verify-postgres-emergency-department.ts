/**
 * Phase B5 manual verification: Emergency Department workflows against real
 * PostgreSQL. Exercises the ED-introduced concurrency races (brief §30) with
 * GENUINE parallel calls (Promise.all), asserting single-winner outcomes and
 * facility/wrong-patient isolation. Races that are purely canonical (task
 * completion, transfer-request, diagnostic/medication idempotency) are already
 * covered by prior-phase verify-postgres-*.ts scripts and are reused unchanged
 * here — this focuses on what the ED layer adds: location assignment, the
 * resuscitation workflow, and the terminal disposition.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-emergency-department.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  registerEdArrival, assignEdLocation, releaseEdLocation, activateResuscitation, updateResuscitation,
  recordReassessment, dispositionEncounter,
} from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { createHandoff, acknowledgeHandoff } from "../src/lib/hospital/handoff";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });

  const ward = await prisma.ward.create({ data: { facilityId: facility.id, name: `ED-WARD-${runId}`, wardType: "GENERAL" } });
  async function bed(label: string) { return prisma.bed.create({ data: { facilityId: facility.id, wardId: ward.id, label: `${label}-${runId}`, status: "AVAILABLE" } }); }
  async function edEncounter() {
    return registerEdArrival({ facilityId: facility.id, patientId: patient.id, chiefComplaint: "Test", registeredByStaffId: staff.id, byUserId: staff.userId });
  }
  async function seenEncounter() {
    const e = await edEncounter();
    await recordTriage({ encounterId: e.id, recordedByStaffId: staff.id, acuity: 3, byUserId: staff.userId });
    return e;
  }

  // ── 1: two users assign the SAME ED bed → one wins ──
  {
    const edBed = await bed("BAY-A");
    const e1 = await edEncounter(); const e2 = await edEncounter();
    const attempt = (encId: string) => assignEdLocation({ encounterId: encId, facilityId: facility.id, bedId: edBed.id, assignedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(e1.id), attempt(e2.id)]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    const b = await prisma.bed.findUniqueOrThrow({ where: { id: edBed.id } });
    const activeOnBed = await prisma.encounterLocation.count({ where: { bedId: edBed.id, releasedAt: null } });
    report("Two users assign the same ED bed: exactly one wins, bed OCCUPIED once", winners === 1 && b.status === "OCCUPIED" && activeOnBed === 1, `winners=${winners}, bed=${b.status}, active=${activeOnBed}`);
  }

  // ── 2: same patient to two different bays concurrently → one active location ──
  {
    const bA = await bed("BAY-B"); const bB = await bed("BAY-C");
    const e = await edEncounter();
    const attempt = (bedId: string) => assignEdLocation({ encounterId: e.id, facilityId: facility.id, bedId, assignedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    await Promise.all([attempt(bA.id), attempt(bB.id)]);
    const active = await prisma.encounterLocation.count({ where: { encounterId: e.id, releasedAt: null } });
    report("Same encounter to two bays concurrently: at most one active location (no double occupancy)", active === 1, `activeLocations=${active}`);
  }

  // ── 3: two triage completions simultaneously → encounter TRIAGED, not corrupted ──
  {
    const e = await edEncounter();
    const attempt = () => recordTriage({ encounterId: e.id, recordedByStaffId: staff.id, acuity: 2, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    await Promise.all([attempt(), attempt()]);
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: e.id } });
    report("Concurrent triage completion: encounter reaches TRIAGED with acuity set, no corrupted state", enc.status === "TRIAGED" && enc.triageLevel != null, `status=${enc.status}, acuity=${enc.triageLevel}`);
  }

  // ── 4 / 19: high-acuity activation race → one open resuscitation ──
  {
    const e = await seenEncounter();
    const attempt = () => activateResuscitation({ encounterId: e.id, facilityId: facility.id, activatedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    const open = await prisma.edResuscitation.count({ where: { encounterId: e.id, status: { not: "CLOSED" } } });
    report("High-acuity activation race: exactly one open resuscitation per encounter", winners === 1 && open === 1, `winners=${winners}, open=${open}`);
  }

  // ── 4b: concurrent resuscitation transition → one winner ──
  {
    const e = await seenEncounter();
    const resus = await activateResuscitation({ encounterId: e.id, facilityId: facility.id, activatedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => updateResuscitation({ resuscitationId: resus.id, facilityId: facility.id, to: "ACTIVE", actorStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    report("Concurrent resuscitation transition (ACTIVATED->ACTIVE): exactly one winner", winners === 1, `winners=${winners}`);
  }

  // ── 5 / 9 / 10: two users disposition the same encounter → one terminal winner ──
  {
    const e = await seenEncounter();
    const attempt = (type: "DISCHARGE" | "LWBS") => dispositionEncounter({ encounterId: e.id, facilityId: facility.id, type, dispositionedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt("DISCHARGE"), attempt("LWBS")]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    const dispCount = await prisma.edDisposition.count({ where: { encounterId: e.id } });
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: e.id } });
    report("Concurrent disposition (discharge vs LWBS): exactly one terminal winner, one disposition row", winners === 1 && dispCount === 1 && ["DISCHARGED", "CANCELLED"].includes(enc.status), `winners=${winners}, dispositions=${dispCount}, status=${enc.status}`);
  }

  // ── 5b: concurrent death vs discharge → one terminal outcome ──
  {
    const e = await seenEncounter();
    const attempt = (type: "DECEASED" | "DISCHARGE") => dispositionEncounter({ encounterId: e.id, facilityId: facility.id, type, dispositionedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const, type }), () => ({ ok: false as const, type }));
    const [r1, r2] = await Promise.all([attempt("DECEASED"), attempt("DISCHARGE")]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    const disp = await prisma.edDisposition.findUnique({ where: { encounterId: e.id } });
    report("Concurrent death vs discharge: exactly one terminal outcome recorded", winners === 1 && disp != null, `winners=${winners}, type=${disp?.type}`);
  }

  // ── 6 / 7: concurrent ED→ICU and ED→ward admission of the same encounter → one wins ──
  {
    const e = await seenEncounter();
    const bWard = await bed("WARD-1"); const bIcu = await bed("ICU-1");
    const attempt = (type: "ADMIT_WARD" | "ADMIT_ICU", bedId: string) => dispositionEncounter({ encounterId: e.id, facilityId: facility.id, type, bedId, dispositionedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt("ADMIT_WARD", bWard.id), attempt("ADMIT_ICU", bIcu.id)]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    const admissions = await prisma.admission.count({ where: { encounterId: e.id } });
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: e.id } });
    const activeLoc = await prisma.encounterLocation.count({ where: { encounterId: e.id, releasedAt: null } });
    report("Concurrent ED admission (ward vs ICU): exactly one admission, one active location, encounter ADMITTED", winners === 1 && admissions === 1 && enc.status === "ADMITTED" && activeLoc === 1, `winners=${winners}, admissions=${admissions}, status=${enc.status}, activeLoc=${activeLoc}`);
  }

  // ── 12: concurrent handoff acknowledgement → one winner (reused canonical guard) ──
  {
    const e = await seenEncounter();
    const handoff = await createHandoff({ facilityId: facility.id, patientId: patient.id, encounterId: e.id, type: "DOCTOR", fromStaffId: staff.id, summary: "ED handoff", byUserId: staff.userId });
    const attempt = () => acknowledgeHandoff(handoff.id, staff.id, staff.userId).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const winners = [r1, r2].filter((r) => r.ok).length;
    report("Concurrent ED handoff acknowledgement: exactly one winner", winners === 1, `winners=${winners}`);
  }

  // ── 20: location release vs reassignment → no double occupancy ──
  {
    const bX = await bed("BAY-X"); const bY = await bed("BAY-Y");
    const e = await edEncounter();
    await assignEdLocation({ encounterId: e.id, facilityId: facility.id, bedId: bX.id, assignedByStaffId: staff.id, byUserId: staff.userId });
    const rel = releaseEdLocation({ encounterId: e.id, facilityId: facility.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const rea = assignEdLocation({ encounterId: e.id, facilityId: facility.id, bedId: bY.id, assignedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    await Promise.all([rel, rea]);
    const active = await prisma.encounterLocation.count({ where: { encounterId: e.id, releasedAt: null } });
    report("Location release vs reassignment: at most one active location (no double occupancy)", active <= 1, `activeLocations=${active}`);
  }

  // ── 13-16: cross-facility + wrong-patient isolation ──
  {
    const other = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    if (other) {
      const e = await seenEncounter();
      // Cross-facility disposition (actor facility = other, encounter belongs to `facility`) → denied.
      const xf = await dispositionEncounter({ encounterId: e.id, facilityId: other.id, type: "DISCHARGE", dispositionedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      // Cross-facility reassessment → denied.
      const xr = await recordReassessment({ encounterId: e.id, facilityId: other.id, reassessedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Cross-facility ED disposition + reassessment are denied (facility isolation)", !xf.ok && !xr.ok, `disposition=${xf.ok}, reassessment=${xr.ok}`);
    } else {
      report("Cross-facility ED isolation (skipped — one facility)", true);
    }
  }
  {
    const otherPatient = await prisma.patient.create({ data: { uhid: `UHID-EDXP-${runId}`, facilityId: facility.id, fullName: `ED XP ${runId}`, sex: "male" } });
    // registerEdArrival for a patient in a DIFFERENT facility must fail.
    const other = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    if (other) {
      const wp = await registerEdArrival({ facilityId: other.id, patientId: otherPatient.id, registeredByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Wrong-facility ED arrival (patient not in actor facility) is denied", !wp.ok, `created=${wp.ok}`);
    } else {
      report("Wrong-facility ED arrival (skipped — one facility)", true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
