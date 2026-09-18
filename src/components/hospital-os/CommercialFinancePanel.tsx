"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, AlertTriangle, Wallet, ServerCog } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D5 — platform-only commercial operations panel. Renders NOTHING for
 * non-platform callers (every fetch is authorized server-side; a 403 simply
 * hides the section). All figures are server-derived and currency-grouped; no
 * client-side financial math. Uses the existing design system.
 */

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const money = (arr: { currency: string; amountMinor: number }[]) =>
  !arr || arr.length === 0 ? "—" : arr.map((a) => `${a.currency === "INR" ? "₹" : a.currency + " "}${(a.amountMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(" · ");

const collTone = (s: string): StatusTone =>
  s === "SUSPENDED" || s === "SUSPENSION_RISK" ? "danger" : s === "GRACE" || s === "PAST_DUE" ? "warning" : s === "ATTENTION" ? "warning" : "neutral";

export function CommercialFinancePanel() {
  const push = useToastStore((s) => s.push);
  const [overview, setOverview] = useState<any>(null);
  const [collections, setCollections] = useState<any[] | null>(null);
  const [recon, setRecon] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [visible, setVisible] = useState(false);

  const load = useCallback(() => {
    api("/api/hospital/enterprise/commercial/provider-health").then(({ ok, data }) => {
      if (!ok) { setVisible(false); return; }
      setVisible(true); setHealth(data);
    });
    api("/api/hospital/enterprise/commercial/analytics?view=overview").then(({ ok, data }) => { if (ok) setOverview(data); });
    api("/api/hospital/enterprise/commercial/collections?onlyAttention=true").then(({ ok, data }) => { if (ok) setCollections(data.collections ?? []); });
    api("/api/hospital/enterprise/commercial/reconciliation").then(({ ok, data }) => { if (ok) setRecon(data); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(label: string, url: string) {
    const { ok, data } = await api(url, { method: "POST" });
    push(ok ? `${label}: ${JSON.stringify(data)}` : (data.error ?? `${label} failed.`), ok ? "emerald" : "red");
    if (ok) load();
  }

  if (!visible) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <BarChart3 size={16} className="text-brand" />
        <h2 className="text-[15px] font-semibold">Platform finance</h2>
        <span className="text-[12px] text-text-tertiary">Revenue operations across all organizations (platform-only)</span>
      </div>

      {/* KPI cards */}
      {overview && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Active orgs", value: overview.kpis.activeOrganizations },
            { label: "Active subscriptions", value: overview.kpis.activeSubscriptions },
            { label: "Failed payments (30d)", value: overview.kpis.failedPaymentsInPeriod },
            { label: "Open reconciliation", value: overview.kpis.openReconciliationExceptions },
          ].map((k) => (
            <Card key={k.label} className="p-3">
              <p className="text-[11px] text-text-tertiary">{k.label}</p>
              <p className="mt-1 text-[20px] font-semibold tabular-nums">{k.value}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Money summary (currency-grouped) */}
      {overview && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2"><Wallet size={15} className="text-brand" /><CardLabel>Billed &amp; collected (last 30 days) · outstanding now</CardLabel></div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
            <div><p className="text-[11px] text-text-tertiary">Invoiced</p><p>{money(overview.invoiced)}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Collected</p><p>{money(overview.collected)}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Refunded</p><p>{money(overview.refunded)}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Credited</p><p>{money(overview.credited)}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Outstanding</p><p className="font-medium">{money(overview.outstanding)}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Overdue</p><p className="font-medium text-danger">{money(overview.overdue)}</p></div>
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">Figures are billed/collected/outstanding — not accounting-recognized revenue. Currencies are shown separately, never combined.</p>
        </Card>
      )}

      {/* Collections queue */}
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /><CardLabel>Collections — needs attention</CardLabel></div>
        {!collections ? <p className="text-[12px] text-text-tertiary">Loading…</p>
          : collections.length === 0 ? <p className="text-[12px] text-text-tertiary">No organizations need attention.</p>
          : (
            <div className="space-y-1.5">
              {collections.slice(0, 12).map((c) => (
                <div key={c.organizationId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
                  <div className="flex items-center gap-2"><StatusPill label={c.collectionState} tone={collTone(c.collectionState)} dot={false} /><span>{c.name}</span></div>
                  <span className="text-[12px] text-text-secondary">{money(c.outstanding)}</span>
                </div>
              ))}
            </div>
          )}
      </Card>

      {/* Reconciliation dashboard */}
      {recon && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /><CardLabel>Reconciliation &amp; leakage</CardLabel></div>
            <Button size="sm" variant="secondary" onClick={() => run("Leakage scan", "/api/hospital/enterprise/commercial/leakage")}>Run leakage scan</Button>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            <div><p className="text-[11px] text-text-tertiary">Open</p><p className="font-medium">{recon.openCount}</p></div>
            <div><p className="text-[11px] text-text-tertiary">Critical</p><p className="font-medium text-danger">{recon.criticalCount}</p></div>
            {Object.entries(recon.byType ?? {}).map(([k, v]) => (
              <div key={k}><p className="text-[11px] text-text-tertiary">{k}</p><p>{v as number}</p></div>
            ))}
          </div>
        </Card>
      )}

      {/* Provider health */}
      {health && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2"><ServerCog size={15} className="text-brand" /><CardLabel>Provider health</CardLabel></div>
          <div className="space-y-1.5">
            {health.providers.map((p: any) => (
              <div key={p.provider} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.provider}</span>
                  {p.selected && <StatusPill label="selected" tone="neutral" dot={false} />}
                </div>
                <StatusPill label={p.state} tone={p.state === "NOT_CONFIGURED" ? "neutral" : p.state === "ERROR" ? "danger" : p.state === "DEGRADED" ? "warning" : "success"} dot={false} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">{health.note}</p>
        </Card>
      )}
    </div>
  );
}
