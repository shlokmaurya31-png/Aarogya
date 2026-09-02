import { prisma } from "@/lib/db";
import type { ClinicalCaseProvider, CaseListFilter } from "../provider";
import type {
  ClinicalCaseFull,
  ClinicalCaseSummary,
  CaseContent,
  ScoringRubric,
  VivaQuestion,
  Difficulty,
  Acuity,
  CaseSourceType,
  LearningTrack,
} from "@/types/clinicalCase";

function toSummary(row: {
  id: string;
  slug: string;
  title: string;
  specialty: string;
  subspecialty: string | null;
  difficulty: string;
  acuity: string;
  sourceType: string;
  learnerTracks: string;
  patientName: string;
  patientAgeBand: string;
  patientSex: string;
  chiefComplaint: string;
  isPublished: boolean;
}): ClinicalCaseSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    specialty: row.specialty,
    subspecialty: row.subspecialty,
    difficulty: row.difficulty as Difficulty,
    acuity: row.acuity as Acuity,
    sourceType: row.sourceType as CaseSourceType,
    learnerTracks: JSON.parse(row.learnerTracks) as LearningTrack[],
    patientName: row.patientName,
    patientAgeBand: row.patientAgeBand,
    patientSex: row.patientSex,
    chiefComplaint: row.chiefComplaint,
    isPublished: row.isPublished,
  };
}

/**
 * The only active ClinicalCaseProvider. Reads cases seeded/authored with
 * sourceType SYNTHETIC (or INSTITUTION_AUTHORED, for the educator-authoring
 * flow — still not real patient data) from the local database.
 */
export class SyntheticCaseProvider implements ClinicalCaseProvider {
  readonly id = "synthetic";

  async listCases(filter: CaseListFilter = {}): Promise<ClinicalCaseSummary[]> {
    const rows = await prisma.clinicalCase.findMany({
      where: {
        isPublished: true,
        ...(filter.specialty ? { specialty: filter.specialty } : {}),
        ...(filter.difficulty ? { difficulty: filter.difficulty as Difficulty } : {}),
        ...(filter.acuity ? { acuity: filter.acuity as Acuity } : {}),
        ...(filter.query
          ? {
              OR: [
                { title: { contains: filter.query } },
                { chiefComplaint: { contains: filter.query } },
                { specialty: { contains: filter.query } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    const summaries = rows.map(toSummary);
    if (filter.learnerTrack) {
      return summaries.filter((s) => s.learnerTracks.includes(filter.learnerTrack as LearningTrack));
    }
    return summaries;
  }

  async getCaseFull(caseId: string): Promise<ClinicalCaseFull | null> {
    const row = await prisma.clinicalCase.findUnique({ where: { id: caseId } });
    if (!row) return null;
    return {
      ...toSummary(row),
      learningObjectives: JSON.parse(row.learningObjectives) as string[],
      content: row.content as unknown as CaseContent,
      referenceDx: row.referenceDx,
      rubric: row.rubric as unknown as ScoringRubric,
      viva: row.viva as unknown as VivaQuestion[],
    };
  }
}
