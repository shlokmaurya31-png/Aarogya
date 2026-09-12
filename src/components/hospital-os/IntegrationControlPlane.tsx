"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Plug, Users, Share2, AlertTriangle, Inbox,
  SlidersHorizontal, ShieldCheck, Power, RotateCw,
} from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase C6 — interoperability control plane.
 *
 * The design rule for this screen is that it must never collapse readiness into
 * a single word. Every integration shows its six dimensions separately, because
 * "Ready" is precisely the label that would let an operator point a hospital at
 * a live national gateway on the strength of a green dot.
 *
 * Nothing rendered here is a secret. The API returns redacted descriptions
 * only — whether a credential is present, never what it is — and certificates
 * arrive as `materialConfigured: boolean` rather than a path.
 */
type Tab =
  | "overview" | "integrations" | "participants" | "exchanges"
  | "failures" | "callbacks" | "configuration" | "readiness";

const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "participants", label: "Participants", icon: Users },
  { id: "exchanges", label: "Exchanges", icon: Share2 },
  { id: "failures", label: "Failures", icon: AlertTriangle },
  { id: "callbacks", label: "Callbacks", icon: Inbox },
  { id: "configuration", label: "Configuration", icon: SlidersHorizontal },
  { id: "readiness", label: "Readiness", icon: ShieldCheck },
];

const tone = (s: string): "emerald" | "amber" | "red" | "cyan" | "neutral" =>
  ["PASS", "VERIFIED", "PRODUCTION_VERIFIED", "SANDBOX_VERIFIED", "COMPLETED", "ACCEPTED", "HEALTHY", "ACTIVE", "VALID", "RESOLVED"].includes(s) ? "emerald"
    : ["FAIL", "FAILED", "REJECTED", "BLOCKED", "CRITICAL", "REVOKED", "EXPIRED", "REQUIRES_REVIEW"].includes(s) ? "red"
      : ["NOT_CONFIGURED", "DISABLED", "NOT_APPLICABLE", "CANCELLED", "UNVERIFIED", "INFO"].includes(s) ? "neutral"
        : ["WARNING", "EXPIRING", "SUSPENDED", "PRODUCTION_ENABLED", "CONFIGURED", "SANDBOX", "QUEUED", "DUPLICATE"].includes(s) ? "amber"
          : "cyan";

function Metric({ label, value, t = "neutral" }: { label: string; value: number | string; t?: string }) {
  const color = t === "red" ? "text-red" : t === "amber" ? "text-amber"
    : t === "cyan" ? "text-cyan" : t === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[110px]">
      <p className={`text-[19px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[12px] text-text-tertiary">{children}</p>;
}

/** The six readiness dimensions, always shown together and never averaged. */
function ReadinessGrid({ r }: { r: any }) {
  const rows: [string, string][] = [
    ["Architecture", r?.dimensions?.architecture],
    ["Contract", r?.dimensions?.contract],
    ["Configuration", r?.dimensions?.configuration],
    ["Tests", r?.dimensions?.tests],
    ["Sandbox", r?.dimensions?.sandbox],
    ["Production", r?.dimensions?.production],
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between rounded-lg border border-hairline px-2.5 py-1.5">
          <span className="text-[11px] text-text-secondary">{label}</span>
          <StatusPill label={value ?? "—"} tone={tone(value ?? "")} className="rounded-md" />
        </div>
      ))}
    </div>
  );
}

export function IntegrationControlPlane() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("overview");

  const [data, setData] = useState<any>(null);
  const [participants, setParticipants] = useState<any>(null);
  const [exchanges, setExchanges] = useState<any>(null);
  const [callbacks, setCallbacks] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadedDetail, setLoadedDetail] = useState<{ system: string; data: any } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/hospital/integrations")
      .then((r) => r.json()).then((d) => setData(d ?? null)).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  const loadDetail = useCallback((system: string) => {
    fetch(`/api/hospital/integrations?system=${encodeURIComponent(system)}`)
      .then((r) => r.json())
      .then((d) => setLoadedDetail({ system, data: d ?? null }))
      .catch(() => setLoadedDetail({ system, data: null }));
  }, []);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);

  useEffect(() => {
    if (tab !== "participants") return;
    fetch("/api/hospital/integrations/participants")
      .then((r) => r.json()).then((d) => setParticipants(d ?? null)).catch(() => setParticipants(null));
  }, [tab]);

  useEffect(() => {
    if (tab !== "exchanges" && tab !== "failures") return;
    const q = tab === "failures" ? "?requiresReview=false" : "";
    fetch(`/api/hospital/integrations/exchanges${q}`)
      .then((r) => r.json()).then((d) => setExchanges(d ?? null)).catch(() => setExchanges(null));
  }, [tab]);

  useEffect(() => {
    if (tab !== "callbacks") return;
    fetch("/api/hospital/integrations/exchanges?view=callbacks")
      .then((r) => r.json()).then((d) => setCallbacks(d ?? null)).catch(() => setCallbacks(null));
  }, [tab]);

  async function act(url: string, body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { push(d.error ?? "Failed.", "red"); return null; }
      push(ok, "emerald");
      load();
      if (selected) loadDetail(selected);
      return d;
    } finally { setBusy(false); }
  }

  const detail = loadedDetail && loadedDetail.system === selected ? loadedDetail.data : null;
  const integrations: any[] = data?.integrations ?? [];
  const failing = (exchanges?.exchanges ?? []).filter(
    (e: any) => e.operationalState === "FAILED" || e.operationalState === "REQUIRES_REVIEW"
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />

      <div>
        <div className="flex items-center gap-2">
          <Plug size={18} className="text-cyan" />
          <h1 className="text-[20px] font-semibold tracking-tight">Integrations</h1>
        </div>
        <p className="mt-1 text-[13px] text-text-secondary">
          External connectivity for this facility: what exists, which environment it uses,
          whether it is switched on, and what it has actually done.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
                tab === t.id ? "border-cyan bg-cyan/10 text-cyan" : "border-hairline text-text-secondary hover:text-text-primary"
              }`}>
              <Icon size={13} />{t.label}
            </button>
          );
        })}
      </div>

      {(data?.alerts?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          {data.alerts.slice(0, 4).map((a: any) => (
            <div key={a.id}
              className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11.5px] leading-relaxed ${
                a.severity === "CRITICAL" ? "border-red/40 bg-red/5 text-red" : "border-amber/40 bg-amber/5 text-amber"
              }`}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">{a.system} · {a.alertType}</span> — {a.detail}
                {a.occurrenceCount > 1 && <span className="opacity-70"> (seen {a.occurrenceCount}×)</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <div className="space-y-4">
          <Card>
            <CardLabel>Operational summary</CardLabel>
            <div className="mt-3 flex flex-wrap gap-2">
              <Metric label="Integrations" value={integrations.length} />
              <Metric label="Enabled" value={integrations.filter((i) => i.connection.enabled).length}
                t={integrations.some((i) => i.connection.enabled) ? "emerald" : "neutral"} />
              <Metric label="Can dispatch" value={integrations.filter((i) => i.dispatch.allowed).length}
                t={integrations.some((i) => i.dispatch.allowed) ? "emerald" : "neutral"} />
              <Metric label="Queue depth" value={data?.metrics?.queueDepth ?? 0} />
              <Metric label="Open alerts" value={data?.alerts?.length ?? 0}
                t={(data?.alerts?.length ?? 0) > 0 ? "red" : "neutral"} />
            </div>

            <div className="mt-4 space-y-2">
              {(data?.metrics?.bySystem ?? []).map((s: any) => (
                <div key={s.system} className="rounded-lg border border-hairline px-3 py-2">
                  <p className="text-[12.5px] font-medium">{s.system}</p>
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    {s.exchanges} exchange(s) · {s.completed} completed · {s.failed} failed ·
                    {" "}{s.requiresReview} need review · {s.callbacks} callback(s), {s.callbacksRejected} rejected
                  </p>
                </div>
              ))}
            </div>
          </Card>

          {(data?.metrics?.failuresByCategory?.length ?? 0) > 0 && (
            <Card>
              <CardLabel>Failures by category</CardLabel>
              <div className="mt-3 space-y-1">
                {data.metrics.failuresByCategory.map((f: any) => (
                  <div key={f.category} className="flex items-center justify-between text-[12px]">
                    <StatusPill label={f.category} tone={tone(f.category)} className="rounded-md" />
                    <span className="text-text-secondary">{f.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {(tab === "integrations" || tab === "configuration" || tab === "readiness") && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          <Card>
            <CardLabel>Integrations</CardLabel>
            <div className="mt-3 space-y-2">
              {integrations.map((i) => (
                <button key={i.descriptor.system} onClick={() => setSelected(i.descriptor.system)}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${
                    selected === i.descriptor.system ? "border-cyan/40 bg-cyan/[0.04]" : "border-hairline"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium">{i.descriptor.system}</span>
                    <StatusPill label={i.readiness.state} tone={tone(i.readiness.state)} className="rounded-md" />
                  </div>
                  <p className="mt-1 text-[10.5px] text-text-tertiary">
                    {i.connection.environment} · {i.connection.enabled ? "enabled" : "disabled"}
                  </p>
                </button>
              ))}
              {integrations.length === 0 && <Empty>Loading…</Empty>}
            </div>
          </Card>

          <div className="space-y-4">
            {!selected && <Card><Empty>Select an integration.</Empty></Card>}

            {selected && detail?.integration && (
              <>
                <Card>
                  <CardLabel>{detail.integration.descriptor.name}</CardLabel>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Metric label="Environment" value={detail.integration.connection.environment}
                      t={detail.integration.connection.environment === "PRODUCTION" ? "emerald"
                        : detail.integration.connection.environment === "SANDBOX" ? "amber" : "neutral"} />
                    <Metric label="Enabled" value={detail.integration.connection.enabled ? "Yes" : "No"}
                      t={detail.integration.connection.enabled ? "emerald" : "neutral"} />
                    <Metric label="Can dispatch" value={detail.integration.dispatch.allowed ? "Yes" : "No"}
                      t={detail.integration.dispatch.allowed ? "emerald" : "red"} />
                    <Metric label="Revision" value={detail.integration.connection.configRevision} />
                  </div>

                  {!detail.integration.dispatch.allowed && detail.integration.dispatch.reason && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-[11.5px] text-amber">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{detail.integration.dispatch.reason}</span>
                    </div>
                  )}
                  {detail.integration.connection.disabledReason && (
                    <p className="mt-2 text-[11px] text-text-tertiary">
                      Disabled: {detail.integration.connection.disabledReason}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button disabled={busy}
                      onClick={() => act("/api/hospital/integrations",
                        { action: "enable", system: selected }, "Integration enabled.")}
                      className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 px-2.5 py-1.5 text-[11.5px] text-emerald-600 disabled:opacity-40 hover:bg-emerald-500/5">
                      <Power size={12} /> Enable
                    </button>
                    <button disabled={busy}
                      onClick={() => {
                        const reason = window.prompt("Reason for disabling this integration:");
                        if (reason) act("/api/hospital/integrations",
                          { action: "disable", system: selected, reason }, "Integration disabled.");
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-red-500/30 px-2.5 py-1.5 text-[11.5px] text-red-600 disabled:opacity-40 hover:bg-red-500/5">
                      <Power size={12} /> Disable
                    </button>
                  </div>
                </Card>

                <Card>
                  <CardLabel>Capabilities</CardLabel>
                  <div className="mt-3 space-y-1.5">
                    {detail.integration.descriptor.capabilities
                      .filter((c: any) => c.support !== "NOT_APPLICABLE")
                      .map((c: any) => (
                        <div key={c.capability} className="rounded-lg border border-hairline px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[12px] font-medium">{c.capability}</span>
                            <StatusPill
                              label={c.support}
                              tone={c.support === "IMPLEMENTED" ? "emerald" : c.support === "DOMAIN_ONLY" ? "amber" : "neutral"}
                              className="rounded-md" />
                          </div>
                          {c.note && <p className="mt-1 text-[11px] text-text-tertiary">{c.note}</p>}
                        </div>
                      ))}
                  </div>
                </Card>

                {tab === "readiness" && (
                  <Card>
                    <CardLabel>Readiness</CardLabel>
                    <p className="mt-2 text-[11.5px] text-text-secondary">{detail.integration.readiness.summary}</p>
                    <ReadinessGrid r={detail.integration.readiness} />
                    {detail.integration.readiness.blockers.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {detail.integration.readiness.blockers.map((b: string, i: number) => (
                          <div key={i} className="rounded-lg border border-hairline px-3 py-2 text-[11.5px] text-text-tertiary">{b}</div>
                        ))}
                      </div>
                    )}
                    {detail.integration.descriptor.contractSource && (
                      <p className="mt-3 text-[11px] text-text-tertiary">
                        Contract source: {detail.integration.descriptor.contractSource.document}
                        {detail.integration.descriptor.contractSource.version ? ` v${detail.integration.descriptor.contractSource.version}` : ""}
                        {" "}(verified {detail.integration.descriptor.contractSource.verifiedOn})
                      </p>
                    )}
                  </Card>
                )}

                {tab === "configuration" && (
                  <>
                    <Card>
                      <CardLabel>Runtime configuration</CardLabel>
                      <p className="mt-2 text-[11px] text-text-tertiary">
                        Presence only. No credential value is ever returned by the API or rendered here.
                      </p>
                      <div className="mt-3 space-y-1 text-[11.5px]">
                        {Object.entries(detail.integration.runtime ?? {}).map(([k, v]) => (
                          <div key={k} className="flex items-start justify-between gap-3 border-b border-hairline py-1 last:border-0">
                            <span className="text-text-tertiary">{k}</span>
                            <span className="text-right text-text-secondary">
                              {typeof v === "object" ? JSON.stringify(v) : String(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </Card>

                    <Card>
                      <CardLabel>Configuration history</CardLabel>
                      <div className="mt-3 space-y-1.5">
                        {(detail.revisions ?? []).map((r: any) => (
                          <div key={r.id} className="rounded-lg border border-hairline px-3 py-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[12px] font-medium">r{r.revision} · {r.changeKind}</span>
                              <span className="text-[10.5px] text-text-tertiary">
                                {new Date(r.createdAt).toLocaleString("en-IN")}
                              </span>
                            </div>
                            {r.changedFields && <p className="mt-1 text-[11px] text-text-tertiary">Changed: {r.changedFields}</p>}
                            {r.reason && <p className="mt-0.5 text-[11px] text-text-tertiary">{r.reason}</p>}
                          </div>
                        ))}
                        {(detail.revisions?.length ?? 0) === 0 && <Empty>No configuration history.</Empty>}
                      </div>
                    </Card>

                    <Card>
                      <CardLabel>Certificates</CardLabel>
                      <div className="mt-3 space-y-1.5">
                        {(detail.certificates ?? []).map((c: any) => (
                          <div key={c.id} className="rounded-lg border border-hairline px-3 py-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[12px] font-medium">{c.usage} · {c.role}</span>
                              <StatusPill label={c.status} tone={tone(c.status)} className="rounded-md" />
                            </div>
                            <p className="mt-1 text-[11px] text-text-tertiary">
                              Material {c.materialConfigured ? "configured" : "not configured"}
                              {c.notAfter ? ` · expires ${new Date(c.notAfter).toLocaleDateString("en-IN")}` : ""}
                              {c.fingerprint ? ` · ${c.fingerprint.slice(0, 16)}…` : ""}
                            </p>
                          </div>
                        ))}
                        {(detail.certificates?.length ?? 0) === 0 && <Empty>No certificates registered.</Empty>}
                      </div>
                    </Card>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === "participants" && (
        <Card>
          <CardLabel>External participants</CardLabel>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Identity is not trust. A registered counterparty is UNVERIFIED until an
            authorised operator explicitly verifies it, and only a VERIFIED participant
            can be exchanged with.
          </p>
          <div className="mt-3 space-y-2">
            {(participants?.participants ?? []).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium">{p.name}</p>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {p.system} · {p.type} · {p.environment} · {p.externalId}
                  </p>
                </div>
                <StatusPill label={p.trustStatus} tone={tone(p.trustStatus)} className="rounded-md" />
              </div>
            ))}
            {participants && (participants.participants?.length ?? 0) === 0 && <Empty>No participants registered.</Empty>}
          </div>
        </Card>
      )}

      {(tab === "exchanges" || tab === "failures") && (
        <Card>
          <CardLabel>{tab === "failures" ? "Failed exchanges" : "Exchanges"}</CardLabel>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Operational metadata only. Viewing an exchange here does not grant access to
            the clinical or financial payload it carried.
          </p>
          <div className="mt-3 space-y-2">
            {(tab === "failures" ? failing : exchanges?.exchanges ?? []).map((e: any) => (
              <div key={`${e.source}-${e.id}`} className="rounded-lg border border-hairline px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12.5px] font-medium">{e.system} · {e.direction}</p>
                  <StatusPill label={e.operationalState} tone={tone(e.operationalState)} className="rounded-md" />
                </div>
                <p className="mt-1 break-all text-[11px] text-text-tertiary">
                  correlation {e.correlationId ?? "—"} · attempt {e.attemptCount}/{e.maxAttempts}
                  {e.protocolState ? ` · protocol ${e.protocolState}` : ""}
                </p>
                {e.failureCategory && (
                  <p className="mt-1 text-[11px] text-red">{e.failureCategory}: {e.failureMessage}</p>
                )}
                {e.retryEligible && (
                  <button disabled={busy}
                    onClick={() => {
                      const reason = window.prompt("Reason for retrying this exchange:");
                      if (reason) act("/api/hospital/integrations/exchanges",
                        { action: "retry", source: e.source, exchangeId: e.id, reason }, "Retry attempted.");
                    }}
                    className="mt-2 flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] disabled:opacity-40 hover:border-cyan/40">
                    <RotateCw size={12} /> Retry
                  </button>
                )}
                {!e.retryEligible && e.operationalState === "REQUIRES_REVIEW" && (
                  <p className="mt-1 text-[11px] text-amber">
                    Retry budget exhausted or the failure is not transient. Resolve the cause and start a new exchange.
                  </p>
                )}
              </div>
            ))}
            {exchanges && (tab === "failures" ? failing : exchanges.exchanges ?? []).length === 0 && (
              <Empty>{tab === "failures" ? "No failed exchanges." : "No exchanges."}</Empty>
            )}
          </div>
        </Card>
      )}

      {tab === "callbacks" && (
        <Card>
          <CardLabel>Inbound callbacks</CardLabel>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Callback bodies are stored as a hash and a size, never in full. A rejected
            callback changed nothing.
          </p>
          <div className="mt-3 space-y-2">
            {(callbacks?.callbacks ?? []).map((c: any) => (
              <div key={`${c.source}-${c.id}`} className="rounded-lg border border-hairline px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12.5px] font-medium">{c.system} · {c.kind}</p>
                  <StatusPill label={c.status} tone={tone(c.status)} className="rounded-md" />
                </div>
                <p className="mt-1 break-all text-[11px] text-text-tertiary">
                  {new Date(c.receivedAt).toLocaleString("en-IN")} · correlation {c.correlationId ?? "—"}
                </p>
                {c.rejectionReason && <p className="mt-1 text-[11px] text-red">{c.rejectionReason}</p>}
              </div>
            ))}
            {callbacks && (callbacks.callbacks?.length ?? 0) === 0 && <Empty>No callbacks received.</Empty>}
          </div>
        </Card>
      )}
    </div>
  );
}
