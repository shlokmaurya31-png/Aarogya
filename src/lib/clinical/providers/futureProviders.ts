/**
 * Documented-but-not-implemented providers. These exist so the interface
 * shape (ClinicalCaseProvider) is reviewable end-to-end, and so a future
 * implementer has a concrete class to fill in rather than a design doc only.
 * None of these are reachable from any environment variable — see
 * src/lib/clinical/config.ts and docs/REAL_CLINICAL_DATA_INTEGRATION.md.
 */
import type { ClinicalCaseProvider, CaseListFilter } from "../provider";
import { NotImplementedProviderError } from "../provider";
import type { ClinicalCaseFull, ClinicalCaseSummary } from "@/types/clinicalCase";

/** Would read from a governed, de-identified feed produced by the Clinical Learning Data Gateway once a real consent/authorization layer exists upstream of it. */
export class DeidentifiedClinicalFeedProvider implements ClinicalCaseProvider {
  readonly id = "deidentified-clinical-feed";
  async listCases(filter?: CaseListFilter): Promise<ClinicalCaseSummary[]> {
    void filter;
    throw new NotImplementedProviderError("DeidentifiedClinicalFeedProvider");
  }
  async getCaseFull(caseId: string): Promise<ClinicalCaseFull | null> {
    void caseId;
    throw new NotImplementedProviderError("DeidentifiedClinicalFeedProvider");
  }
}

/** Would read from a curated archive of historical, already-de-identified teaching cases (e.g. published case reports with institutional permission). */
export class HistoricalTeachingCaseProvider implements ClinicalCaseProvider {
  readonly id = "historical-teaching-case";
  async listCases(filter?: CaseListFilter): Promise<ClinicalCaseSummary[]> {
    void filter;
    throw new NotImplementedProviderError("HistoricalTeachingCaseProvider");
  }
  async getCaseFull(caseId: string): Promise<ClinicalCaseFull | null> {
    void caseId;
    throw new NotImplementedProviderError("HistoricalTeachingCaseProvider");
  }
}

/** Would read cases scoped to a single institution's own authored/approved content, isolated from other institutions' cohorts. */
export class InstitutionCaseProvider implements ClinicalCaseProvider {
  readonly id = "institution-case";
  constructor(private readonly institutionId: string) {}
  async listCases(filter?: CaseListFilter): Promise<ClinicalCaseSummary[]> {
    void filter;
    throw new NotImplementedProviderError(`InstitutionCaseProvider(${this.institutionId})`);
  }
  async getCaseFull(caseId: string): Promise<ClinicalCaseFull | null> {
    void caseId;
    throw new NotImplementedProviderError(`InstitutionCaseProvider(${this.institutionId})`);
  }
}
