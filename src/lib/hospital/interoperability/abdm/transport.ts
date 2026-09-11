import { randomUUID } from "crypto";
import { ABDM_HEADERS, ABDM_SUCCESS_STATUSES, buildUrl } from "./contract";
import type { AbdmConfig } from "./config";
import { InteropError, fromHttpResponse, fromTransportException, configurationError } from "./errors";

/**
 * Phase C2 — ABDM HTTP transport.
 *
 * The ONLY place in Aarogya that performs an outbound ABDM call. Isolated so
 * that header construction, correlation, timeouts, redaction and error mapping
 * exist exactly once, and so no clinical service ever contains transport or
 * crypto logic.
 *
 * Everything here is built from the verified contract in contract.ts. Nothing
 * invents an endpoint, and an unconfigured transport refuses rather than
 * fabricating a response.
 */

export interface AbdmRequestContext {
  /** REQUEST-ID header; also our correlation id. Generated if not supplied. */
  requestId?: string;
  /** X-HIU-ID / X-HIP-ID when the operation requires it. */
  hiuId?: string | null;
  hipId?: string | null;
  /** Bearer token from the session service; omitted on the session call itself. */
  accessToken?: string | null;
  /** Overrides the configured timeout for a single call. */
  timeoutMs?: number;
}

export interface AbdmResponse<T = unknown> {
  status: number;
  body: T;
  requestId: string;
  /** Wall-clock duration, for observability. Never includes payload content. */
  durationMs: number;
}

/**
 * Header names whose values must never be logged or surfaced. Used by
 * describeRequest() so an operator can see WHICH headers were sent without
 * seeing the credentials in them.
 */
const SECRET_HEADERS = new Set([
  ABDM_HEADERS.authorization.toLowerCase(),
  "x-callback-token",
  "cookie",
  "set-cookie",
]);

export function buildHeaders(config: AbdmConfig, ctx: AbdmRequestContext): Record<string, string> {
  if (!config.cmId) throw configurationError("ABDM is disabled; no consent-manager id is configured.");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    // Both are mandatory on every documented ABDM call (M3 doc §3.2.1 onward).
    [ABDM_HEADERS.requestId]: ctx.requestId ?? randomUUID(),
    [ABDM_HEADERS.timestamp]: new Date().toISOString(),
    [ABDM_HEADERS.cmId]: config.cmId,
  };
  if (ctx.accessToken) headers[ABDM_HEADERS.authorization] = `Bearer ${ctx.accessToken}`;
  if (ctx.hiuId) headers[ABDM_HEADERS.hiuId] = ctx.hiuId;
  if (ctx.hipId) headers[ABDM_HEADERS.hipId] = ctx.hipId;
  return headers;
}

/** Log-safe view of a request: header NAMES, never their values. */
export function describeRequest(url: string, headers: Record<string, string>) {
  return {
    url,
    headers: Object.keys(headers).map((name) =>
      SECRET_HEADERS.has(name.toLowerCase()) ? `${name}: (redacted)` : `${name}: ${headers[name]}`
    ),
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Perform one ABDM call.
 *
 * `fetchImpl` is injectable purely so tests can drive transport behaviour
 * (timeout, 4xx, 5xx, malformed body) deterministically without a network. It
 * is never swapped in production code.
 */
export async function abdmRequest<T = unknown>(args: {
  config: AbdmConfig;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  pathParams?: Record<string, string>;
  operation: string;
  context?: AbdmRequestContext;
  fetchImpl?: FetchLike;
}): Promise<AbdmResponse<T>> {
  const { config, operation } = args;
  if (config.environment === "DISABLED") {
    throw configurationError(`ABDM is disabled; ${operation} was not attempted.`);
  }
  if (!config.baseUrl) {
    throw configurationError(`ABDM ${operation} has no base URL configured.`);
  }

  const ctx = args.context ?? {};
  const requestId = ctx.requestId ?? randomUUID();
  const headers = buildHeaders(config, { ...ctx, requestId });
  const url = buildUrl(config.baseUrl, args.path, args.pathParams ?? {});

  const timeoutMs = ctx.timeoutMs ?? config.requestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const doFetch = args.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!doFetch) throw configurationError("No fetch implementation is available in this runtime.");

    const response = await doFetch(url, {
      method: args.method ?? "POST",
      headers,
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: controller.signal,
    });

    const durationMs = Date.now() - startedAt;
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); }
      catch {
        // A non-JSON body from the gateway is itself a protocol failure. The
        // body is NOT echoed — it may contain anything.
        if (!(ABDM_SUCCESS_STATUSES as readonly number[]).includes(response.status)) {
          throw fromHttpResponse({ status: response.status, body: null, requestId, operation });
        }
        throw new InteropError({
          kind: "UNKNOWN_EXTERNAL_ERROR",
          message: `ABDM ${operation} returned a non-JSON body.`,
          httpStatus: response.status,
          requestId,
        });
      }
    }

    if (!(ABDM_SUCCESS_STATUSES as readonly number[]).includes(response.status)) {
      throw fromHttpResponse({ status: response.status, body: parsed, requestId, operation });
    }

    return { status: response.status, body: parsed as T, requestId, durationMs };
  } catch (error) {
    if (error instanceof InteropError) throw error;
    throw fromTransportException({ error, operation, requestId });
  } finally {
    clearTimeout(timer);
  }
}
