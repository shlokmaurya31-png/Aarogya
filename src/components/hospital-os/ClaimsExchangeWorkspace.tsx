"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Send, FileStack, MessageSquareWarning, Banknote,
  AlertTriangle, Network, ShieldQuestion,
} from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { minorToRupees } from "@/lib/hospital/billing/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase C5 — NHCX claims exchange workspace.
 *
 * Sits BESIDE the Phase 5 claims worklist rather than replacing it: that screen
 * remains the canonical place to record a payer decision manually, and this one
 * is the protocol boundary. Keeping them apart is deliberate — an operator must
 * be able to tell "we have not sent this" from "they have not answered".
 *
 * Two honesty rules drive the whole layout:
 *
 *   1. Transport state is shown as the adapter reports it. When nothing is
 *      configured the workspace says so plainly instead of rendering an idle
 *      dashboard that implies a working connection.
 *   2. The pre-flight checklist shows BLOCKERS separately from WARNINGS, and the
 *      dispatch control stays disabled while any blocker stands. The button is
 *      not a suggestion the server will re-decide; the server refuses too.
 */
type Tab =
  | "overview" | "preflight" | "submissions" | "exchanges"
  | "queries" | "settlements" | "exceptions" | "health";

const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "preflight", label: "Pre-Flight", icon: ShieldQuestion },
  { id: "submissions", label: "Submissions", icon: FileStack },
  { id: "exchanges", label: "Exchanges", icon: Send },
  { id: "queries", label: "Queries", icon: MessageSquareWarning },
  { id: "settlements", label: "Settlements", icon: Banknote },
  { id: "exceptions", label: "Exceptions", icon: AlertTriangle },
  { id: "health", label: "Exchange Health", icon: Network },
];

const tone = (s: string): "emerald" | "amber" | "red" | "cyan" | "neutral" =>
  ["ACCEPTED", "APPROVED", "SETTLED", "RECONCILED", "RESOLVED", "AVAILABLE"].includes(s) ? "emerald"
    : ["FAILED", "REJECTED", "DENIED", "CONFLICT", "CRITICAL", "DISPUTED"].includes(s) ? "red"
      : ["DRAFT", "NOT_SUBMITTED", "NOT_CONFIGURED", "DISABLED", "CLOSED", "DISMISSED"].includes(s) ? "neutral"
        : ["SUPERSEDED", "UNDER_REVIEW", "OPEN", "WARNING", "SANDBOX", "NOTIFIED"].includes(s) ? "amber" : "cyan";

function money(minor: number | null | undefined) {
  if (minor == null) return "—";
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function Metric({ label, value, t = "neutral" }: { label: string; value: number | string; t?: string }) {
  const color = t === "red" ? "text-red" : t === "amber" ? "text-amber"
    : t === "cyan" ? "text-cyan" : t === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[104px]">
      <p className={`text-[19px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[12px] text-text-tertiary">{children}</p>;
}

export function ClaimsExchangeWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("overview");

  const [overview, setOverview] = useState<any>(null);
  const [claims, setClaims] = useState<any[] | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<string | null>(null);
  const [loadedDetail, setLoadedDetail] = useState<{ claimId: string; data: any } | null>(null);
  const [queries, setQueries] = useState<any>(null);
  const [recon, setRecon] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(() => {
    fetch("/api/hospital/claims/nhcx")
      .then((r) => r.json()).then((d) => setOverview(d ?? null)).catch(() => setOverview(null));
  }, []);
  useEffect(loadOverview, [loadOverview]);

  // Claims come from the canonical Phase 5 endpoint. This workspace does not
  // maintain a second claim list of its own.
  useEffect(() => {
    fetch("/api/hospital/claims").then((r) => r.json())
      .then((d) => setClaims(d.claims ?? [])).catch(() => setClaims([]));
  }, []);

  // Detail is tagged with the claim it belongs to, so "stale" is DERIVED from a
  // tag mismatch rather than from a synchronous setState inside the effect
  // (which would trigger a cascading render). Same pattern as the C1 workspace.
  const loadDetail = useCallback((claimId: string) => {
    fetch(`/api/hospital/claims/nhcx?claimId=${encodeURIComponent(claimId)}`)
      .then((r) => r.json())
      .then((d) => setLoadedDetail({ claimId, data: d ?? null }))
      .catch(() => setLoadedDetail({ claimId, data: null }));
  }, []);
  useEffect(() => { if (selectedClaim) loadDetail(selectedClaim); }, [selectedClaim, loadDetail]);

  useEffect(() => {
    if (tab !== "queries") return;
    fetch("/api/hospital/claims/nhcx/queries").then((r) => r.json())
      .then((d) => setQueries(d ?? null)).catch(() => setQueries(null));
  }, [tab]);

  useEffect(() => {
    if (tab !== "settlements" && tab !== "exceptions") return;
    fetch("/api/hospital/claims/nhcx/reconciliation").then((r) => r.json())
      .then((d) => setRecon(d ?? null)).catch(() => setRecon(null));
  }, [tab]);

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/hospital/claims/nhcx", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { push(data.error ?? "Failed.", "red"); return null; }
      push(ok, "emerald");
      if (selectedClaim) loadDetail(selectedClaim);
      loadOverview();
      return data;
    } finally { setBusy(false); }
  }

  // Detail from a previous selection is treated as absent, not shown.
  const detail = loadedDetail && loadedDetail.claimId === selectedClaim ? loadedDetail.data : null;
  const conn = overview?.connectivity;
  const notConfigured = conn && (conn.config?.environment === "DISABLED" || (conn.capabilities?.operations?.length ?? 0) === 0);
  const readiness = detail?.readiness;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />

      <div>
        <div className="flex items-center gap-2">
          <Send size={18} className="text-cyan" />
          <h1 className="text-[20px] font-semibold tracking-tight">Claims Exchange</h1>
        </div>
        <p className="mt-1 text-[13px] text-text-secondary">
          NHCX claim packaging, submission, payer queries and settlement reconciliation.
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

      {/* The unconfigured banner is shown on EVERY tab, not just the health tab.
          A workspace that looks operational while nothing can be transmitted is
          exactly the misreading this phase is meant to prevent. */}
      {notConfigured && (
        <div className="flex items-start gap-2 rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-[11.5px] leading-relaxed text-amber">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            No NHCX transport is active. Claims can be packaged, validated, versioned and
            audited locally, and every screen below is real; but nothing is transmitted to
            an exchange, and no payer response can arrive, until an operator supplies
            verified endpoint configuration. Billing is unaffected.
          </span>
        </div>
      )}

      {tab === "overview" && (
        <Card>
          <CardLabel>Claims exchange status</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="Claims" value={(overview?.claimsByStatus ?? []).reduce((a: number, r: any) => a + (r._count ?? 0), 0)} />
            <Metric label="Exchanges" value={(overview?.exchangesByState ?? []).reduce((a: number, r: any) => a + (r._count ?? 0), 0)} />
            <Metric label="Failed" value={overview?.failedExchanges?.length ?? 0} t={(overview?.failedExchanges?.length ?? 0) > 0 ? "red" : "neutral"} />
            <Metric label="Open queries" value={overview?.openQueries ?? 0} t={(overview?.openQueries ?? 0) > 0 ? "amber" : "neutral"} />
            <Metric label="Open exceptions" value={overview?.openExceptions ?? 0} t={(overview?.openExceptions ?? 0) > 0 ? "red" : "neutral"} />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Claims by canonical status</p>
              <div className="mt-2 space-y-1">
                {(overview?.claimsByStatus ?? []).map((r: any) => (
                  <div key={r.status} className="flex items-center justify-between text-[12px]">
                    <StatusPill label={r.status} tone={tone(r.status)} className="rounded-md" />
                    <span className="text-text-secondary">{r._count}</span>
                  </div>
                ))}
                {(overview?.claimsByStatus?.length ?? 0) === 0 && <Empty>No claims yet.</Empty>}
              </div>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Exchanges by protocol state</p>
              <div className="mt-2 space-y-1">
                {(overview?.exchangesByState ?? []).map((r: any) => (
                  <div key={r.protocolState} className="flex items-center justify-between text-[12px]">
                    <StatusPill label={r.protocolState} tone={tone(r.protocolState)} className="rounded-md" />
                    <span className="text-text-secondary">{r._count}</span>
                  </div>
                ))}
                {(overview?.exchangesByState?.length ?? 0) === 0 && <Empty>Nothing has been dispatched.</Empty>}
              </div>
            </div>
          </div>
        </Card>
      )}

      {(tab === "preflight" || tab === "submissions" || tab === "exchanges") && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          <Card>
            <CardLabel>Claims</CardLabel>
            <div className="mt-3 space-y-2">
              {(claims ?? []).map((c: any) => (
                <button key={c.id} onClick={() => setSelectedClaim(c.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left ${
                    selectedClaim === c.id ? "border-cyan/40 bg-cyan/[0.04]" : "border-hairline"}`}>
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-medium">{c.claimNumber ?? "DRAFT"}</p>
                    <p className="truncate text-[10.5px] text-text-tertiary">{c.coverage?.payer?.name}</p>
                  </div>
                  <StatusPill label={c.status} tone={tone(c.status)} className="rounded-md" />
                </button>
              ))}
              {claims && claims.length === 0 && <Empty>No claims yet.</Empty>}
            </div>
          </Card>

          <div className="space-y-4">
            {!selectedClaim && <Card><Empty>Select a claim.</Empty></Card>}

            {selectedClaim && tab === "preflight" && (
              <Card>
                <CardLabel>Pre-flight checklist</CardLabel>
                {!detail ? <Empty>Loading…</Empty> : (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Metric label="Claimed" value={money(detail.package?.claimedAmountMinor)} />
                      <Metric label="Lines" value={detail.package?.lines?.length ?? 0} />
                      <Metric label="Documents" value={detail.package?.documents?.length ?? 0} />
                      <Metric label="Blockers" value={readiness?.blockers?.length ?? 0} t={(readiness?.blockers?.length ?? 0) > 0 ? "red" : "emerald"} />
                    </div>

                    {/* Blockers and warnings are never merged into one list: a
                        warning is information, a blocker is a refusal. */}
                    {(readiness?.blockers?.length ?? 0) > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {readiness.blockers.map((b: string, i: number) => (
                          <div key={i} className="flex items-start gap-2 rounded-lg border border-red/40 bg-red/5 px-3 py-2 text-[11.5px] text-red">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />{b}
                          </div>
                        ))}
                      </div>
                    )}
                    {(readiness?.warnings?.length ?? 0) > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {readiness.warnings.map((w: string, i: number) => (
                          <div key={i} className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-[11.5px] text-amber">{w}</div>
                        ))}
                      </div>
                    )}
                    {(readiness?.excludedDocuments?.length ?? 0) > 0 && (
                      <p className="mt-2 text-[11px] text-text-tertiary">
                        {readiness.excludedDocuments.length} document(s) were withheld from the
                        package by minimisation or authorization and will not be disclosed.
                      </p>
                    )}

                    <button
                      disabled={busy || !readiness?.submittable}
                      onClick={() => act({ action: "build", claimId: selectedClaim }, "Submission package built.")}
                      className="mt-4 w-full rounded-md bg-cyan px-3 py-2 text-[12.5px] font-medium text-ink disabled:opacity-40 hover:brightness-110">
                      {readiness?.submittable ? "Build submission package" : "Blocked — resolve the items above"}
                    </button>
                  </>
                )}
              </Card>
            )}

            {selectedClaim && tab === "submissions" && (
              <Card>
                <CardLabel>Submission versions</CardLabel>
                <div className="mt-3 space-y-2">
                  {(detail?.submissions ?? []).map((s: any) => (
                    <div key={s.id} className="rounded-lg border border-hairline px-3 py-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[12.5px] font-medium">v{s.version} · {s.submissionType}</p>
                        <StatusPill label={s.status} tone={tone(s.status)} className="rounded-md" />
                      </div>
                      <p className="mt-1 text-[11px] text-text-tertiary">
                        Claimed {money(s.claimedAmountMinor)} · Approved {money(s.approvedAmountMinor)}
                        {s.snapshotHash ? ` · ${s.snapshotHash.slice(0, 12)}…` : ""}
                      </p>
                      {s.correctionReason && <p className="mt-1 text-[11px] text-amber">Correction: {s.correctionReason}</p>}
                      {["READY", "DRAFT"].includes(s.status) && (
                        <button disabled={busy}
                          onClick={() => act({ action: "dispatch", submissionId: s.id }, "Dispatch attempted.")}
                          className="mt-2 rounded-md border border-cyan/40 px-2.5 py-1 text-[11.5px] text-cyan disabled:opacity-40 hover:bg-cyan/5">
                          Dispatch
                        </button>
                      )}
                    </div>
                  ))}
                  {detail && (detail.submissions?.length ?? 0) === 0 && <Empty>Nothing built yet for this claim.</Empty>}
                </div>
              </Card>
            )}

            {selectedClaim && tab === "exchanges" && (
              <Card>
                <CardLabel>Exchange attempts</CardLabel>
                <div className="mt-3 space-y-2">
                  {(detail?.exchanges ?? []).map((e: any) => (
                    <div key={e.id} className="rounded-lg border border-hairline px-3 py-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[12.5px] font-medium">{e.exchangeType} · {e.direction}</p>
                        <StatusPill label={e.protocolState} tone={tone(e.protocolState)} className="rounded-md" />
                      </div>
                      <p className="mt-1 break-all text-[11px] text-text-tertiary">
                        correlation {e.correlationId} · attempt {e.attemptCount}/{e.maxAttempts}
                      </p>
                      {e.errorCategory && (
                        <p className="mt-1 text-[11px] text-red">{e.errorCategory}: {e.errorMessage}</p>
                      )}
                      {e.protocolState === "FAILED" && (
                        <button disabled={busy}
                          onClick={() => act({ action: "retry", exchangeId: e.id }, "Retry attempted.")}
                          className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] disabled:opacity-40 hover:border-cyan/40">
                          Retry
                        </button>
                      )}
                    </div>
                  ))}
                  {detail && (detail.exchanges?.length ?? 0) === 0 && <Empty>No exchange has been attempted.</Empty>}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === "queries" && (
        <Card>
          <CardLabel>Payer queries</CardLabel>
          <div className="mt-3 space-y-2">
            {(queries?.queries ?? []).map((q: any) => (
              <div key={q.id} className="rounded-lg border border-hairline px-3 py-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12.5px] font-medium">{q.reasonCode ?? "Clarification"}</p>
                  <StatusPill label={q.status} tone={tone(q.status)} className="rounded-md" />
                </div>
                {/* Payer text is untrusted external content: rendered as text, never as markup. */}
                <p className="mt-1 whitespace-pre-wrap text-[11.5px] text-text-secondary">{q.questionText}</p>
                {q.dueAt && <p className="mt-1 text-[11px] text-amber">Due {new Date(q.dueAt).toLocaleDateString("en-IN")}</p>}
                {q.responseText && <p className="mt-1 whitespace-pre-wrap text-[11px] text-text-tertiary">Answered: {q.responseText}</p>}
              </div>
            ))}
            {queries && (queries.queries?.length ?? 0) === 0 && <Empty>No payer queries.</Empty>}
          </div>
        </Card>
      )}

      {tab === "settlements" && (
        <Card>
          <CardLabel>Settlement notifications</CardLabel>
          <p className="mt-2 text-[11px] text-text-tertiary">
            A settlement notification is evidence, not a payment. Recording one here never
            moves money; the canonical receipt is still entered in Billing → Payments.
          </p>
          <div className="mt-3 space-y-2">
            {(recon?.settlements ?? []).map((s: any) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2">
                <div>
                  <p className="text-[12.5px] font-medium">{money(s.settledAmountMinor)}</p>
                  <p className="text-[11px] text-text-tertiary">ref {s.externalSettlementRef}</p>
                </div>
                <StatusPill label={s.status} tone={tone(s.status)} className="rounded-md" />
              </div>
            ))}
            {recon && (recon.settlements?.length ?? 0) === 0 && <Empty>No settlements recorded.</Empty>}
          </div>
        </Card>
      )}

      {tab === "exceptions" && (
        <Card>
          <CardLabel>Reconciliation exceptions</CardLabel>
          <div className="mt-3 space-y-2">
            {(recon?.exceptions ?? []).map((e: any) => (
              <div key={e.id} className="rounded-lg border border-hairline px-3 py-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12.5px] font-medium">{e.exceptionType}</p>
                  <div className="flex items-center gap-1.5">
                    <StatusPill label={e.severity} tone={tone(e.severity)} className="rounded-md" />
                    <StatusPill label={e.status} tone={tone(e.status)} className="rounded-md" />
                  </div>
                </div>
                <p className="mt-1 text-[11.5px] text-text-secondary">{e.detail}</p>
                {e.varianceMinor != null && (
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    Expected {money(e.expectedAmountMinor)} · Actual {money(e.actualAmountMinor)} · Variance {money(e.varianceMinor)}
                  </p>
                )}
              </div>
            ))}
            {recon && (recon.exceptions?.length ?? 0) === 0 && <Empty>No open exceptions.</Empty>}
          </div>
        </Card>
      )}

      {tab === "health" && (
        <div className="space-y-4">
          <Card>
            <CardLabel>Transport</CardLabel>
            <div className="mt-3 flex flex-wrap gap-2">
              <Metric label="Environment" value={conn?.config?.environment ?? "—"}
                t={conn?.config?.environment === "PRODUCTION" ? "emerald" : conn?.config?.environment === "SANDBOX" ? "amber" : "neutral"} />
              <Metric label="Credentials" value={conn?.config?.credentialsConfigured ? "Set" : "Not set"}
                t={conn?.config?.credentialsConfigured ? "emerald" : "neutral"} />
              <Metric label="Live operations" value={conn?.capabilities?.operations?.length ?? 0}
                t={(conn?.capabilities?.operations?.length ?? 0) > 0 ? "emerald" : "neutral"} />
              <Metric label="Failed exchanges" value={overview?.failedExchanges?.length ?? 0}
                t={(overview?.failedExchanges?.length ?? 0) > 0 ? "red" : "neutral"} />
            </div>
            {conn && !conn.safe && conn.warning && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-red/40 bg-red/5 px-3 py-2 text-xs text-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{conn.warning}</span>
              </div>
            )}
            {conn?.config?.missing?.length > 0 && (
              <p className="mt-2 text-[11px] text-text-tertiary">
                Missing configuration: <span className="text-amber">{conn.config.missing.join(", ")}</span>
              </p>
            )}
          </Card>

          {/* Provenance of the contract itself. What was verified against a
              published specification, and what was NOT, is stated rather than
              implied — an unverifiable endpoint must not look settled. */}
          <Card>
            <CardLabel>Contract provenance</CardLabel>
            {conn?.contract ? (
              <div className="mt-3 space-y-1.5 text-[11.5px] text-text-secondary">
                <p><span className="text-text-tertiary">Source:</span> {conn.contract.document}</p>
                <p><span className="text-text-tertiary">Publisher:</span> {conn.contract.publisher} ({conn.contract.published})</p>
                <p><span className="text-text-tertiary">FHIR:</span> {conn.contract.fhirVersion} · claim bundle type <code>{conn.contract.claimBundleType}</code></p>
                <p className={conn.contract.transportVerified ? "text-emerald" : "text-amber"}>
                  Transport contract verified: {conn.contract.transportVerified ? "yes" : "no"}
                </p>
                {conn.contract.transportBlockedReason && (
                  <p className="text-text-tertiary">{conn.contract.transportBlockedReason}</p>
                )}
              </div>
            ) : <Empty>Unavailable.</Empty>}
          </Card>

          <Card>
            <CardLabel>Recent failures</CardLabel>
            <div className="mt-3 space-y-2">
              {(overview?.failedExchanges ?? []).map((e: any) => (
                <div key={e.id} className="rounded-lg border border-hairline px-3 py-2 text-[11.5px]">
                  <p className="font-medium">{e.exchangeType} · attempt {e.attemptCount}/{e.maxAttempts}</p>
                  <p className="mt-0.5 text-red">{e.errorCategory}: {e.errorMessage}</p>
                </div>
              ))}
              {overview && (overview.failedExchanges?.length ?? 0) === 0 && <Empty>No failures.</Empty>}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
