/**
 * Phase D4 — a tiny injectable HTTP transport for provider adapters.
 *
 * Adapters depend on this interface, NOT on a specific HTTP client, so the
 * adapter's request-building, response-normalization and error-mapping logic can
 * be unit-verified deterministically with a fake transport (ADAPTER VERIFIED)
 * without any network access or real credentials. The default transport uses the
 * platform `fetch`; production simply wires that.
 */

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const body = await res.text();
  return { status: res.status, body };
};
