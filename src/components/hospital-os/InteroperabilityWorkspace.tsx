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
type Tab = "overview" | "abdm" | "identities" | "consents" | "exchanges" | "imports" | "connections";

const TABS: { id: Tab; label: string; icon: typeof Fingerprint }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "abdm", label: "ABDM Connection", icon: Network },
  { id: "identities", label: "External Identities", icon: Fingerprint },
  { id: "consents", label: "Consents", icon: ShieldCheck },
  { id: "exchanges", label: "Exchanges", icon: Share2 },
  { id: "imports", label: "Imported / Conflicts", icon: FileJson },
  { id: "connections", label: "Registry Connections", icon: Network },
];

const ENDPOINTS: Record<Exclude<Tab, "overview" | "connections" | "abdm">, { url: string; key: string }> = {
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
  const [abdm, setAbdm] = useState<any>(null);
  const [testing, setTesting] = useState(false);

  const loadConnections = useCallback(() => {
    fetch("/api/hospital/interoperability/connections")
      .then((r) => r.json())
      .then((d) => setConnections(d ?? null))
      .catch(() => setConnections(null));
  }, []);
  useEffect(loadConnections, [loadConnections]);

  // Configured state only — this deliberately makes NO network call to ABDM, so
  // opening the workspace never authenticates against a national gateway.
  const loadAbdm = useCallback(() => {
    fetch("/api/hospital/interoperability/abdm/connection-test")
      .then((r) => r.json())
      .then((d) => setAbdm(d ?? null))
      .catch(() => setAbdm(null));
  }, []);
  useEffect(loadAbdm, [loadAbdm]);

  // The ONLY action that performs a real handshake. Explicit, audited.
  async function runConnectionTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/hospital/interoperability/abdm/connection-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { push(data.error ?? "Connection test failed.", "red"); return; }
      setAbdm((prev: any) => ({ ...(prev ?? {}), health: data.health }));
      push(`ABDM: ${data.health?.state ?? "UNKNOWN"}`, data.health?.state === "AVAILABLE" ? "emerald" : "amber");
    } finally {
      setTesting(false);
    }
  }

  const loadRows = useCallback((t: Tab) => {
    if (t === "overview" || t === "connections" || t === "abdm") return;
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

      {tab === "abdm" && (
        <div className="space-y-4">
          <Card>
            <CardLabel>ABDM connection</CardLabel>

            {/* State is the whole answer. AVAILABLE is the ONLY value that means
                connected, and it is only ever produced by a live handshake. */}
            <div className="mt-3 flex flex-wrap gap-2">
              <Metric
                label="State"
                value={abdm?.health?.state ?? "—"}
                tone={
                  abdm?.health?.state === "AVAILABLE" ? "emerald"
                    : abdm?.health?.state === "DISABLED" ? "neutral"
                      : abdm?.health?.state === "UNKNOWN" ? "amber" : "red"
                }
              />
              <Metric label="Environment" value={abdm?.health?.environment ?? "—"} />
              <Metric
                label="Credentials"
                value={abdm?.health?.config?.credentialsConfigured ? "Set" : "Not set"}
                tone={abdm?.health?.config?.credentialsConfigured ? "emerald" : "neutral"}
              />
              <Metric
                label="Callbacks"
                value={abdm?.health?.config?.callbacksConfigured ? "Ready" : "Off"}
                tone={abdm?.health?.config?.callbacksConfigured ? "emerald" : "neutral"}
              />
            </div>

            <p className="mt-3 text-xs text-text-secondary">{abdm?.health?.message ?? "Loading…"}</p>

            {abdm?.health?.state !== "AVAILABLE" && (
              <p className="mt-2 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
                This deployment has not established a verified ABDM connection. Configuration
                alone is reported as UNKNOWN on purpose: only a successful handshake against
                the configured gateway is shown as AVAILABLE. Clinical workflows are unaffected.
              </p>
            )}

            {(abdm?.health?.config?.warnings ?? []).map((w: string) => (
              <div key={w} className="mt-2 flex items-start gap-2 rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-[11px] text-amber">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}

            <button
              onClick={runConnectionTest}
              disabled={testing}
              className="mt-3 rounded-full border border-hairline px-3 py-1.5 text-xs transition hover:text-cyan disabled:opacity-50"
            >
              {testing ? "Testing…" : "Run connection test"}
            </button>
            <p className="mt-1 text-[10px] text-text-tertiary">
              Performs a real session handshake. Requires connection-management permission and is audited.
            </p>
          </Card>

          <Card>
            <CardLabel>Verified contract</CardLabel>
            <div className="mt-3 space-y-1 text-[11px] text-text-secondary">
              <p>
                Source: <span className="text-text-primary">{abdm?.health?.contractSource?.document ?? "—"}</span>{" "}
                v{abdm?.health?.contractSource?.version ?? "—"}
              </p>
              <p>Milestone: {abdm?.health?.contractSource?.milestone ?? "—"}</p>
              <p>Verified on: {abdm?.health?.contractSource?.verifiedOn ?? "—"}</p>
            </div>
            <p className="mt-2 text-[10px] text-text-tertiary">
              Capabilities without a verified official contract are not implemented. See
              docs/interoperability/abdm-contract-matrix.md.
            </p>
          </Card>

          <Card>
            <CardLabel>FHIR profiles</CardLabel>
            <div className="mt-3 flex flex-wrap gap-2">
              <Metric label="FHIR" value={abdm?.profiles?.ig?.fhirVersion ?? "—"} />
              <Metric label="IG version" value={abdm?.profiles?.ig?.version ?? "—"} />
              <Metric label="Registered" value={abdm?.profiles?.produced ?? 0} />
              <Metric label="Validated" value={abdm?.profiles?.validated ?? 0} tone="amber" />
            </div>
            {abdm && !abdm?.profiles?.profileValidationImplemented && (
              <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
                Resources are structurally valid FHIR R4. ABDM profile conformance is NOT
                asserted: the StructureDefinition package is not bundled with this deployment.
              </p>
            )}
            <div className="mt-3 space-y-1">
              {(abdm?.profiles?.profiles ?? []).slice(0, 20).map((pr: any) => (
                <div key={pr.canonical} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-text-secondary">{pr.resourceType}</span>
                  <StatusPill tone={pr.status === "REGISTERED" ? "cyan" : "neutral"} label={pr.status} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardLabel>Callback endpoints</CardLabel>
            <div className="mt-3 space-y-1">
              {(abdm?.callbackRoutes ?? []).map((r: any) => (
                <div key={r.kind} className="text-[11px]">
                  <p className="text-text-secondary">{r.kind}</p>
                  <p className="truncate font-mono text-[10px] text-text-tertiary">{r.url ?? r.path}</p>
                </div>
              ))}
            </div>
            {abdm && !abdm?.health?.config?.callbacksConfigured && (
              <p className="mt-3 text-[11px] text-text-tertiary">
                Inbound callbacks are refused until a callback base URL and token are configured.
              </p>
            )}
          </Card>
        </div>
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

      {tab !== "overview" && tab !== "connections" && tab !== "abdm" && (
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
                  {/* ABDM protocol state is shown SEPARATELY from the local
                      status. "authorized locally but never submitted" and
                      "the patient declined" are different facts and must not
                      be collapsed into one badge. */}
                  <p className="mt-0.5 text-[10px] text-text-tertiary">
                    ABDM: <span className="text-text-secondary">{r.abdmProtocolState ?? "NOT_SUBMITTED"}</span>
                    {r.abdmErrorCode ? <span className="text-red"> · {r.abdmErrorCode}</span> : null}
                    {r.abdmConsentId ? " · consent artefact linked" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(r.status)} label={r.status} />
                  {r.abdmProtocolState && (
                    <StatusPill
                      tone={
                        r.abdmProtocolState === "GRANTED" ? "emerald"
                          : ["DENIED", "REVOKED", "ERRORED", "EXPIRED"].includes(r.abdmProtocolState) ? "red"
                            : "cyan"
                      }
                      label={r.abdmProtocolState}
                    />
                  )}
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
