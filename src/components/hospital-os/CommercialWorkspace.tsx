"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Package, Gauge, SlidersHorizontal, CheckCircle2, XCircle, FileText, Receipt, RefreshCw } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D2 — commercial control plane (plans, subscription, entitlements, usage,
 * overrides). This is the AAROGYA SaaS commercial layer — NOT the hospital
 * revenue cycle. It reads only what the backend returns for this caller;
 * platform-only management controls appear only when the backend says canManage.
 * There is no payment checkout and no fabricated billing data.
 */

/** ₹ from integer minor units (paise). Display-only; the server owns all amounts. */
function fmtMinor(minor?: number | null, currency = "INR"): string {
  if (minor == null) return "—";
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const invoiceTone = (s?: string): StatusTone =>
  s === "PAID" ? "success"
    : s === "OPEN" || s === "PARTIALLY_PAID" ? "warning"
      : s === "PAST_DUE" || s === "UNCOLLECTIBLE" ? "danger" : "neutral";

const subTone = (s?: string): StatusTone =>
  s === "ACTIVE" || s === "TRIAL" ? "success"
    : s === "PAST_DUE" || s === "GRACE" ? "warning"
      : s === "SUSPENDED" || s === "CANCELLED" || s === "EXPIRED" ? "danger" : "neutral";

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function CommercialWorkspace() {
  const push = useToastStore((s) => s.push);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [billing, setBilling] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    api("/api/hospital/enterprise/organizations").then(({ ok, data }) => {
      if (ok) { setOrgs(data.organizations ?? []); setOrgId((p) => p ?? data.organizations?.[0]?.id ?? null); }
    });
    api("/api/hospital/enterprise/commercial/plans").then(({ ok, data }) => { if (ok) setPlans(data.plans ?? []); });
  }, []);

  const load = useCallback((id: string) => {
    api(`/api/hospital/enterprise/commercial/summary?organizationId=${id}`).then(({ ok, data }) => setSummary(ok ? data : null));
    api(`/api/hospital/enterprise/commercial/billing/summary?organizationId=${id}`).then(({ ok, data }) => setBilling(ok ? data : null));
  }, []);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  async function act(label: string, url: string, init: RequestInit) {
    const { ok, data } = await api(url, init);
    if (!ok) { push(data.error ?? `${label} failed.`, "red"); return; }
    push(`${label} done.`, "emerald");
    if (orgId) load(orgId);
  }

  const canManage = summary?.canManage;
  const sub = summary?.subscription;

  return (
    <div className="space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <CreditCard size={18} className="text-brand" />
        <h1 className="text-[17px] font-semibold">Commercial</h1>
        <span className="text-[12px] text-text-tertiary">Plan, subscription, entitlements & usage — the Aarogya SaaS layer (not patient billing)</span>
      </div>

      {orgs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {orgs.map((o) => (
            <button key={o.id} onClick={() => setOrgId(o.id)}
              className={`rounded-full border px-3 py-1 text-[12px] ${orgId === o.id ? "border-brand bg-brand/5" : "border-hairline hover:bg-fill-hover"}`}>
              {o.name}
            </button>
          ))}
        </div>
      )}

      {!summary ? (
        <Card className="p-6 text-[13px] text-text-tertiary">Loading…</Card>
      ) : (
        <div className="space-y-4">
          {/* Subscription */}
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2"><Package size={15} className="text-brand" /><CardLabel>Subscription</CardLabel></div>
            {sub ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                <div>
                  <p className="text-[11px] text-text-tertiary">Plan</p>
                  <p className="font-medium">{sub.planName} <span className="text-text-tertiary">v{sub.planVersion}</span>{sub.isDefault && <StatusPill label="default" tone="neutral" dot={false} className="ml-2" />}</p>
                </div>
                <div>
                  <p className="text-[11px] text-text-tertiary">Status</p>
                  <StatusPill label={sub.status} tone={subTone(sub.status)} />
                  {!summary.commercialActive && <StatusPill label={summary.commercialReason ?? "inactive"} tone="danger" dot={false} className="ml-1" />}
                </div>
                {sub.trialEndsAt && <div><p className="text-[11px] text-text-tertiary">Trial ends</p><p>{new Date(sub.trialEndsAt).toLocaleDateString()}</p></div>}
                {sub.currentPeriodEnd && <div><p className="text-[11px] text-text-tertiary">Renews / ends</p><p>{new Date(sub.currentPeriodEnd).toLocaleDateString()}{sub.cancelAtPeriodEnd && " (cancels)"}</p></div>}
              </div>
            ) : <p className="text-[12px] text-text-tertiary">No subscription.</p>}

            {canManage && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                <span className="text-[11px] text-text-tertiary">Platform:</span>
                {plans.map((p) => (
                  <Button key={p.id} size="sm" variant="secondary"
                    onClick={() => act(`Assign ${p.code}`, "/api/hospital/enterprise/commercial/subscriptions", { method: "POST", body: JSON.stringify({ organizationId: orgId, planCode: p.code }) })}>
                    Assign {p.code}
                  </Button>
                ))}
                <Button size="sm" variant="secondary" onClick={() => act("Suspend", "/api/hospital/enterprise/commercial/subscriptions/transition", { method: "POST", body: JSON.stringify({ organizationId: orgId, action: "transition", to: "SUSPENDED" }) })}>Suspend</Button>
                <Button size="sm" variant="secondary" onClick={() => act("Reactivate", "/api/hospital/enterprise/commercial/subscriptions/transition", { method: "POST", body: JSON.stringify({ organizationId: orgId, action: "transition", to: "ACTIVE" }) })}>Activate</Button>
              </div>
            )}
          </Card>

          {/* Entitlements + usage */}
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2"><Gauge size={15} className="text-brand" /><CardLabel>Entitlements & usage</CardLabel></div>
            <div className="space-y-1.5">
              {summary.entitlements.map((e: any) => (
                <div key={e.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    {e.type === "BOOLEAN"
                      ? (e.allowed ? <CheckCircle2 size={15} className="text-success" /> : <XCircle size={15} className="text-text-tertiary" />)
                      : <Gauge size={15} className="text-brand" />}
                    <span>{e.name}</span>
                    <StatusPill label={e.scope === "FACILITY" ? "facility" : "org"} tone="neutral" dot={false} />
                    <span className="text-[11px] text-text-tertiary">via {e.source.toLowerCase()}</span>
                  </div>
                  <div className="text-[12px] text-text-secondary">
                    {e.type === "BOOLEAN"
                      ? (e.allowed ? "Enabled" : "Not included")
                      : `${e.usage ?? 0} / ${e.unlimited ? "∞" : e.limit ?? "—"}`}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Overrides */}
          {summary.overrides.length > 0 && (
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2"><SlidersHorizontal size={15} className="text-brand" /><CardLabel>Organization overrides</CardLabel></div>
              <div className="space-y-1.5">
                {summary.overrides.map((o: any) => (
                  <div key={o.key} className="flex items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
                    <span>{o.name}</span>
                    <span className="text-text-secondary">{o.unlimited ? "unlimited" : o.numberValue ?? String(o.boolValue)}{o.expiresAt ? ` · expires ${new Date(o.expiresAt).toLocaleDateString()}` : ""}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ── Phase D3 — SaaS billing (separate from patient revenue cycle) ── */}
          {billing && (
            <>
              {/* Billing overview */}
              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2"><Receipt size={15} className="text-brand" /><CardLabel>Billing</CardLabel></div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                  <div>
                    <p className="text-[11px] text-text-tertiary">Recurring price</p>
                    <p className="font-medium">
                      {billing.pricing ? `${fmtMinor(billing.pricing.amountMinor, billing.pricing.currency)} / ${(billing.pricing.billingInterval ?? "").toLowerCase()}` : "Not billable"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-tertiary">Next billing</p>
                    <p>{billing.nextBillingAt ? new Date(billing.nextBillingAt).toLocaleDateString() : "—"}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-tertiary">Outstanding</p>
                    <p className={billing.outstandingMinor > 0 ? "font-medium text-danger" : "font-medium"}>{fmtMinor(billing.outstandingMinor)}</p>
                  </div>
                  {billing.account && (
                    <div>
                      <p className="text-[11px] text-text-tertiary">Billing account</p>
                      <p>{billing.account.billingName} <span className="text-text-tertiary">· {billing.account.currency}</span></p>
                    </div>
                  )}
                </div>
                {canManage && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                    <span className="text-[11px] text-text-tertiary">Platform:</span>
                    <Button size="sm" variant="secondary" onClick={() => act("Renew (test provider)", "/api/hospital/enterprise/commercial/billing/renew", { method: "POST", body: JSON.stringify({ organizationId: orgId, providerKind: "FAKE" }) })}>
                      <RefreshCw size={13} /> Renew (test pay)
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => act("Renew (invoice only)", "/api/hospital/enterprise/commercial/billing/renew", { method: "POST", body: JSON.stringify({ organizationId: orgId, providerKind: "NONE" }) })}>
                      Generate invoice
                    </Button>
                  </div>
                )}
                {!billing.account && <p className="mt-2 text-[12px] text-text-tertiary">No billing account yet.</p>}
              </Card>

              {/* Invoices */}
              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2"><FileText size={15} className="text-brand" /><CardLabel>Invoices</CardLabel></div>
                {billing.invoices.length === 0 ? (
                  <p className="text-[12px] text-text-tertiary">No invoices yet — this organization has no billing history.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-[12.5px]">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">
                          <th className="py-2 pr-3 font-medium">Invoice</th>
                          <th className="py-2 pr-3 font-medium">Status</th>
                          <th className="py-2 pr-3 font-medium">Total</th>
                          <th className="py-2 pr-3 font-medium">Paid</th>
                          <th className="py-2 pr-3 font-medium">Due date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billing.invoices.map((inv: any) => (
                          <tr key={inv.id} className="border-t border-hairline">
                            <td className="py-2 pr-3 font-medium">{inv.invoiceNumber ?? <span className="text-text-tertiary">draft</span>}</td>
                            <td className="py-2 pr-3"><StatusPill label={inv.status} tone={invoiceTone(inv.status)} /></td>
                            <td className="py-2 pr-3">{fmtMinor(inv.totalMinor, inv.currency)}</td>
                            <td className="py-2 pr-3">{fmtMinor(inv.amountPaidMinor, inv.currency)}</td>
                            <td className="py-2 pr-3 text-text-secondary">{inv.dueAt ? new Date(inv.dueAt).toLocaleDateString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {/* Credits */}
              {billing.credits.length > 0 && (
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2"><CreditCard size={15} className="text-brand" /><CardLabel>Credits</CardLabel></div>
                  <div className="space-y-1.5">
                    {billing.credits.map((c: any) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
                        <span>{c.type} · {c.reason}</span>
                        <span className="text-text-secondary">{fmtMinor(c.remainingMinor)} of {fmtMinor(c.amountMinor)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
