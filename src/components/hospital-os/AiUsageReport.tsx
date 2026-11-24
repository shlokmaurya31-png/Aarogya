"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";

/**
 * RAG Phase 4, step 4.5 — AI usage for the organisation's or the facility's
 * administrator (GET /api/ai/usage): requests, tokens, the estimated cost,
 * cache hits and median latencies, grouped by facility, role, module, model
 * or request type, and by user for the facility's own administrator. Metadata
 * only: no question, answer or patient appears here. The cost is an estimate
 * from a dated, unconfirmed price table.
 */
interface Figures {
  requests: number; answered: number; tier0: number; inputTokens: number; outputTokens: number; embeddingTokens: number;
  rerankUnits: number; cacheHits: number; estimatedCostMicroUsd: number; medianRetrievalMs: number | null; medianGenerationMs: number | null;
}
interface Report { organizationId: string; facilityId: string | null; from: string; to: string; groupBy: string; prices: { asOf: string; confirmed: boolean }; totals: Figures; rows: (Figures & { key: string; label: string })[] }

const GROUPS: [string, string][] = [["facility", "Facility"], ["role", "Role"], ["module", "Module"], ["model", "Model"], ["requestType", "Request type"], ["user", "Staff member (facility administrators)"]];
const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro >= 1e6 ? 2 : 4)}`;
const num = (n: number) => n.toLocaleString("en-IN");
const ms = (n: number | null) => (n == null ? "—" : `${n} ms`);
const input = "rounded-md border border-hairline bg-card px-2 py-1.5 text-[13px]";

export function AiUsageReport() {
  const [groupBy, setGroupBy] = useState("facility");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ groupBy, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    fetch(`/api/ai/usage?${q}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) { setData(body as Report); setError(null); }
        else { setData(null); setError(body.error ?? (res.status === 403 ? "Only an organisation's or a facility's administrator sees AI usage." : "The report couldn't be loaded.")); }
      })
      .catch(() => setError("The report couldn't be loaded."));
  }, [groupBy, from, to]);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-[18px] font-semibold text-text-primary">AI usage</h1>
      <p className="text-[13px] text-text-secondary">Requests, tokens and the estimated cost of the AI assistant. No question, answer or patient appears in this report.</p>
      <Card>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); load(); }}>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">Group by
            <select className={input} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">From
            <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">To (not included)
            <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" className="rounded-md bg-cyan px-3 py-1.5 text-[13px] font-medium text-white">Show</button>
        </form>
      </Card>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {data && t && (
        <>
          <Card>
            <CardLabel>{data.from} to {data.to}{data.facilityId ? " · this facility" : " · the organisation"}</CardLabel>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              {([["Requests", num(t.requests)], ["Answered", num(t.answered)], ["Without a model", num(t.tier0)], ["Estimated cost", usd(t.estimatedCostMicroUsd)],
                ["Input tokens", num(t.inputTokens)], ["Output tokens", num(t.outputTokens)], ["Embedding tokens", num(t.embeddingTokens)], ["Cache hits", num(t.cacheHits)]] as const).map(([k, v]) => (
                <div key={k}><dt className="text-text-secondary">{k}</dt><dd className="font-medium text-text-primary">{v}</dd></div>
              ))}
            </dl>
            <p className="mt-3 text-[12px] text-text-secondary">Cost is an estimate from list prices dated {data.prices.asOf}{data.prices.confirmed ? "" : ", not yet confirmed"}.</p>
          </Card>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">AI usage by {GROUPS.find(([v]) => v === data.groupBy)?.[1].toLowerCase()}</caption>
                <thead className="text-text-secondary">
                  <tr>{["", "Requests", "Without a model", "Input tokens", "Output tokens", "Cache hits", "Estimated cost", "Median retrieval", "Median generation"].map((h, i) => <th key={i} scope="col" className="px-2 py-1 font-medium">{h || GROUPS.find(([v]) => v === data.groupBy)?.[1]}</th>)}</tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={9} className="px-2 py-3 text-text-secondary">No AI requests in this period.</td></tr>}
                  {data.rows.map((r) => (
                    <tr key={r.key} className="border-t border-hairline">
                      <th scope="row" className="px-2 py-1 font-medium text-text-primary">{r.label}</th>
                      <td className="px-2 py-1">{num(r.requests)}</td><td className="px-2 py-1">{num(r.tier0)}</td><td className="px-2 py-1">{num(r.inputTokens)}</td>
                      <td className="px-2 py-1">{num(r.outputTokens)}</td><td className="px-2 py-1">{num(r.cacheHits)}</td><td className="px-2 py-1">{usd(r.estimatedCostMicroUsd)}</td>
                      <td className="px-2 py-1">{ms(r.medianRetrievalMs)}</td><td className="px-2 py-1">{ms(r.medianGenerationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
