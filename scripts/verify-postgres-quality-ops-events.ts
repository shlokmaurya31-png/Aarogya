/**
 * Workflow spine §9 step 9b: quality, patient safety and facility operations.
 *
 *   1. Quality incidents: QualityIncidentStatusChanged for report, each
 *      transition, the RCA review (a stage: status unchanged) and a reopen; a
 *      RESTRICTED incident never names the patient or encounter.
 *   2. CAPA (created → … → verified → closed), findings (created, closed),
 *      measures (status, compare-and-set).
 *   3. Diet orders (created, discontinued; the diet code, never restrictions).
 *   4. Equipment: status changes (manual, downtime started/ended), service
 *      records (calibration, maintenance, preventive); a downtime naming
 *      another facility's device is refused.
 *   5. Infection control: incident reported, investigation recorded,
 *      transition; an exposure (SENSITIVE, never the person).
 *   6. Lab QC and calibration: recorded and reviewed, with the QC outcome.
 *   7. Maintenance requests: created and transitioned.
 *   8. No payload carries the free text the calls were given.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-quality-ops-events.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { createQualityIncident, transitionIncident, reopenIncident, createRca, reviewRca, createCapa, transitionCapa, createStandard, addMeasure, setMeasureStatus, createFinding, closeFinding } from "../src/lib/hospital/quality/service";
import {
  createDietOrder, setDietOrderStatus, createEquipment, setEquipmentStatus, startDowntime, endDowntime, recordEquipmentCalibration, recordEquipmentMaintenance,
  schedulePreventiveMaintenance, completePreventiveMaintenance, createInfectionIncident, createInfectionInvestigation, transitionInfectionIncident, recordExposure,
  createMaintenanceRequest, transitionMaintenance,
} from "../src/lib/hospital/operations/service";
import { recordQc, reviewQc, recordCalibration, reviewCalibration } from "../src/lib/hospital/diagnosticsAdvanced";
import { getEventContract } from "../src/lib/events/catalogue";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
type Payload = Record<string, unknown>;
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const secret = `secret ${run}`;
  const facilityId = "fac-amc-pune";
  const staffWhere = (role: string) => ({ AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }) as never;
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: staffWhere("DOCTOR"), orderBy: { id: "asc" } });
  const admin = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: staffWhere("HOSPITAL_ADMIN"), orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Quality Ops ${run}`, sex: "M", ageYears: 70 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Quality", byUserId: by });
  const payloads = async (type: string, aggregateId: string) => (await prisma.domainEventOutbox.findMany({ where: { eventType: type, aggregateId }, orderBy: { seq: "asc" } })).map((e) => e.payload as Payload);
  const moves = (ps: Payload[]) => ps.map((p) => `${p.from}>${p.to}`).join();
  const all: Payload[] = [];
  const keep = async (type: string, id: string) => { const ps = await payloads(type, id); all.push(...ps); return ps; };

  // 1. Quality incidents.
  const inc = await createQualityIncident({ facilityId, category: "FALL", severity: "HIGH", title: `Fall ${secret}`, description: secret, patientId: patient.id, encounterId: enc.id, reportedByStaffId: doctor.id, byUserId: by });
  for (const to of ["TRIAGED", "UNDER_INVESTIGATION", "RESOLVED", "CLOSED"]) await transitionIncident({ incidentId: inc.id, facilityId, to, actorStaffId: admin.id, reason: secret, byUserId: admin.userId });
  const rca = await createRca({ facilityId, incidentId: inc.id, problemStatement: secret, authoredByStaffId: doctor.id, byUserId: by });
  await reviewRca({ rcaId: rca.id, facilityId, reviewedByStaffId: admin.id, byUserId: admin.userId });
  await reopenIncident({ incidentId: inc.id, facilityId, actorStaffId: admin.id, reason: secret, byUserId: admin.userId });
  const incE = await keep("QualityIncidentStatusChanged", inc.id);
  report("Incident: REPORTED, four transitions, the RCA review (status unchanged) and a reopen, each with category and severity",
    incE.map((p) => `${p.change}:${p.from}>${p.to}`).join() === "REPORTED:null>REPORTED,TRANSITION:REPORTED>TRIAGED,TRANSITION:TRIAGED>UNDER_INVESTIGATION,TRANSITION:UNDER_INVESTIGATION>RESOLVED,TRANSITION:RESOLVED>CLOSED,RCA_REVIEWED:CLOSED>CLOSED,REOPENED:CLOSED>UNDER_INVESTIGATION"
      && incE.every((p) => p.category === "FALL" && p.severity === "HIGH" && p.patientId === patient.id) && incE[5].rcaId === rca.id,
    incE.map((p) => `${p.change}:${p.from}>${p.to}`).join());
  const restricted = await createQualityIncident({ facilityId, category: "SECURITY", title: secret, description: secret, patientId: patient.id, encounterId: enc.id, confidentiality: "RESTRICTED", reportedByStaffId: doctor.id, byUserId: by });
  const resE = await keep("QualityIncidentStatusChanged", restricted.id);
  const resRow = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "QualityIncidentStatusChanged", aggregateId: restricted.id } });
  report("A RESTRICTED incident never names the patient or encounter in the stream (payload or correlation)",
    resE.length === 1 && resE[0].confidentiality === "RESTRICTED" && !("patientId" in resE[0]) && !("encounterId" in resE[0]) && resRow.correlationId !== enc.id);

  // 2. CAPA, findings, measures.
  const capa = await createCapa({ facilityId, title: secret, description: secret, actionType: "CORRECTIVE", incidentId: inc.id, ownerStaffId: doctor.id, createdByStaffId: doctor.id, byUserId: by });
  await transitionCapa({ capaId: capa.id, facilityId, to: "IN_PROGRESS", actorStaffId: doctor.id, byUserId: by });
  await transitionCapa({ capaId: capa.id, facilityId, to: "COMPLETED", actorStaffId: doctor.id, completionNote: secret, byUserId: by });
  await transitionCapa({ capaId: capa.id, facilityId, to: "VERIFIED", actorStaffId: admin.id, byUserId: admin.userId });
  await transitionCapa({ capaId: capa.id, facilityId, to: "CLOSED", actorStaffId: admin.id, byUserId: admin.userId });
  report("CAPA: null>OPEN, OPEN>IN_PROGRESS, IN_PROGRESS>COMPLETED, COMPLETED>VERIFIED, VERIFIED>CLOSED (CORRECTIVE, linked to the incident)",
    moves(await keep("CapaStatusChanged", capa.id)) === "null>OPEN,OPEN>IN_PROGRESS,IN_PROGRESS>COMPLETED,COMPLETED>VERIFIED,VERIFIED>CLOSED"
      && (await payloads("CapaStatusChanged", capa.id)).every((p) => p.actionType === "CORRECTIVE" && p.incidentId === inc.id));
  const standard = await createStandard({ facilityId, code: `STD-${run}`, title: "Standard", createdByStaffId: admin.id, byUserId: admin.userId });
  const measure = await addMeasure({ facilityId, standardId: standard.id, code: `M-${run}`, title: "Measure", byUserId: admin.userId });
  await setMeasureStatus({ facilityId, measureId: measure.id, status: "PARTIAL", reviewedByStaffId: admin.id, byUserId: admin.userId });
  await setMeasureStatus({ facilityId, measureId: measure.id, status: "COMPLIANT", reviewedByStaffId: admin.id, byUserId: admin.userId });
  report("Measure: PENDING>PARTIAL, PARTIAL>COMPLIANT", moves(await keep("QualityMeasureStatusChanged", measure.id)) === "PENDING>PARTIAL,PARTIAL>COMPLIANT");
  const finding = await createFinding({ facilityId, title: secret, description: secret, severity: "LOW", measureId: measure.id, identifiedByStaffId: admin.id, byUserId: admin.userId });
  await closeFinding({ facilityId, findingId: finding.id, closedByStaffId: admin.id, byUserId: admin.userId });
  report("Finding: null>OPEN, OPEN>CLOSED (severity, the measure)", moves(await keep("QualityFindingStatusChanged", finding.id)) === "null>OPEN,OPEN>CLOSED" && (await payloads("QualityFindingStatusChanged", finding.id))[0].measureId === measure.id);

  // 3. Diet orders.
  const diet = await createDietOrder({ facilityId, patientId: patient.id, encounterId: enc.id, dietType: "SOFT", restrictions: secret, orderedByStaffId: doctor.id, notes: secret, byUserId: by });
  await setDietOrderStatus({ dietOrderId: diet.id, facilityId, to: "DISCONTINUED", byUserId: by });
  const dE = await keep("DietOrderStatusChanged", diet.id);
  report("Diet order: null>ACTIVE, ACTIVE>DISCONTINUED (SOFT; never the restrictions)", moves(dE) === "null>ACTIVE,ACTIVE>DISCONTINUED" && dE.every((p) => p.dietType === "SOFT"));
  const custom = await createDietOrder({ facilityId, patientId: patient.id, encounterId: enc.id, dietType: `Low salt ${secret}`, orderedByStaffId: doctor.id, byUserId: by });
  report("…a free-text diet type is reported as OTHER, never its text", (await keep("DietOrderStatusChanged", custom.id))[0]?.dietType === "OTHER");

  // 4. Equipment.
  const eq = await createEquipment({ facilityId, assetTag: `EQ-${run}`, category: "MONITOR", byUserId: by });
  await setEquipmentStatus({ equipmentId: eq.id, facilityId, to: "UNDER_MAINTENANCE", byUserId: by });
  await setEquipmentStatus({ equipmentId: eq.id, facilityId, to: "IN_SERVICE", byUserId: by });
  const dt = await startDowntime({ facilityId, reason: secret, equipmentId: eq.id, byStaffId: doctor.id, byUserId: by });
  await endDowntime({ downtimeId: dt.id, facilityId, byUserId: by });
  const eqE = await keep("EquipmentStatusChanged", eq.id);
  report("Equipment status: MANUAL ×2, DOWNTIME_STARTED (IN_SERVICE>OUT_OF_SERVICE), DOWNTIME_ENDED (OUT_OF_SERVICE>IN_SERVICE)",
    eqE.map((p) => `${p.cause}:${p.from}>${p.to}`).join() === "MANUAL:IN_SERVICE>UNDER_MAINTENANCE,MANUAL:UNDER_MAINTENANCE>IN_SERVICE,DOWNTIME_STARTED:IN_SERVICE>OUT_OF_SERVICE,DOWNTIME_ENDED:OUT_OF_SERVICE>IN_SERVICE",
    eqE.map((p) => `${p.cause}:${p.from}>${p.to}`).join());
  const noida = await prisma.biomedicalEquipment.create({ data: { facilityId: "fac-amc-noida", assetTag: `EQN-${run}`, category: "MONITOR" } });
  report("A downtime naming another facility's device is refused", await rejects(startDowntime({ facilityId, reason: "x", equipmentId: noida.id, byStaffId: doctor.id, byUserId: by })));
  const cal = await recordEquipmentCalibration({ equipmentId: eq.id, facilityId, performedByStaffId: doctor.id, result: secret, nextDueAt: new Date("2027-01-01"), byUserId: by });
  const mnt = await recordEquipmentMaintenance({ equipmentId: eq.id, facilityId, maintenanceType: "REPAIR", performedByStaffId: doctor.id, notes: secret, byUserId: by });
  const pm = await schedulePreventiveMaintenance({ facilityId, maintenanceType: "PM", dueAt: new Date(), equipmentId: eq.id, byUserId: by });
  await completePreventiveMaintenance({ pmId: pm.id, facilityId, performedByStaffId: doctor.id, result: secret, byUserId: by });
  const svc = await keep("EquipmentServiceRecorded", eq.id);
  report("Service records: CALIBRATION (next due), MAINTENANCE, PREVENTIVE, each naming its record",
    svc.map((p) => p.serviceKind).join() === "CALIBRATION,MAINTENANCE,PREVENTIVE" && svc[0].recordId === cal.id && svc[1].recordId === mnt.id && svc[2].recordId === pm.id && typeof svc[0].nextDueAt === "string");

  // 5. Infection control.
  const inf = await createInfectionIncident({ facilityId, incidentType: "CAUTI", patientId: patient.id, encounterId: enc.id, isolationRequired: true, reportedByStaffId: doctor.id, notes: secret, byUserId: by });
  const inv = await createInfectionInvestigation({ incidentId: inf.id, facilityId, investigatorStaffId: doctor.id, findings: secret, byUserId: by });
  await transitionInfectionIncident({ incidentId: inf.id, facilityId, to: "UNDER_REVIEW", actorStaffId: admin.id, notes: secret, byUserId: admin.userId });
  const infE = await keep("InfectionIncidentStatusChanged", inf.id);
  report("Infection incident: REPORTED, INVESTIGATION_RECORDED (status unchanged, the investigation), TRANSITION REPORTED>UNDER_REVIEW (CAUTI, isolation)",
    infE.map((p) => `${p.change}:${p.from}>${p.to}`).join() === "REPORTED:null>REPORTED,INVESTIGATION_RECORDED:REPORTED>REPORTED,TRANSITION:REPORTED>UNDER_REVIEW"
      && infE[1].investigationId === inv.id && infE.every((p) => p.incidentType === "CAUTI" && p.isolationRequired === true));
  const exp = await recordExposure({ incidentId: inf.id, facilityId, affectedPersonRef: `Nurse ${secret}`, notes: secret, byUserId: by });
  const expE = await keep("InfectionExposureRecorded", inf.id);
  report("An exposure → InfectionExposureRecorded (SENSITIVE), never the person",
    expE.length === 1 && expE[0].exposureId === exp.id && getEventContract("InfectionExposureRecorded", 1)?.sensitivity === "SENSITIVE");

  // 6. Lab QC and calibration.
  const qcPass = await recordQc({ facilityId, instrumentId: `INS-${run}`, controlType: "NORMAL", observedValue: 5.1, result: "pass", performedByStaffId: doctor.id, notes: secret, byUserId: by });
  const qcFail = await recordQc({ facilityId, instrumentId: `INS-${run}`, controlType: "HIGH", observedValue: 9.9, result: "FAIL", performedByStaffId: doctor.id, byUserId: by });
  await reviewQc({ qcId: qcFail.id, facilityId, to: "REJECTED", reviewedByStaffId: admin.id, byUserId: admin.userId });
  const lcal = await recordCalibration({ facilityId, instrumentId: `INS-${run}`, calibrationType: "TWO_POINT", performedByStaffId: doctor.id, byUserId: by });
  await reviewCalibration({ calibrationId: lcal.id, facilityId, to: "REVIEWED", reviewedByStaffId: admin.id, byUserId: admin.userId });
  const qcE = [...await keep("LabQualityControlRecorded", qcPass.id), ...await keep("LabQualityControlRecorded", qcFail.id), ...await keep("LabQualityControlRecorded", lcal.id)];
  report("Lab QC: a PASS run, a FAIL run then REJECTED, a calibration RECORDED then REVIEWED; never the values or the instrument tag",
    qcE.map((p) => `${p.recordKind}:${p.stage}:${p.outcome ?? "-"}`).join() === "QC:RECORDED:PASS,QC:RECORDED:FAIL,QC:REJECTED:FAIL,CALIBRATION:RECORDED:-,CALIBRATION:REVIEWED:-"
      && !JSON.stringify(qcE).includes("INS-") && !JSON.stringify(qcE).includes("9.9"), qcE.map((p) => `${p.recordKind}:${p.stage}:${p.outcome ?? "-"}`).join());

  // 7. Maintenance requests.
  const mr = await createMaintenanceRequest({ facilityId, issueType: "HVAC", description: secret, equipmentId: eq.id, priority: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
  await transitionMaintenance({ requestId: mr.id, facilityId, to: "TRIAGED", actorStaffId: admin.id, notes: secret, byUserId: admin.userId });
  const mrE = await keep("MaintenanceRequestStatusChanged", mr.id);
  report("Maintenance request: null>REPORTED, REPORTED>TRIAGED (HVAC, URGENT, the device)", moves(mrE) === "null>REPORTED,REPORTED>TRIAGED" && mrE.every((p) => p.issueType === "HVAC" && p.priority === "URGENT" && p.equipmentId === eq.id));

  // 8. No free text.
  report("No payload carries the free text the calls were given", all.length > 30 && !JSON.stringify(all).includes(secret), `${all.length} payloads`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
