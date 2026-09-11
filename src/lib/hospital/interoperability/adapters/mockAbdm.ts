import { randomUUID } from "crypto";
import type { FetchLike } from "../abdm/transport";
import { ABDM_ENDPOINTS } from "../abdm/contract";

/**
 * Phase C2 — deterministic MOCK ABDM transport, for automated tests ONLY.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A CONNECTION. IT MUST NEVER BE MISTAKEN FOR ONE.
 *
 *  - The name says Mock, the exported marker says mock, and every response it
 *    produces carries `__mock: true`.
 *  - It is never wired into a production code path: it is injected only through
 *    the `fetchImpl` parameter that exists for tests.
 *  - It must never be used to make a health check return AVAILABLE for a real
 *    deployment. If a UI ever shows a connected state, the underlying handshake
 *    must have gone to a genuine gateway.
 *
 * Its purpose is to exercise OUR code — retry policy, error classification,
 * session refresh, callback handling — under failure modes a real sandbox makes
 * hard to reproduce on demand.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const MOCK_MARKER = "__mock" as const;

export type MockScenario =
  | "SUCCESS"
  | "TIMEOUT"
  | "AUTH_FAILURE"
  | "VALIDATION_FAILURE"
  | "CONSENT_FAILURE"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "MALFORMED_BODY"
  | "DUPLICATE_REQUEST";

interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** ABDM's documented error envelope, so error mapping is exercised honestly. */
function abdmError(code: string, message: string) {
  return { error: { code, message }, [MOCK_MARKER]: true };
}

/**
 * Build a mock fetch implementation.
 *
 * `scenarios` may be a single scenario applied to every call, or a queue
 * consumed in order so a test can script e.g. AUTH_FAILURE then SUCCESS to
 * prove the single session-refresh retry.
 */
export function createMockAbdmFetch(
  scenarios: MockScenario | MockScenario[] = "SUCCESS"
): FetchLike & { calls: MockCall[]; remaining: () => number } {
  const queue = Array.isArray(scenarios) ? [...scenarios] : null;
  const fixed = Array.isArray(scenarios) ? null : scenarios;
  const calls: MockCall[] = [];

  const impl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", headers });

    const scenario: MockScenario = fixed ?? (queue && queue.length > 0 ? queue.shift()! : "SUCCESS");
    const isSession = url.includes(ABDM_ENDPOINTS.session);

    switch (scenario) {
      case "TIMEOUT": {
        // Mirrors what AbortController produces, so the transport classifies it
        // through exactly the same path as a real timeout.
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      case "NETWORK_ERROR": {
        const err = Object.assign(new Error("getaddrinfo ENOTFOUND dev.abdm.gov.in"), { code: "ENOTFOUND" });
        throw err;
      }
      case "AUTH_FAILURE":
        return jsonResponse(401, abdmError("ABDM-1401", "Invalid client credentials (mock)."));
      case "VALIDATION_FAILURE":
        return jsonResponse(400, abdmError("ABDM-1002", "Mandatory field missing (mock)."));
      case "CONSENT_FAILURE":
        return jsonResponse(403, abdmError("ABDM-1403", "Consent is not active (mock)."));
      case "RATE_LIMITED":
        return jsonResponse(429, abdmError("ABDM-1429", "Too many requests (mock)."));
      case "SERVER_ERROR":
        return jsonResponse(503, abdmError("ABDM-1500", "Gateway temporarily unavailable (mock)."));
      case "MALFORMED_BODY":
        return new Response("<html>gateway</html>", { status: 202, headers: { "Content-Type": "text/html" } });
      case "DUPLICATE_REQUEST":
        return jsonResponse(409, abdmError("ABDM-1409", "Duplicate request id (mock)."));
      case "SUCCESS":
      default:
        if (isSession) {
          return jsonResponse(202, {
            // Deliberately NOT a real-looking JWT — a mock token must be
            // recognisable as a mock if it ever surfaces anywhere.
            accessToken: `mock-access-token-${randomUUID()}`,
            expiresIn: 600,
            tokenType: "Bearer",
            [MOCK_MARKER]: true,
          });
        }
        return jsonResponse(202, { requestId: randomUUID(), [MOCK_MARKER]: true });
    }
  }) as FetchLike & { calls: MockCall[]; remaining: () => number };

  impl.calls = calls;
  impl.remaining = () => (queue ? queue.length : Infinity);
  return impl;
}

/** True if a payload came from the mock. Used by tests to assert isolation. */
export function isMockPayload(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as Record<string, unknown>)[MOCK_MARKER] === true;
}
