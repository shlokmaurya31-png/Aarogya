"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, Siren, FileLock2, Activity, AlertTriangle } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase C4 — Hospital OS trust and security workspace.
 *
 * A small operational console, not a cybersecurity dashboard. It shows what
 * emergency access is open, what privacy requests are outstanding, and what the
 * session/MFA posture actually is.
 *
 * Two display rules it follows strictly:
 *   - MFA is never shown as verified. There is no MFA provider, and the panel
 *     says so, naming the mechanism that IS enforced.
 *   - No token, secret or clinical payload is rendered anywhere.
 */
type Tab = "overview" | "breakglass" | "privacy" | "sessions";

const TABS: { id: Tab; label: string; icon: typeof ShieldAlert }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "breakglass", label: "Emergency Access", icon: Siren },
  { id: "privacy", label: "Privacy Requests", icon: FileLock2 },
  { id: "sessions", label: "Sessions & MFA", icon: ShieldAlert },
];

const tone = (s: string): "emerald" | "amber" | "red" | "cyan" | "neutral" =>
  ["ACTIVE", "APPROVED", "ACTIONED", "COMPLETED"].includes(s) ? "emerald"
    : ["REVOKED", "REJECTED", "EXPIRED"].includes(s) ? "red"
      : ["REQUESTED", "NOT_CONFIGURED"].includes(s) ? "neutral" : "cyan";

function Metric({ label, value, tone: t = "neutral" }: { label: string; value: number | string; tone?: "red" | "amber" | "cyan" | "neutral" | "emerald" }) {
  const color = t === "red" ? "text-red" : t === "amber" ? "text-amber" : t === "cyan" ? "text-cyan" : t === "emerald" ? "text-emerald" : "";
  return (
    <div className="rounded-xl border border-hairline px-3 py-2 min-w-[104px]">
      <p className={`text-[19px] font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
    </div>
  );
}

export function SecurityWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("overview");
  const [breakGlass, setBreakGlass] = useState<any>(null);
  const [privacy, setPrivacy] = useState<any>(null);

  const loadBreakGlass = useCallback(() => {
    fetch("/api/hospital/security/break-glass")
      .then((r) => r.json()).then((d) => setBreakGlass(d ?? null)).catch(() => setBreakGlass(null));
  }, []);
  const loadPrivacy = useCallback(() => {
    fetch("/api/hospital/security/privacy-requests")
      .then((r) => r.json()).then((d) => setPrivacy(d ?? null)).catch(() => setPrivacy(null));
  }, []);
  useEffect(loadBreakGlass, [loadBreakGlass]);
  useEffect(loadPrivacy, [loadPrivacy]);

  async function patch(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push(ok, "emerald"); loadBreakGlass(); loadPrivacy();
  }

  const report = breakGlass?.report;

  return (
    <div className="space-y-4">
      <ToastViewport />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
                tab === t.id ? "border-cyan bg-cyan/10 text-cyan" : "border-hairline text-text-secondary hover:text-text-primary"
              }`}>
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <Card>
          <CardLabel>Trust posture</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="Emergency access open" value={report?.active ?? 0} tone={(report?.active ?? 0) > 0 ? "amber" : "neutral"} />
            <Metric label="Lapsed, unswept" value={report?.lapsed ?? 0} tone={(report?.lapsed ?? 0) > 0 ? "amber" : "neutral"} />
            <Metric label="Activated, never used" value={report?.unused ?? 0} tone={(report?.unused ?? 0) > 0 ? "amber" : "neutral"} />
            <Metric label="Privacy requests" value={privacy?.requests?.length ?? 0} />
          </div>
          <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
            Emergency access relaxes the care-relationship requirement for one patient,
            for a bounded period. It never unlocks external disclosure, never crosses a
            facility boundary, and every use is recorded.
          </p>
        </Card>
      )}

      {tab === "breakglass" && (
        <div className="space-y-4">
          <Card>
            <CardLabel>Emergency access windows</CardLabel>
            {(breakGlass?.windows ?? []).length === 0 && (
              <p className="mt-3 text-xs text-text-tertiary">No emergency access has been activated.</p>
            )}
            <div className="mt-3 space-y-2">
              {(breakGlass?.windows ?? []).map((w: any) => (
                <div key={w.id} className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary">{w.emergencyContext}</p>
                    {/* The reason IS the accountability record, so it is shown. */}
                    <p className="text-[11px] text-text-secondary">{w.reason}</p>
                    <p className="mt-0.5 text-[10px] text-text-tertiary">
                      expires {new Date(w.expiresAt).toLocaleString()} · used {w.useCount}×
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={tone(w.status)} label={w.status} />
                    {w.status === "ACTIVE" && (
                      <button
                        onClick={() => patch("/api/hospital/security/break-glass",
                          { breakGlassId: w.id, action: "revoke", reason: "Revoked from the security workspace." },
                          "Emergency access revoked.")}
                        className="rounded-full border border-red/40 px-2.5 py-1 text-[11px] text-red hover:bg-red/10">
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardLabel>Usage report</CardLabel>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Deterministic counts over the last {report?.windowDays ?? 30} days. No scoring, no anomaly detection.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Metric label="Total" value={report?.total ?? 0} />
              <Metric label="Active" value={report?.active ?? 0} />
              <Metric label="Revoked" value={report?.revoked ?? 0} tone={(report?.revoked ?? 0) > 0 ? "red" : "neutral"} />
            </div>
            {(report?.repeatedPatients ?? []).length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] text-amber">Patients accessed under emergency access more than once:</p>
                {report.repeatedPatients.map((p: any) => (
                  <p key={p.patientId} className="text-[10px] text-text-tertiary">{p.patientId} · {p.count}×</p>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "privacy" && (
        <Card>
          <CardLabel>Privacy requests</CardLabel>
          {(privacy?.requests ?? []).length === 0 && (
            <p className="mt-3 text-xs text-text-tertiary">No privacy requests have been raised.</p>
          )}
          <div className="mt-3 space-y-2">
            {(privacy?.requests ?? []).map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{r.requestType}</p>
                  <p className="text-[11px] text-text-tertiary">
                    raised by {r.requesterType}
                    {r.legalHold ? <span className="text-amber"> · legal hold</span> : null}
                    {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={tone(r.status)} label={r.status} />
                  {r.status === "REQUESTED" && (
                    <button
                      onClick={() => patch("/api/hospital/security/privacy-requests",
                        { privacyRequestId: r.id, to: "UNDER_REVIEW" }, "Moved to review.")}
                      className="rounded-full border border-hairline px-2.5 py-1 text-[11px] hover:text-cyan">
                      Review
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
            A deletion request is a request, not an instruction. Aarogya performs no
            automated deletion of clinical, financial or audit records; the workflow ends
            in a recorded decision.
          </p>
        </Card>
      )}

      {tab === "sessions" && (
        <Card>
          <CardLabel>Sessions and multi-factor authentication</CardLabel>

          {/* The honesty panel. MFA is never rendered as verified. */}
          <div className="mt-3 flex flex-wrap gap-2">
            <Metric label="MFA provider" value="Not configured" tone="neutral" />
            <Metric label="Step-up mechanism" value="Auth recency" tone="cyan" />
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber/40 bg-amber/5 px-3 py-2 text-[11px] text-amber">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              No multi-factor provider is configured for this deployment. Sensitive actions
              require a recently authenticated session, which is a real control but is NOT
              MFA. No action anywhere reports MFA as verified.
            </span>
          </div>

          <p className="mt-3 rounded-xl border border-hairline px-3 py-2 text-[11px] leading-relaxed text-text-tertiary">
            Sessions are stateless signed cookies. Revocation invalidates every session a
            user holds at once — used for logout everywhere, password change, role change
            and administrative revoke. Revoking a single device while leaving others
            signed in is not supported.
          </p>
        </Card>
      )}
    </div>
  );
}
