"use client";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, ShieldCheck, Share2, FileJson, Network, AlertTriangle, Activity } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase C1 — Hospital OS interoperability workspace.
 *
 * Intentionally a small operational console, not an admin suite: it shows what
 * is mapped, what is consented, what has been exchanged and what failed. Every
 * number is read from the API, which is itself facility-scoped server-side, so
 * this component never filters by facility on the client.
 *
 * The Overview deliberately separates CONFIGURED state from RUNTIME capability,
 * because a connection row saying PRODUCTION means nothing if the process has no
 * credentials. Showing them as one number would imply connectivity that may not
 * exist.
 */
type Tab = "overview" | "identities" | "consents" | "exchanges" | "imports" | "connections";

const TABS: { id: Tab; label: string; icon: typeof Fingerprint }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "identities", label: "External Identities", icon: Fingerprint },
  { id: "consents", label: "Consents", icon: ShieldCheck },
  { id: "exchanges", label: "Exchanges", icon: Share2 },
  { id: "imports", label: "Imported / Conflicts", icon: FileJson },
  { id: "connections", label: "Registry Connections", icon: Network },
];

const ENDPOINTS: Record<Exclude<Tab, "overview" | "connections">, { url: string; key: string }> = {
  identities: { url: "/api/hospital/interoperability/identifiers", key: "identifiers" },
  consents: { url: "/api/hospital/interoperability/consents", key: "consents" },
  exchanges: { url: "/api/hospital/interoperability/exchanges", key: "exchanges" },
  imports: { url: "/api/hospital/interoperability/fhir/import", key: "resources" },
};

const tone = (s: string): "emerald" | "amber" | "red" | "cyan" | "neutral" =>
  ["ACTIVE", "GRANTED", "COMPLETED", "VERIFIED", "IMPORTED", "MAPPED", "SYNCED"].includes(s) ? "emerald"
    : ["REVOKED", "FAILED", "REJECTED", "CANCELLED", "CONFLICT", "INVALID", "ERROR"].includes(s) ? "red"
      : ["REQUESTED", "RECEIVED", "UNVERIFIED", "NOT_CONFIGURED", "DISABLED"].includes(s) ? "neutral"
        : ["EXPIRED", "SUPERSEDED", "DECLINED", "SANDBOX"].includes(s) ? "amber" : "cyan";

function Metric({ label, value, tone: t = "neutral" }: { label: string; value: number | string; tone?: "red" | "amber" | "cyan" | "neutral" | "emerald" }) {
  const color = t === "red" ? "text-red" : t === "amber" ? "text-amber" : t === "cyan" ? "text-cyan" : t === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[104px]">
      <p className={`text-[19px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

/** Mask a national identifier in the UI; the full value is never needed here. */
function maskValue(value: string) {
  if (!value) return "";
  return value.length <= 4 ? "*".repeat(value.length) : "*".repeat(Math.max(0, value.length - 4)) + value.slice(-4);
}

export function InteroperabilityWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("overview");
  // Rows are tagged with the tab they belong to, so "loading" is DERIVED from a
  // tab/data mismatch rather than from a synchronous setState inside the effect
  // (which would trigger a cascading render).
  const [loaded, setLoaded] = useState<{ tab: Tab; data: any[] } | null>(null);
  const [connections, setConnections] = useState<any>(null);

  const loadConnections = useCallback(() => {
    fetch("/api/hospital/interoperability/connections")
      .then((r) => r.json())
      .then((d) => setConnections(d ?? null))
      .catch(() => setConnections(null));
  }, []);
  useEffect(loadConnections, [loadConnections]);

  const loadRows = useCallback((t: Tab) => {
    if (t === "overview" || t === "connections") return;
    const e = ENDPOINTS[t];
    fetch(e.url)
      .then((r) => r.json())
      .then((d) => setLoaded({ tab: t, data: d[e.key] ?? [] }))
      .catch(() => setLoaded({ tab: t, data: [] }));
  }, []);
  useEffect(() => { loadRows(tab); }, [tab, loadRows]);

  async function patch(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadRows(tab); loadConnections(); return true;
  }

  const rows = loaded && loaded.tab === tab ? loaded.data : null;
  const runtime = connections?.runtime;
  const caps = runtime?.capabilities;

  return (
    <div className="space-y-4">
      <ToastViewport />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
                tab === t.id ? "border-cyan bg-cyan/10 text-cyan" : "border-hairline text-text-secondary hover:text-text-primary"
              }`}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <Card>
          <CardLabel>Interoperability status</CardLabel>

          {/* The honest headline: what this process can actually do right now. */}
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="ABDM environment" value={runtime?.abdm?.environment ?? "—"} tone={runtime?.abdm?.environment === "PRODUCTION" ? "emerald" : runtime?.abdm?.environment === "SANDBOX" ? "amber" : "neutral"} />
            <Metric label="Credentials" value={runtime?.abdm?.credentialsConfigured ? "Set" : "Not set"} tone={runtime?.abdm?.credentialsConfigured ? "emerald" : "neutral"} />
            <Metric label="Live operations" value={caps?.operations?.length ?? 0} tone={(caps?.operations?.length ?? 0) > 0 ? "emerald" : "neutral"} />
            <Metric label="Configured systems" value={connections?.connections?.length ?? 0} />
          </div>

          {runtime && !runtime.safe && runtime.warning && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red/40 bg-red/5 px-3 py-2 text-xs text-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{runtime.warning}</span>
            </div>
          )}

          {runtime && (runtime.abdm?.environment === "DISABLED" || !runtime.abdm?.credentialsConfigured) && (
            <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
              External exchange is not active. Identifier mappings, consents and FHIR
              composition all work locally; nothing is transmitted to ABDM, and no
              identifier can be verified against a registry, until an operator supplies
              the environment configuration. Clinical workflows are unaffected.
            </p>
          )}

          {runtime?.abdm?.missing?.length > 0 && (
            <p className="mt-2 text-[11px] text-text-tertiary">
              Missing configuration: <span className="text-amber">{runtime.abdm.missing.join(", ")}</span>
            </p>
          )}
        </Card>
      )}

      {tab === "connections" && (
        <Card>
          <CardLabel>Registry connections</CardLabel>
          <div className="mt-3 space-y-2">
            {(connections?.connections ?? []).length === 0 && (
              <p className="text-xs text-text-tertiary">No external system has been configured for this facility yet.</p>
            )}
            {(connections?.connections ?? []).map((c: any) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{c.system}</p>
                  <p className="text-[11px] text-text-tertiary">
                    {c.baseUrl ? c.baseUrl : "no endpoint configured"}
                    {c.lastSyncedAt ? ` · last sync ${new Date(c.lastSyncedAt).toLocaleString()}` : " · never synchronised"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(c.environment)} label={c.environment} />
                  <StatusPill tone={c.enabled ? "emerald" : "neutral"} label={c.enabled ? "ENABLED" : "OFF"} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab !== "overview" && tab !== "connections" && (
        <Card>
          <CardLabel>{TABS.find((t) => t.id === tab)?.label}</CardLabel>
          {rows === null && <p className="mt-3 text-xs text-text-tertiary">Loading…</p>}
          {rows?.length === 0 && <p className="mt-3 text-xs text-text-tertiary">Nothing recorded yet.</p>}

          <div className="mt-3 space-y-2">
            {tab === "identities" && rows?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">
                    {r.entityType} · <span className="font-mono text-xs">{maskValue(r.value)}</span>
                  </p>
                  <p className="truncate text-[11px] text-text-tertiary">{r.system}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(r.verificationStatus)} label={r.verificationStatus} />
                  <StatusPill tone={tone(r.status)} label={r.status} />
                </div>
              </div>
            ))}

            {tab === "consents" && rows?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{r.purpose} → {r.recipientName ?? r.recipientIdentifier}</p>
                  <p className="text-[11px] text-text-tertiary">
                    {(r.scopes ?? []).map((s: any) => s.scope).join(", ") || "no scope"}
                    {r.expiresAt ? ` · expires ${new Date(r.expiresAt).toLocaleDateString()}` : " · no expiry"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(r.status)} label={r.status} />
                  {["GRANTED", "ACTIVE"].includes(r.status) && (
                    <button
                      onClick={() => patch(`/api/hospital/interoperability/consents/${r.id}`, { action: "revoke", reason: "Revoked from workspace" }, "Consent revoked.")}
                      className="rounded-full border border-red/40 px-2.5 py-1 text-[11px] text-red hover:bg-red/10"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}

            {tab === "exchanges" && rows?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{r.direction} · {r.destinationSystem} · {r.purpose}</p>
                  <p className="text-[11px] text-text-tertiary">
                    {r.requestedScopes || "no scope"}
                    {r.failureReason ? <span className="text-red"> · {r.failureReason}</span> : null}
                    {r.retryCount > 0 ? ` · ${r.retryCount}/${r.maxRetries} retries` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(r.status)} label={r.status} />
                  {r.status === "REQUESTED" && (
                    <button
                      onClick={() => patch(`/api/hospital/interoperability/exchanges/${r.id}`, { action: "authorize" }, "Exchange authorized.")}
                      className="rounded-full border border-hairline px-2.5 py-1 text-[11px] hover:text-cyan"
                    >
                      Authorize
                    </button>
                  )}
                  {r.status === "AUTHORIZED" && (
                    <button
                      onClick={() => patch(`/api/hospital/interoperability/exchanges/${r.id}`, { action: "dispatch" }, "Dispatch attempted.")}
                      className="rounded-full border border-hairline px-2.5 py-1 text-[11px] hover:text-cyan"
                    >
                      Dispatch
                    </button>
                  )}
                  {r.status === "FAILED" && r.retryCount < r.maxRetries && (
                    <button
                      onClick={() => patch(`/api/hospital/interoperability/exchanges/${r.id}`, { action: "retry" }, "Retry attempted.")}
                      className="rounded-full border border-hairline px-2.5 py-1 text-[11px] hover:text-amber"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
            ))}

            {tab === "imports" && rows?.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{r.resourceType} · {r.sourceSystem}</p>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {r.conflictReason ?? r.rejectionReason ?? `external id ${r.externalResourceId}`}
                  </p>
                </div>
                <StatusPill tone={tone(r.status)} label={r.status} />
              </div>
            ))}
          </div>

          {tab === "imports" && (
            <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
              Imported resources are staged for review. Nothing here has been written
              into a clinical record, and a conflicting external record is never merged
              automatically.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
