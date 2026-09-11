import type { AuthorizationResult } from "./types";

/**
 * Phase C4 — authorization denial as a typed error.
 *
 * Carries the structured decision so a route can offer the right next step
 * (obtain consent, activate emergency access, re-authenticate) while the
 * CLIENT-FACING message stays deliberately uninformative. In particular a
 * cross-facility or unrelated-patient denial is reported as a plain "Not found."
 * so the response cannot be used to probe another tenant.
 */
export class AuthorizationDeniedError extends Error {
  readonly status: number;
  readonly decision: AuthorizationResult["decision"];
  readonly policy: string;
  readonly relationship: string;
  readonly dataClass: string;

  constructor(result: AuthorizationResult) {
    super(result.reason);
    this.name = "AuthorizationDeniedError";
    this.status = result.httpStatus;
    this.decision = result.decision;
    this.policy = result.policy;
    this.relationship = result.relationship;
    this.dataClass = result.dataClass;
  }

  /**
   * What the route body should contain. `decision` is included so a UI can
   * distinguish "ask for consent" from "flat refusal", but nothing about WHY
   * internally — no policy internals, no relationship, no facility hint.
   */
  toResponseBody() {
    return { error: this.message, decision: this.decision };
  }
}

export function isAuthorizationDenied(e: unknown): e is AuthorizationDeniedError {
  return e instanceof AuthorizationDeniedError;
}
