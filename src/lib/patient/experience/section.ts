/**
 * Phase D11 — section error isolation (brief §35).
 *
 * A patient-facing aggregate (the home dashboard) reads many independent
 * domains. If one fails, the patient must see "temporarily unavailable" for
 * THAT section — never a false "you have no appointments" / "₹0 due", which
 * would be a dangerous lie. This mirrors D10's UNAVAILABLE contract.
 */

export type SectionState<T> =
  | { status: "OK"; data: T }
  | { status: "UNAVAILABLE" };

export async function safeSection<T>(fn: () => Promise<T>): Promise<SectionState<T>> {
  try {
    return { status: "OK", data: await fn() };
  } catch (err) {
    // Logged for operators (brief §63); never surfaced to the patient.
    console.error("[patient-experience] section failed:", err);
    return { status: "UNAVAILABLE" };
  }
}
