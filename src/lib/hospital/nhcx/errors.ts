/**
 * Phase C5 — normalized NHCX error model.
 *
 * Mirrors the C2 interoperability error model rather than inventing a second
 * vocabulary, because the job is identical: turn every external failure into
 * one internal classification, and decide retry safety from the CLASS.
 *
 * Retry safety is a correctness control here, not a convenience. A claim
 * submission that partially applied remotely and is blindly retried can create
 * a duplicate claim at the payer — which is a financial error, not a glitch.
 */

export const NHCX_ERROR_CATEGORIES = [
  "VALIDATION",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
  "PROTOCOL",
  "DUPLICATE",
  "CONFLICT",
  "EXTERNAL_SYSTEM",
  "CONFIGURATION",
  "UNKNOWN",
] as const;

export type NhcxErrorCategory = (typeof NHCX_ERROR_CATEGORIES)[number];

/**
 * Only genuinely transient categories retry.
 *
 * DUPLICATE is explicitly NOT retryable: the external side already has the
 * request, and resending is precisely what would create a second claim.
 */
const RETRYABLE: Record<NhcxErrorCategory, boolean> = {
  VALIDATION: false,
  AUTHENTICATION: false,
  AUTHORIZATION: false,
  RATE_LIMIT: true,
  NETWORK: true,
  TIMEOUT: true,
  PROTOCOL: false,
  DUPLICATE: false,
  CONFLICT: false,
  EXTERNAL_SYSTEM: true,
  CONFIGURATION: false,
  UNKNOWN: false,
};

export function isRetryableCategory(category: NhcxErrorCategory): boolean {
  return RETRYABLE[category];
}

export class NhcxError extends Error {
  readonly category: NhcxErrorCategory;
  readonly retryable: boolean;
  readonly correlationId: string | null;
  readonly externalCode: string | null;
  readonly httpStatus: number | null;

  constructor(args: {
    category: NhcxErrorCategory;
    message: string;
    correlationId?: string | null;
    externalCode?: string | null;
    httpStatus?: number | null;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "NhcxError";
    this.category = args.category;
    this.retryable = args.retryable ?? isRetryableCategory(args.category);
    this.correlationId = args.correlationId ?? null;
    this.externalCode = args.externalCode ?? null;
    this.httpStatus = args.httpStatus ?? null;
  }

  /**
   * What a user may see. Deliberately omits the external code and HTTP status:
   * protocol internals are operator detail, not end-user detail.
   */
  toPublic() {
    return { category: this.category, message: this.message, retryable: this.retryable, correlationId: this.correlationId };
  }
}

export function categoryFromHttpStatus(status: number): NhcxErrorCategory {
  if (status === 400 || status === 422) return "VALIDATION";
  if (status === 401) return "AUTHENTICATION";
  if (status === 403) return "AUTHORIZATION";
  if (status === 404) return "PROTOCOL";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL_SYSTEM";
  return "UNKNOWN";
}

export function configurationError(message: string): NhcxError {
  return new NhcxError({ category: "CONFIGURATION", message });
}

export function validationError(message: string): NhcxError {
  return new NhcxError({ category: "VALIDATION", message });
}

/**
 * Exponential backoff for a retryable failure. Bounded and capped; there is no
 * path that retries forever.
 */
export function nextRetryDelayMs(attempt: number, category: NhcxErrorCategory): number | null {
  if (!isRetryableCategory(category)) return null;
  // Rate limiting backs off harder than a transient network blip.
  const base = category === "RATE_LIMIT" ? 60_000 : 15_000;
  return Math.min(base * 2 ** Math.max(0, attempt), 30 * 60_000);
}
