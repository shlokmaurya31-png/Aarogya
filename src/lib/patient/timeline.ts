import { prisma } from "@/lib/db";
import { resolvePatientIdsForRead } from "./merge";

/**
 * The longitudinal timeline (brief §32) is built by reading every typed
 * table and merging into one sorted feed at request time — not by
 * maintaining a separate ClinicalEvent table that duplicates the same
 * data. This is a deliberate architectural choice: a generic event table
 * would become a second source of truth that could drift from the real
 * rows (see docs/CLINICAL_CORE.md §4 for the same reasoning applied to
 * Task, and docs/EVENT_ARCHITECTURE.md for why a real event log is not
 * built yet). Every entry's `sourceType`/`sourceId` links back to the
 * authoritative row.
 */
export interface TimelineEntry {
  id: string;
  timestamp: string;
  type: string;
  summary: string;
  department?: string | null;
  actor?: string | null;
  sourceType: string;
  sourceId: string;
}

export async function buildPatientTimeline(patientId: string): Promise<TimelineEntry[]> {
  const patientIds = await resolvePatientIdsForRead(patientId);

  const [encounters, diagnoses, problems, allergies, vitals, notes, medOrders, labOrders, imagingOrders, tasks, referrals, admissions, specimens, labResults, imagingStudies, imagingReports] =
    await Promise.all([
      prisma.encounter.findMany({ where: { patientId: { in: patientIds } }, include: { department: true } }),
      prisma.diagnosis.findMany({ where: { patientId: { in: patientIds } }, include: { diagnosedBy: { include: { user: true } } } }),
      prisma.problem.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.allergy.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.vital.findMany({ where: { encounter: { patientId: { in: patientIds } } } }),
      prisma.clinicalNote.findMany({ where: { encounter: { patientId: { in: patientIds } } }, include: { author: { include: { user: true } } } }),
      prisma.medicationOrder.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.labOrder.findMany({ where: { patientId: { in: patientIds } }, include: { results: { where: { isCurrent: true } } } }),
      prisma.imagingOrder.findMany({ where: { patientId: { in: patientIds } }, include: { reports: { where: { isCurrent: true } } } }),
      prisma.task.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.referral.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.admission.findMany({ where: { encounter: { patientId: { in: patientIds } } }, include: { discharge: true, bed: true } }),
      prisma.specimen.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.labResult.findMany({ where: { labOrder: { patientId: { in: patientIds } } } }),
      prisma.imagingStudy.findMany({ where: { patientId: { in: patientIds } } }),
      prisma.imagingReport.findMany({ where: { imagingOrder: { patientId: { in: patientIds } } } }),
    ]);

  const entries: TimelineEntry[] = [];

  for (const e of encounters) {
    entries.push({
      id: `encounter-${e.id}`,
      timestamp: e.registeredAt.toISOString(),
      type: "Encounter",
      summary: `${e.type} encounter registered${e.chiefComplaint ? ` — ${e.chiefComplaint}` : ""}`,
      department: e.department?.name,
      sourceType: "Encounter",
      sourceId: e.id,
    });
    if (e.closedAt) {
      entries.push({
        id: `encounter-closed-${e.id}`,
        timestamp: e.closedAt.toISOString(),
        type: "Encounter",
        summary: `${e.type} encounter ${e.status === "CANCELLED" ? "cancelled" : "closed"}`,
        department: e.department?.name,
        sourceType: "Encounter",
        sourceId: e.id,
      });
    }
  }

  for (const d of diagnoses) {
    entries.push({
      id: `diagnosis-${d.id}`,
      timestamp: d.createdAt.toISOString(),
      type: "Diagnosis",
      summary: `${d.type}: ${d.diagnosis}`,
      actor: d.diagnosedBy?.user?.displayName,
      sourceType: "Diagnosis",
      sourceId: d.id,
    });
  }
  for (const p of problems) {
    entries.push({
      id: `problem-${p.id}`,
      timestamp: p.createdAt.toISOString(),
      type: "Problem",
      summary: `Problem list: ${p.diagnosis} (${p.status})`,
      sourceType: "Problem",
      sourceId: p.id,
    });
  }
  for (const a of allergies) {
    entries.push({
      id: `allergy-${a.id}`,
      timestamp: a.recordedAt.toISOString(),
      type: "Allergy",
      summary: `Allergy recorded: ${a.substance} (${a.severity})`,
      sourceType: "Allergy",
      sourceId: a.id,
    });
  }
  for (const v of vitals) {
    entries.push({
      id: `vital-${v.id}`,
      timestamp: v.recordedAt.toISOString(),
      type: "Vital",
      summary: `Vitals: HR ${v.hr ?? "-"}, BP ${v.sbp ?? "-"}/${v.dbp ?? "-"}, SpO2 ${v.spo2 ?? "-"}%`,
      sourceType: "Vital",
      sourceId: v.id,
    });
  }
  for (const n of notes) {
    entries.push({
      id: `note-${n.id}`,
      timestamp: n.createdAt.toISOString(),
      type: "Note",
      summary: `${n.type} note ${n.status === "SIGNED" ? "signed" : n.status.toLowerCase()}`,
      actor: n.author?.user?.displayName,
      sourceType: "ClinicalNote",
      sourceId: n.id,
    });
  }
  for (const m of medOrders) {
    entries.push({
      id: `medorder-${m.id}`,
      timestamp: m.orderedAt.toISOString(),
      type: "Medication",
      summary: `Medication ordered: ${m.drugName} ${m.dose} ${m.route} ${m.frequency}`,
      sourceType: "MedicationOrder",
      sourceId: m.id,
    });
  }
  for (const l of labOrders) {
    const current = l.results[0];
    entries.push({
      id: `lab-${l.id}`,
      timestamp: l.orderedAt.toISOString(),
      type: "Order",
      summary: `Lab ordered: ${l.testName}${current ? ` — result: ${current.value} ${current.unit ?? ""}` : ""}`,
      sourceType: "LabOrder",
      sourceId: l.id,
    });
  }
  for (const s of specimens) {
    if (s.collectedAt) {
      entries.push({ id: `specimen-collected-${s.id}`, timestamp: s.collectedAt.toISOString(), type: "Specimen", summary: `Specimen collected — ${s.specimenType} (${s.accessionNumber})`, sourceType: "Specimen", sourceId: s.id });
    }
    if (s.acceptedAt) {
      entries.push({ id: `specimen-accepted-${s.id}`, timestamp: s.acceptedAt.toISOString(), type: "Specimen", summary: `Specimen accepted — ${s.accessionNumber}`, sourceType: "Specimen", sourceId: s.id });
    }
    if (s.rejectedAt) {
      entries.push({ id: `specimen-rejected-${s.id}`, timestamp: s.rejectedAt.toISOString(), type: "Specimen", summary: `Specimen rejected — ${s.accessionNumber} (${s.rejectedReason ?? "unspecified"})`, sourceType: "Specimen", sourceId: s.id });
    }
    if (s.recollectionOfSpecimenId) {
      entries.push({ id: `specimen-recollected-${s.id}`, timestamp: s.createdAt.toISOString(), type: "Specimen", summary: `Specimen recollected — ${s.accessionNumber}`, sourceType: "Specimen", sourceId: s.id });
    }
  }
  for (const r of labResults) {
    entries.push({ id: `result-entered-${r.id}`, timestamp: r.resultedAt.toISOString(), type: "Result", summary: `Lab result entered${r.isCritical ? " — CRITICAL" : ""}: ${r.value} ${r.unit ?? ""}`, sourceType: "LabResult", sourceId: r.id });
    if (r.verifiedAt) {
      entries.push({ id: `result-verified-${r.id}`, timestamp: r.verifiedAt.toISOString(), type: "Result", summary: "Lab result verified", sourceType: "LabResult", sourceId: r.id });
    }
    if (r.amendedAt) {
      entries.push({ id: `result-amended-${r.id}`, timestamp: r.amendedAt.toISOString(), type: "Result", summary: `Lab result amended: ${r.amendedReason ?? ""}`, sourceType: "LabResult", sourceId: r.id });
    }
  }
  for (const im of imagingOrders) {
    const currentReport = im.reports[0];
    entries.push({
      id: `imaging-${im.id}`,
      timestamp: im.orderedAt.toISOString(),
      type: "Order",
      summary: `${im.modality} ordered: ${im.studyDescription}${currentReport ? ` — ${currentReport.impression}` : ""}`,
      sourceType: "ImagingOrder",
      sourceId: im.id,
    });
  }
  for (const s of imagingStudies) {
    if (s.scheduledAt) {
      entries.push({ id: `study-scheduled-${s.id}`, timestamp: s.scheduledAt.toISOString(), type: "Study", summary: `${s.modality} study scheduled — ${s.accessionNumber}`, sourceType: "ImagingStudy", sourceId: s.id });
    }
    if (s.arrivedAt) {
      entries.push({ id: `study-arrived-${s.id}`, timestamp: s.arrivedAt.toISOString(), type: "Study", summary: `Patient arrived for ${s.modality} study`, sourceType: "ImagingStudy", sourceId: s.id });
    }
    if (s.startedAt) {
      entries.push({ id: `study-started-${s.id}`, timestamp: s.startedAt.toISOString(), type: "Study", summary: `${s.modality} study started`, sourceType: "ImagingStudy", sourceId: s.id });
    }
    if (s.performedAt) {
      entries.push({ id: `study-completed-${s.id}`, timestamp: s.performedAt.toISOString(), type: "Study", summary: `${s.modality} study completed`, sourceType: "ImagingStudy", sourceId: s.id });
    }
  }
  for (const r of imagingReports) {
    entries.push({ id: `imaging-report-entered-${r.id}`, timestamp: r.reportedAt.toISOString(), type: "Result", summary: `Imaging report entered${r.isCritical ? " — CRITICAL" : ""}: ${r.impression}`, sourceType: "ImagingReport", sourceId: r.id });
    if (r.verifiedAt) {
      entries.push({ id: `imaging-report-verified-${r.id}`, timestamp: r.verifiedAt.toISOString(), type: "Result", summary: "Imaging report verified", sourceType: "ImagingReport", sourceId: r.id });
    }
    if (r.acknowledgedAt) {
      entries.push({ id: `imaging-report-acknowledged-${r.id}`, timestamp: r.acknowledgedAt.toISOString(), type: "Result", summary: "Critical imaging finding acknowledged", sourceType: "ImagingReport", sourceId: r.id });
    }
    if (r.amendedAt) {
      entries.push({ id: `imaging-report-amended-${r.id}`, timestamp: r.amendedAt.toISOString(), type: "Result", summary: `Imaging report amended: ${r.amendedReason ?? ""}`, sourceType: "ImagingReport", sourceId: r.id });
    }
  }
  for (const t of tasks) {
    entries.push({
      id: `task-${t.id}`,
      timestamp: t.createdAt.toISOString(),
      type: "Task",
      summary: `Task created: ${t.title} (${t.status})`,
      sourceType: "Task",
      sourceId: t.id,
    });
  }
  for (const r of referrals) {
    entries.push({
      id: `referral-${r.id}`,
      timestamp: r.createdAt.toISOString(),
      type: "Referral",
      summary: `Referral: ${r.reason} (${r.status})`,
      sourceType: "Referral",
      sourceId: r.id,
    });
  }
  for (const a of admissions) {
    entries.push({
      id: `admission-${a.id}`,
      timestamp: a.admittedAt.toISOString(),
      type: "Admission",
      summary: `Admitted — bed ${a.bed.label}: ${a.reason}`,
      sourceType: "Admission",
      sourceId: a.id,
    });
    if (a.discharge?.dischargedAt) {
      entries.push({
        id: `discharge-${a.discharge.id}`,
        timestamp: a.discharge.dischargedAt.toISOString(),
        type: "Discharge",
        summary: "Discharged",
        sourceType: "Discharge",
        sourceId: a.discharge.id,
      });
    }
  }

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
