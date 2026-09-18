import { PermanentEventError } from "./types";

/**
 * Phase D6 — payload data-minimization guard (defense in depth).
 *
 * The catalogue's `.strict()` Zod schemas already reject unknown keys, but this
 * is a second, type-agnostic barrier applied to EVERY event payload before it is
 * persisted: an event must never become a secondary copy of secrets or the
 * medical record. Any key whose name matches a forbidden pattern — at any depth —
 * makes the emission fail permanently (a programming error, never retried).
 *
 * Events carry identifiers and minimal metadata. A consumer that needs more must
 * fetch it through the existing authorization model; the event is not a bypass.
 */

const FORBIDDEN_KEY = /(password|passcode|secret|token|apikey|api_key|authorization|cookie|session|card(number|no)?|cardnumber|cvv|cvc|pan\b|iban|accountnumber|routingnumber|privatekey|clientsecret|webhooksecret|signature|otp|ssn|aadhaar|mrn|clinicalnote|notes?|freetext|narrative|report(body|text)|resultvalue|payload)/i;

/** Values longer than this look like blobs/notes, not identifiers/metadata. */
const MAX_STRING_LEN = 512;

export function assertNoSensitiveData(payload: unknown, path = "payload"): void {
  if (payload === null || payload === undefined) return;
  if (typeof payload === "string") {
    if (payload.length > MAX_STRING_LEN) {
      throw new PermanentEventError(`Event field ${path} exceeds ${MAX_STRING_LEN} chars — events carry identifiers and metadata, not blobs.`, "SENSITIVE_BLOB");
    }
    return;
  }
  if (typeof payload === "number" || typeof payload === "boolean") return;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoSensitiveData(v, `${path}[${i}]`));
    return;
  }
  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new PermanentEventError(`Event field ${path}.${key} is a forbidden (sensitive) key.`, "SENSITIVE_KEY");
      }
      assertNoSensitiveData(value, `${path}.${key}`);
    }
    return;
  }
  throw new PermanentEventError(`Event field ${path} has an unserializable type.`, "UNSERIALIZABLE");
}
