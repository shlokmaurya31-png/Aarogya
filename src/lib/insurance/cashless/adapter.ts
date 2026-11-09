/**
 * Flagship 5, step 5 — the cashless exchange, as an adapter
 * (docs/CASHLESS_CLAIMS_DESIGN.md §10; ADR 0003).
 *
 * In NHCX's flow the hospital (the provider) sends an eligibility check, a
 * pre-authorisation request and answers to the insurer's queries; the
 * insurer (or TPA) answers asynchronously. The hospital side needs only this
 * interface. The insurer's answers arrive as messages, each with its own
 * external id (`receiveInsurerResponse` in ./service.ts).
 *
 * The NHCX protocol, its FHIR profiles and its field names are to be
 * confirmed against the official specification before a real adapter is
 * written (design §2: no code against a guessed contract). Until then the
 * MOCK is the only adapter: `cashlessExchange()` refuses any other mode, as
 * Scan and Share does. The mock never makes a network call; it keeps what it
 * was sent, so the gates can prove exactly which documents left.
 */
export interface EligibilityCheck { correlationId: string; payerId: string | null; memberIdLast4: string }
export interface PreAuthSubmission { correlationId: string; requestId: string; estimateMinor: number; diagnosis: string; plannedProcedure: string; documents: { id: string; title: string }[] }
export interface QueryAnswer { correlationId: string; requestId: string; answer: string; documents: { id: string; title: string }[] }

export interface CashlessExchange {
  readonly mode: "MOCK";
  checkEligibility(input: EligibilityCheck): Promise<{ result: "ELIGIBLE" | "NOT_ELIGIBLE" }>;
  submitPreAuth(input: PreAuthSubmission): Promise<{ accepted: true }>;
  answerQuery(input: QueryAnswer): Promise<{ accepted: true }>;
}

/** What the mock was sent (for the gates; never a real call). */
export const mockSent: ({ kind: "ELIGIBILITY" } & EligibilityCheck | { kind: "PREAUTH" } & PreAuthSubmission | { kind: "QUERY_ANSWER" } & QueryAnswer)[] = [];
const keep = (x: (typeof mockSent)[number]) => {
  mockSent.push(x);
  if (mockSent.length > 1000) mockSent.splice(0, mockSent.length - 1000);
};

const mock: CashlessExchange = {
  mode: "MOCK",
  async checkEligibility(input) {
    keep({ kind: "ELIGIBILITY", ...input });
    // The mock's "not eligible": no listed payer, or a member id ending 0000 (so the refusal path can be exercised).
    return { result: input.payerId && input.memberIdLast4 !== "0000" ? "ELIGIBLE" : "NOT_ELIGIBLE" };
  },
  async submitPreAuth(input) {
    keep({ kind: "PREAUTH", ...input });
    return { accepted: true };
  },
  async answerQuery(input) {
    keep({ kind: "QUERY_ANSWER", ...input });
    return { accepted: true };
  },
};

export function cashlessExchange(): CashlessExchange {
  const mode = process.env.NHCX_CASHLESS_MODE ?? "mock";
  if (mode !== "mock") throw new Error(`NHCX_CASHLESS_MODE=${mode} is not available: only the mock exists until the NHCX specification is confirmed (docs/CASHLESS_CLAIMS_DESIGN.md §2).`);
  return mock;
}
