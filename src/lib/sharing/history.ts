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

  // The person's own uploads and confirmed entries: only with UPLOADS, and each entry only with its own category too.
  let uploads: { documents: { id: string; title: string; type: string; uploadedAt: string }[]; entries: { id: string; kind: string; text: string; date: string }[] } | undefined;
  if (has("UPLOADS") && scope.personId) {
    const docs = await prisma.personDocument.findMany({ where: { personId: scope.personId, status: "CURRENT", type: { not: "ID_PROOF" } }, orderBy: { uploadedAt: "desc" }, take: 50 });
    const entries = await prisma.patientProvidedRecord.findMany({ where: { personId: scope.personId, status: "ACTIVE" }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], take: 100 });
    uploads = {
      documents: docs.filter((d) => when(d.uploadedAt) && ok(texts(d.title))).map((d) => ({ id: d.id, title: d.title, type: d.type, uploadedAt: d.uploadedAt.toISOString() })),
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
    allergies, medicationOrders, labResults, imagingReports, dischargeSummaries, uploads,
  };
}
export type ShareHistory = NonNullable<Awaited<ReturnType<typeof shareHistory>>>;
