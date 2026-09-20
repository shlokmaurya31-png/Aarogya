import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing reports (brief §18, §51).
 *
 * Release control is absolute: a lab/imaging report reaches the patient ONLY
 * when it is clinician-VERIFIED and the current version (draft ENTERED results
 * and superseded versions never appear). Documents reach the patient ONLY when
 * their accessPolicy is PATIENT_VISIBLE — CLINICAL_STAFF and RESTRICTED are
 * never exposed, even for the patient's own record. The patient UI can never
 * bypass these gates because the gate lives in the query, not the client.
 */

export interface ReportDTO {
  id: string;
  kind: "LAB" | "IMAGING" | "DOCUMENT";
  title: string;
  date: string;
  status: "RELEASED_TO_PATIENT";
  facility: string | null;
  downloadable: boolean;
}

export async function listReports(scope: PatientAccessScope): Promise<ReportDTO[]> {
  assertClass(scope, "REPORTS");
  const [labs, imaging, documents] = await Promise.all([
    prisma.labResult.findMany({
      where: { status: "VERIFIED", isCurrent: true, labOrder: { patientId: { in: scope.patientIds } } },
      orderBy: { verifiedAt: "desc" },
      take: 100,
      include: { labOrder: { select: { testName: true } } },
    }),
    prisma.imagingReport.findMany({
      where: { status: "VERIFIED", isCurrent: true, imagingOrder: { patientId: { in: scope.patientIds } } },
      orderBy: { verifiedAt: "desc" },
      take: 100,
      include: { imagingOrder: { select: { modality: true, studyDescription: true } } },
    }),
    prisma.clinicalDocument.findMany({
      where: { patientId: { in: scope.patientIds }, status: "CURRENT", accessPolicy: "PATIENT_VISIBLE" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { facility: { select: { name: true } } },
    }),
  ]);

  const out: ReportDTO[] = [];
  for (const r of labs) {
    out.push({
      id: `lab:${r.id}`, kind: "LAB", title: r.labOrder.testName,
      date: (r.verifiedAt ?? r.resultedAt).toISOString(), status: "RELEASED_TO_PATIENT",
      facility: null, downloadable: false,
    });
  }
  for (const r of imaging) {
    const title = [r.imagingOrder.modality, r.imagingOrder.studyDescription].filter(Boolean).join(" · ") || "Imaging report";
    out.push({
      id: `imaging:${r.id}`, kind: "IMAGING", title,
      date: (r.verifiedAt ?? r.reportedAt).toISOString(), status: "RELEASED_TO_PATIENT",
      facility: null, downloadable: false,
    });
  }
  for (const d of documents) {
    out.push({
      id: `document:${d.id}`, kind: "DOCUMENT", title: d.title,
      date: d.createdAt.toISOString(), status: "RELEASED_TO_PATIENT",
      facility: d.facility?.name ?? null, downloadable: Boolean(d.storageRef),
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

/**
 * Authorized document retrieval (brief §51). Returns the storage reference ONLY
 * after re-verifying ownership + release status + non-restricted classification
 * server-side. A storage URL is never exposed directly and never derived from a
 * client-supplied path. Returns an explicit unavailable state when no file is
 * actually attached rather than a broken link.
 */
export async function getDocumentForDownload(
  scope: PatientAccessScope,
  documentId: string,
): Promise<{ available: true; title: string; storageRef: string } | { available: false; reason: "NO_FILE_ATTACHED" }> {
  assertClass(scope, "REPORTS");
  const doc = await prisma.clinicalDocument.findUnique({ where: { id: documentId } });
  // 404-shaped for: nonexistent, not ours, not released, or restricted.
  if (
    !doc ||
    !scope.patientIds.includes(doc.patientId) ||
    doc.status !== "CURRENT" ||
    doc.accessPolicy !== "PATIENT_VISIBLE"
  ) {
    throw new NotFoundError();
  }
  if (!doc.storageRef) return { available: false, reason: "NO_FILE_ATTACHED" };
  return { available: true, title: doc.title, storageRef: doc.storageRef };
}
