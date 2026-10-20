import type { RagSensitiveCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sensitiveCategoryOf } from "@/lib/rag/sensitivity";
import { describePatientProvided } from "@/lib/documents/merge";
import { inPeriod, PROVIDED_KIND_CATEGORY } from "./categories";
import type { ShareScope } from "./resolve";

/**
 * Week 4c — what a share shows (docs/CONSENT_SHARING_DESIGN.md §2, §6, §8):
 * only the shared categories, entries recorded inside the period, and no
 * sensitive item unless its category was opted in. A section that isn't
 * shared is absent (undefined), and a withheld item leaves no placeholder.
 * The same filters decide which uploads a share's doctor may open
 * (sharedDocumentVisible, used by the signed-URL download).
 * Allergies are always shown (the safety minimum), sensitive ones still
 * filtered, and not limited by the period (they are current state).
 */
const texts = (...xs: unknown[]) => xs.filter((x): x is string => typeof x === "string" && x.length > 0);
function flatten(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(flatten);
  if (v && typeof v === "object") return Object.values(v).flatMap(flatten);
  return [];
}

export function sensitiveAllowed(allowed: readonly RagSensitiveCategory[], input: { code?: string | null; texts: string[] }): boolean {
  const cat = sensitiveCategoryOf(input);
  return !cat || allowed.includes(cat);
}

/**
 * May a share's doctor see (and open) this upload? Only with UPLOADS, the
 * share's own person, a current document that isn't an ID proof, uploaded
 * inside the period, and not sensitive unless opted in.
 */
export function sharedDocumentVisible(scope: ShareScope, doc: { personId: string; status: string; type: string; title: string; uploadedAt: Date }): boolean {
  return scope.categories.includes("UPLOADS") && !!scope.personId && doc.personId === scope.personId && doc.status === "CURRENT" && doc.type !== "ID_PROOF"
    && inPeriod(doc.uploadedAt, scope.recordedFrom, scope.recordedTo) && sensitiveAllowed(scope.sensitive, { texts: texts(doc.title) });
}

export async function shareHistory(scope: ShareScope) {
  const has = (c: string) => scope.categories.includes(c as never);
  const ok = (t: string[], code?: string | null) => sensitiveAllowed(scope.sensitive, { code, texts: t });
  const when = (at: Date | null | undefined) => inPeriod(at, scope.recordedFrom, scope.recordedTo);
  const ids = scope.patientIds;

  const patient = await prisma.patient.findUnique({ where: { id: scope.subjectPatientId }, select: { id: true, fullName: true, uhid: true, sex: true, dob: true, dobPrecision: true, bloodGroup: true } });
  if (!patient) return null;

  const allergies = (await prisma.allergy.findMany({ where: { patientId: { in: ids }, status: "ACTIVE" }, orderBy: { recordedAt: "desc" }, take: 100 }))
    .filter((a) => ok(texts(a.substance, a.reaction)))
    .map((a) => ({ id: a.id, substance: a.substance, reaction: a.reaction, severity: a.severity, verification: a.verification }));

  const medicationOrders = has("PRESCRIPTIONS")
    ? (await prisma.medicationOrder.findMany({ where: { patientId: { in: ids } }, orderBy: { orderedAt: "desc" }, take: 100 }))
      .filter((m) => when(m.orderedAt) && ok(texts(m.drugName)))
      .map((m) => ({ id: m.id, drugName: m.drugName, dose: m.dose, route: m.route, frequency: m.frequency, status: m.status, createdAt: m.orderedAt.toISOString() }))
    : undefined;

  const labResults = has("LABS")
    ? (await prisma.labResult.findMany({
      where: { labOrder: { patientId: { in: ids } }, status: { in: ["VERIFIED", "AMENDED"] }, isCurrent: true },
      orderBy: { resultedAt: "desc" }, take: 100,
      include: { catalogTest: { select: { name: true } }, labOrder: { select: { testName: true } } },
    }))
      .filter((r) => when(r.resultedAt) && ok(texts(r.labOrder.testName, r.catalogTest?.name, r.value)))
      .map((r) => ({ id: r.id, test: r.catalogTest?.name ?? r.labOrder.testName, value: r.value, unit: r.unit, flag: r.abnormalFlag, resultedAt: r.resultedAt.toISOString() }))
    : undefined;

  const imagingReports = has("IMAGING")
    ? (await prisma.imagingReport.findMany({
      where: { imagingOrder: { patientId: { in: ids } }, status: { in: ["VERIFIED", "AMENDED"] }, isCurrent: true },
      orderBy: { reportedAt: "desc" }, take: 50, include: { imagingOrder: { select: { modality: true, studyDescription: true } } },
    }))
      .filter((r) => when(r.reportedAt) && ok(texts(r.imagingOrder.studyDescription, r.findings, r.impression)))
      .map((r) => ({ id: r.id, study: [r.imagingOrder.modality, r.imagingOrder.studyDescription].filter(Boolean).join(" · "), impression: r.impression, reportedAt: r.reportedAt.toISOString() }))
    : undefined;

  const dischargeSummaries = has("DISCHARGE_SUMMARIES")
    ? (await prisma.discharge.findMany({ where: { dischargedAt: { not: null }, admission: { encounter: { patientId: { in: ids } } } }, orderBy: { dischargedAt: "desc" }, take: 20, select: { id: true, dischargedAt: true, dischargeType: true, dischargeSummary: true } }))
      .filter((d) => when(d.dischargedAt) && ok(flatten(d.dischargeSummary)))
      .map((d) => ({ id: d.id, dischargedAt: d.dischargedAt!.toISOString(), dischargeType: d.dischargeType, summary: d.dischargeSummary }))
    : undefined;

  // 4c fix (§15): diagnoses and the problem list, vitals and signed clinical notes, each only with its category.
  const conditions = has("CONDITIONS")
    ? {
      diagnoses: (await prisma.diagnosis.findMany({ where: { patientId: { in: ids }, status: { not: "ENTERED_IN_ERROR" } }, orderBy: { createdAt: "desc" }, take: 100 }))
        .filter((d) => when(d.createdAt) && ok(texts(d.diagnosis, d.codeDisplay), d.code))
        .map((d) => ({ id: d.id, diagnosis: d.diagnosis, code: d.code, type: d.type, status: d.status, recordedAt: d.createdAt.toISOString() })),
      problems: (await prisma.problem.findMany({ where: { patientId: { in: ids }, OR: [{ verificationStatus: null }, { verificationStatus: { notIn: ["ENTERED_IN_ERROR", "REFUTED"] } }] }, orderBy: { createdAt: "desc" }, take: 100 }))
        .filter((p) => when(p.createdAt) && ok(texts(p.diagnosis, p.codeDisplay), p.code))
        .map((p) => ({ id: p.id, diagnosis: p.diagnosis, code: p.code, status: p.status, severity: p.severity, recordedAt: p.createdAt.toISOString() })),
    }
    : undefined;

  const vitals = has("VITALS")
    ? (await prisma.vital.findMany({ where: { encounter: { patientId: { in: ids } } }, orderBy: { recordedAt: "desc" }, take: 50 }))
      .filter((v) => when(v.recordedAt))
      .map((v) => ({ id: v.id, hr: v.hr, sbp: v.sbp, dbp: v.dbp, rr: v.rr, spo2: v.spo2, tempC: v.tempC, recordedAt: v.recordedAt.toISOString() }))
    : undefined;

  const clinicalNotes = has("CLINICAL_NOTES")
    ? (await prisma.clinicalNote.findMany({ where: { encounter: { patientId: { in: ids } }, status: { in: ["SIGNED", "AMENDED"] } }, orderBy: { createdAt: "desc" }, take: 30 }))
      .filter((n) => when(n.signedAt ?? n.createdAt) && ok(flatten(n.content)))
      .map((n) => ({ id: n.id, type: n.type, content: n.content, signedAt: (n.signedAt ?? n.createdAt).toISOString() }))
    : undefined;

  // The person's own uploads and confirmed entries: only with UPLOADS, and each entry only with its own category too.
  let uploads: { documents: { id: string; title: string; type: string; uploadedAt: string }[]; entries: { id: string; kind: string; text: string; date: string }[] } | undefined;
  if (has("UPLOADS") && scope.personId) {
    const docs = await prisma.personDocument.findMany({ where: { personId: scope.personId, status: "CURRENT", type: { not: "ID_PROOF" } }, orderBy: { uploadedAt: "desc" }, take: 50 });
    const entries = await prisma.patientProvidedRecord.findMany({ where: { personId: scope.personId, status: "ACTIVE" }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], take: 100 });
    uploads = {
      documents: docs.filter((d) => sharedDocumentVisible(scope, d)).map((d) => ({ id: d.id, title: d.title, type: d.type, uploadedAt: d.uploadedAt.toISOString() })),
      entries: entries
        .filter((e) => {
          const need = PROVIDED_KIND_CATEGORY[e.kind];
          return need !== null && need !== undefined && (need === "ALWAYS" || has(need)) && when(e.effectiveDate ?? e.createdAt) && ok(flatten(e.value));
        })
        .map((e) => ({ id: e.id, kind: e.kind, text: describePatientProvided(e), date: (e.effectiveDate ?? e.createdAt).toISOString() })),
    };
  }

  return {
    patient,
    shared: {
      categories: scope.categories, sensitiveCategories: scope.sensitive, legacy: scope.legacy,
      period: { from: scope.recordedFrom?.toISOString() ?? null, to: scope.recordedTo?.toISOString() ?? null },
      expiresAt: scope.expiresAt?.toISOString() ?? null, via: scope.via,
    },
    allergies, medicationOrders, labResults, imagingReports, dischargeSummaries, conditions, vitals, clinicalNotes, uploads,
  };
}
export type ShareHistory = NonNullable<Awaited<ReturnType<typeof shareHistory>>>;
