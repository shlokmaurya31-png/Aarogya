/**
 * Phase C2 — normalized interoperability error model.
 *
 * Two jobs:
 *
 *  1. Turn every external failure — HTTP status, ABDM error envelope, transport
 *     exception — into ONE internal vocabulary, so callers reason about
 *     failures without knowing ABDM's wire format.
 *
 *  2. Decide retry safety. This is a correctness control, not a convenience:
 *     retrying a VALIDATION_ERROR or CONSENT_ERROR cannot succeed and, for an
 *     operation that partially applied remotely, retrying an AUTHORIZATION_ERROR
 *     can duplicate a disclosure. Only genuinely transient classes retry.
 *
 * Nothing here ever carries a token, a certificate, a key or a clinical payload
 * into a message that reaches a user or a log.
 */

export const INTEROP_ERROR_KINDS = [
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "VALIDATION_ERROR",
  "CONSENT_ERROR",
  "IDENTITY_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "EXTERNAL_SERVER_ERROR",
  "CALLBACK_ERROR",
  "UNKNOWN_EXTERNAL_ERROR",
] as const;

export type InteropErrorKind = (typeof INTEROP_ERROR_KINDS)[number];

/**
 * Retry policy per error kind.
 *
 * RATE_LIMITED is retryable but deliberately backs off harder than a network
 * blip. Everything a caller could fix by changing the request is NOT retryable,
 * because retrying it unchanged just burns the budget and delays the operator
 * seeing a real problem.
 */
const RETRYABLE: Record<InteropErrorKind, boolean> = {
  CONFIGURATION_ERROR: false,
  AUTHENTICATION_ERROR: false,
  AUTHORIZATION_ERROR: false,
  VALIDATION_ERROR: false,
  CONSENT_ERROR: false,
  IDENTITY_ERROR: false,
  NOT_FOUND: false,
  CONFLICT: false,
  RATE_LIMITED: true,
  TIMEOUT: true,
  NETWORK_ERROR: true,
  EXTERNAL_SERVER_ERROR: true,
  CALLBACK_ERROR: false,
  UNKNOWN_EXTERNAL_ERROR: false,
};

export function isRetryableKind(kind: InteropErrorKind): boolean {
  return RETRYABLE[kind];
}

export interface InteropErrorShape {
  kind: InteropErrorKind;
  /** Operator-facing summary. Never contains a secret or clinical content. */
  message: string;
  /** ABDM error code such as ABDM-1001, when the gateway supplied one. */
  externalCode?: string | null;
  httpStatus?: number | null;
  retryable: boolean;
  /** Correlation for cross-referencing logs and provenance. */
  requestId?: string | null;
}

export class InteropError extends Error {
  readonly kind: InteropErrorKind;
  readonly externalCode: string | null;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(shape: Omit<InteropErrorShape, "retryable"> & { retryable?: boolean }) {
    super(shape.message);
    this.name = "InteropError";
    this.kind = shape.kind;
    this.externalCode = shape.externalCode ?? null;
    this.httpStatus = shape.httpStatus ?? null;
    this.retryable = shape.retryable ?? isRetryableKind(shape.kind);
    this.requestId = shape.requestId ?? null;
  }

  toShape(): InteropErrorShape {
    return {
      kind: this.kind,
      message: this.message,
      externalCode: this.externalCode,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      requestId: this.requestId,
    };
  }
}

/**
 * Map an HTTP status onto the internal vocabulary (ABDM M3 doc documents 200,
 * 202, 400 and 403 explicitly; the rest follow standard semantics).
 */
export function kindFromHttpStatus(status: number): InteropErrorKind {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "AUTHENTICATION_ERROR";
  if (status === 403) return "AUTHORIZATION_ERROR";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL_SERVER_ERROR";
  return "UNKNOWN_EXTERNAL_ERROR";
}

/** Extract `{"error":{"code","message"}}` without trusting its shape. */
export function readAbdmErrorEnvelope(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const err = (body as Record<string, unknown>).error;
  if (!err || typeof err !== "object") return { code: null, message: null };
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return {
    code: typeof code === "string" ? code.slice(0, 64) : null,
    // Truncated: an external message is untrusted text and must never be able
    // to flood a log line or smuggle a payload into one.
    message: typeof message === "string" ? message.slice(0, 300) : null,
  };
}

/**
 * Build an InteropError from a real HTTP response. The ABDM error code is
 * preserved for operators, but the classification that drives retry comes from
 * the status, not from the external message text.
 */
export function fromHttpResponse(args: {
  status: number;
  body: unknown;
  requestId?: string | null;
  operation: string;
}): InteropError {
  const envelope = readAbdmErrorEnvelope(args.body);
  const kind = kindFromHttpStatus(args.status);
  const detail = envelope.message ? ` ${envelope.message}` : "";
  const code = envelope.code ? ` [${envelope.code}]` : "";
  return new InteropError({
    kind,
    message: `ABDM ${args.operation} failed with HTTP ${args.status}${code}.${detail}`,
    externalCode: envelope.code,
    httpStatus: args.status,
    requestId: args.requestId ?? null,
  });
}

/** Classify a thrown transport exception (DNS failure, refused socket, abort). */
export function fromTransportException(args: {
  error: unknown;
  operation: string;
  requestId?: string | null;
}): InteropError {
  const raw = args.error;
  const name = (raw as { name?: string })?.name ?? "";
  const code = (raw as { code?: string })?.code ?? "";
  const text = raw instanceof Error ? raw.message : String(raw);

  if (name === "AbortError" || name === "TimeoutError" || /timeout|timed out/i.test(text)) {
    return new InteropError({
      kind: "TIMEOUT",
      message: `ABDM ${args.operation} timed out before the gateway responded.`,
      requestId: args.requestId ?? null,
    });
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|UND_ERR/i.test(`${code} ${text}`)) {
    return new InteropError({
      kind: "NETWORK_ERROR",
      // The host is named (it is public configuration), but nothing else is.
      message: `ABDM ${args.operation} could not reach the gateway.`,
      requestId: args.requestId ?? null,
    });
  }
  return new InteropError({
    kind: "UNKNOWN_EXTERNAL_ERROR",
    message: `ABDM ${args.operation} failed for an unrecognised reason.`,
    requestId: args.requestId ?? null,
  });
}

export function configurationError(message: string): InteropError {
  return new InteropError({ kind: "CONFIGURATION_ERROR", message });
}

export function callbackError(message: string): InteropError {
  return new InteropError({ kind: "CALLBACK_ERROR", message });
}

/**
 * Public projection. Deliberately drops anything an end user must not see, and
 * is what routes serialise — so a token or certificate cannot escape even if a
 * future error accidentally captures one.
 */
export function toPublicError(error: InteropError) {
  return {
    kind: error.kind,
    message: error.message,
    externalCode: error.externalCode,
    retryable: error.retryable,
    requestId: error.requestId,
  };
}
