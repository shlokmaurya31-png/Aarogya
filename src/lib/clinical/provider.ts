import type { ClinicalCaseFull, ClinicalCaseSummary } from "@/types/clinicalCase";

export interface CaseListFilter {
  specialty?: string;
  difficulty?: string;
  acuity?: string;
  learnerTrack?: string;
  query?: string;
}

/**
 * Every source of educational cases implements this. The case engine and API
 * routes depend only on this interface, never on a concrete provider or on
 * Prisma directly for case *sourcing* — so a future real-data provider is a
 * new class, not a rewrite of everything downstream.
 */
export interface ClinicalCaseProvider {
  readonly id: string;
  listCases(filter?: CaseListFilter): Promise<ClinicalCaseSummary[]>;
  /** Full case including the answer key. Server-only callers (case engine) — never return this directly from a route. */
  getCaseFull(caseId: string): Promise<ClinicalCaseFull | null>;
}

export class NotImplementedProviderError extends Error {
  constructor(providerName: string) {
    super(
      `${providerName} is not implemented in this build. Only SyntheticCaseProvider is active ` +
        `(CLINICAL_DATA_MODE=synthetic). See docs/REAL_CLINICAL_DATA_INTEGRATION.md for what implementing ` +
        `this provider requires (consent/governance layer, de-identification review, institutional sign-off).`
    );
  }
}
