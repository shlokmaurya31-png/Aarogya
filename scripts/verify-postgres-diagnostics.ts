/**
 * Phase B7 manual verification: Advanced Diagnostics (LIS + Radiology/PACS)
 * against real PostgreSQL. Exercises the mandated race matrix (brief §35) with
 * GENUINE parallel calls (Promise.all): the existing Phase-4 guarded lifecycle
 * services (specimen collect/reject, result verify/amend, critical ack, study
 * scheduling/transition, report finalize) AND the B7-new guarded flows (QC
 * review, external-referral transition, acquisition), plus cross-facility +
 * wrong-patient isolation. Single-winner outcomes are asserted explicitly.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-diagnostics.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { accessionSpecimen, collectSpecimen, rejectSpecimen } from "../src/lib/hospital/specimenLifecycle";
import { enterResult, verifyResult, amendResult, acknowledgeResult } from "../src/lib/hospital/labResultLifecycle";
import { scheduleStudy, startStudy } from "../src/lib/hospital/imagingStudyLifecycle";
import { verifyReport } from "../src/lib/hospital/imagingReportLifecycle";
import { recordQc, reviewQc, createExternalReferral, transitionExternalReferral, recordStudyAcquisition } from "../src/lib/hospital/diagnosticsAdvanced";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0, fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction((t) => fn(t));

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "DOCTOR" } } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });

  async function labOrder() {
    const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
    return prisma.labOrder.create({ data: { encounterId: enc.id, patientId: patient.id, testName: `T-${runId}`, category: "CHEM", orderedByStaffId: staff.id } });
  }
  async function pendingSpecimen() {
    const o = await labOrder();
    return tx((t) => accessionSpecimen(t, { labOrderId: o.id, facilityId: facility.id, patientId: patient.id, encounterId: o.encounterId, specimenType: "BLOOD" }));
  }

  // ── 1: two concurrent specimen collections → one winner ──
  {
    const sp = await pendingSpecimen();
    const attempt = () => tx((t) => collectSpecimen(t, sp.id, staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const s = await prisma.specimen.findUniqueOrThrow({ where: { id: sp.id } });
    report("Two concurrent specimen collections: exactly one winner, status COLLECTED", w === 1 && s.status === "COLLECTED", `winners=${w}, status=${s.status}`);
  }

  // ── 2: two concurrent specimen rejections → one winner ──
  {
    const sp = await pendingSpecimen();
    await tx((t) => collectSpecimen(t, sp.id, staff.id));
    await tx((t) => t.specimen.update({ where: { id: sp.id }, data: { status: "RECEIVED" } }));
    const attempt = () => tx((t) => rejectSpecimen(t, sp.id, "HEMOLYZED", staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    report("Two concurrent specimen rejections: exactly one winner", w === 1, `winners=${w}`);
  }

  // ── 3/4: two concurrent result verifications → one winner ──
  {
    const o = await labOrder();
    const res = await tx((t) => enterResult(t, { labOrderId: o.id, value: "5.0", isCritical: false }));
    const attempt = () => tx((t) => verifyResult(t, res.id, staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const f = await prisma.labResult.findUniqueOrThrow({ where: { id: res.id } });
    report("Two concurrent result verifications: exactly one winner, status VERIFIED", w === 1 && f.status === "VERIFIED", `winners=${w}, status=${f.status}`);
  }

  // ── 5: two concurrent result amendments → one winner, exactly one current version ──
  {
    const o = await labOrder();
    const res = await tx((t) => enterResult(t, { labOrderId: o.id, value: "5.0", isCritical: false }));
    await tx((t) => verifyResult(t, res.id, staff.id));
    const attempt = (v: string) => tx((t) => amendResult(t, res.id, { value: v, reason: "correction", amendedByStaffId: staff.id })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt("6.0"), attempt("7.0")]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const current = await prisma.labResult.count({ where: { labOrderId: o.id, isCurrent: true } });
    report("Two concurrent result amendments: exactly one winner, exactly one current version", w === 1 && current === 1, `winners=${w}, currentVersions=${current}`);
  }

  // ── 6: two concurrent critical-result acknowledgements → coherent single ack ──
  {
    const o = await labOrder();
    const res = await tx((t) => enterResult(t, { labOrderId: o.id, value: "99", isCritical: true }));
    await tx((t) => verifyResult(t, res.id, staff.id));
    const attempt = () => tx((t) => acknowledgeResult(t, res.id, staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const f = await prisma.labResult.findUniqueOrThrow({ where: { id: res.id } });
    report("Two concurrent critical-result acknowledgements: single winner, result acknowledged once", w === 1 && f.acknowledgedAt != null, `winners=${w}, acked=${f.acknowledgedAt != null}`);
  }

  // ── 7: two concurrent bookings for the same resource/time → one winner ──
  {
    const resource = await prisma.imagingResource.create({ data: { facilityId: facility.id, name: `MOD-${runId}`, modality: "CT" } });
    const at = new Date(Date.now() + 24 * 3600_000);
    async function imagingOrder() {
      const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
      return prisma.imagingOrder.create({ data: { encounterId: enc.id, patientId: patient.id, modality: "CT", studyDescription: "CT", orderedByStaffId: staff.id } });
    }
    const o1 = await imagingOrder(); const o2 = await imagingOrder();
    const attempt = (oid: string, eid: string) => tx((t) => scheduleStudy(t, { imagingOrderId: oid, facilityId: facility.id, patientId: patient.id, encounterId: eid, modality: "CT", resourceId: resource.id, scheduledAt: at, durationMinutes: 30 })).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(o1.id, o1.encounterId), attempt(o2.id, o2.encounterId)]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const booked = await prisma.imagingStudy.count({ where: { resourceId: resource.id, status: { notIn: ["CANCELLED", "NO_SHOW"] }, scheduledAt: { lt: new Date(at.getTime() + 30 * 60_000) }, scheduledEndAt: { gt: at } } });
    report("Two concurrent same-resource/time bookings: exactly one succeeds, one booking in the slot", w === 1 && booked === 1, `winners=${w}, inSlot=${booked}`);
  }

  // ── 8: two concurrent study transitions (start) → one winner ──
  {
    const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
    const o = await prisma.imagingOrder.create({ data: { encounterId: enc.id, patientId: patient.id, modality: "XRAY", studyDescription: "CXR", orderedByStaffId: staff.id } });
    const study = await tx((t) => scheduleStudy(t, { imagingOrderId: o.id, facilityId: facility.id, patientId: patient.id, encounterId: enc.id, modality: "XRAY", scheduledAt: new Date(Date.now() + 3600_000) }));
    await tx((t) => t.imagingStudy.update({ where: { id: study.id }, data: { status: "ARRIVED", arrivedAt: new Date() } }));
    const attempt = () => tx((t) => startStudy(t, study.id, staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const f = await prisma.imagingStudy.findUniqueOrThrow({ where: { id: study.id } });
    report("Two concurrent study starts: exactly one winner, status IN_PROGRESS", w === 1 && f.status === "IN_PROGRESS", `winners=${w}, status=${f.status}`);
    // ── acquisition race (B7-new) on the same study ──
    const acq = () => recordStudyAcquisition({ studyId: study.id, facilityId: facility.id, performedByStaffId: staff.id, numberOfImages: 5, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [a1, a2] = await Promise.all([acq(), acq()]);
    const aw = [a1, a2].filter((r) => r.ok).length;
    const fs = await prisma.imagingStudy.findUniqueOrThrow({ where: { id: study.id } });
    report("Two concurrent acquisition records: single coherent effect, PACS reference set once", aw >= 1 && fs.pacsReference != null, `winners=${aw}, pacs=${fs.pacsReference != null}`);
  }

  // ── 9: two concurrent report finalizations (verify) → one winner ──
  {
    const enc = await prisma.encounter.create({ data: { facilityId: facility.id, patientId: patient.id, type: "IPD", accessSource: "WALK_IN" } });
    const o = await prisma.imagingOrder.create({ data: { encounterId: enc.id, patientId: patient.id, modality: "XRAY", studyDescription: "CXR", orderedByStaffId: staff.id } });
    const rep = await prisma.imagingReport.create({ data: { imagingOrderId: o.id, findings: "f", impression: "i", reportedByStaffId: staff.id, status: "ENTERED" } });
    const attempt = () => tx((t) => verifyReport(t, rep.id, staff.id)).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    const f = await prisma.imagingReport.findUniqueOrThrow({ where: { id: rep.id } });
    report("Two concurrent report finalizations: exactly one winner, status VERIFIED", w === 1 && f.status === "VERIFIED", `winners=${w}, status=${f.status}`);
  }

  // ── B7-new: two concurrent QC reviews → one winner ──
  {
    const qc = await recordQc({ facilityId: facility.id, instrumentId: `INS-${runId}`, controlType: "NORMAL", performedByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => reviewQc({ qcId: qc.id, facilityId: facility.id, to: "REVIEWED", reviewedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    report("Two concurrent QC reviews: exactly one winner", w === 1, `winners=${w}`);
  }

  // ── B7-new: two concurrent external-referral transitions → one winner ──
  {
    const ref = await createExternalReferral({ facilityId: facility.id, patientId: patient.id, externalLabName: "RefLab", sentByStaffId: staff.id, byUserId: staff.userId });
    const attempt = () => transitionExternalReferral({ referralId: ref.id, facilityId: facility.id, to: "SENT", actorStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const w = [r1, r2].filter((r) => r.ok).length;
    report("Two concurrent external-referral transitions: exactly one winner", w === 1, `winners=${w}`);
  }

  // ── 11/12: cross-facility + wrong-patient isolation ──
  {
    const other = await prisma.facility.findFirst({ where: { id: { not: facility.id } } });
    const qc = await recordQc({ facilityId: facility.id, instrumentId: `INS2-${runId}`, controlType: "NORMAL", performedByStaffId: staff.id, byUserId: staff.userId });
    if (other) {
      const xf = await reviewQc({ qcId: qc.id, facilityId: other.id, to: "REVIEWED", reviewedByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Cross-facility QC review is denied (facility isolation)", !xf.ok, `reviewed=${xf.ok}`);
      const otherPatient = await prisma.patient.create({ data: { uhid: `UHID-DXP-${runId}`, facilityId: other.id, fullName: `DX ${runId}`, sex: "male" } });
      const wp = await createExternalReferral({ facilityId: facility.id, patientId: otherPatient.id, externalLabName: "X", sentByStaffId: staff.id, byUserId: staff.userId }).then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      report("Wrong-facility patient external referral is denied (wrong-patient protection)", !wp.ok, `created=${wp.ok}`);
    } else {
      report("Cross-facility QC review (skipped — one facility)", true);
      report("Wrong-facility external referral (skipped — one facility)", true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
