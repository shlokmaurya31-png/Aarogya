"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck, Loader2, LogOut, AlertTriangle, Pill, FlaskConical, Activity,
  ClipboardList, Stethoscope, TriangleAlert, CheckCircle2, Clock, KeyRound,
} from "lucide-react";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

// Mirror of the server windows (src/lib/patient/accessSession.ts).
const WARN_THRESHOLD_MS = 1000 * 60 * 3;

interface HistoryData {
  session: { id: string; status: string; redeemedAt: string | null; doctorName: string | null; activeExpiresAt: string | null; extensionCount?: number };
  patient: {
    id: string; fullName: string; uhid: string; sex: string; ageYears: number | null; bloodGroup: string | null;
    allergies: { id: string; substance?: string; reaction?: string | null; severity?: string | null }[];
    problems: { id: string; description?: string; name?: string; status?: string | null }[];
    diagnoses: { id: string; description?: string; code?: string | null; createdAt: string }[];
    encounters: {
      id: string; type: string; status: string; chiefComplaint: string | null; registeredAt: string;
      department: { name: string } | null;
      attendingStaff: { user: { displayName: string } | null } | null;
    }[];
    medicationOrders: { id: string; drugName: string; dose: string; status: string; createdAt: string }[];
  };
  vitals: { id: string; recordedAt: string; spo2: number | null; heartRate?: number | null; temperature?: number | null }[];
  labResults: {
    id: string; resultedAt: string; value?: string | null; valueText?: string | null; flag?: string | null;
    catalogTest?: { name: string } | null;
    labOrder?: { catalogTest?: { name: string } | null } | null;
  }[];
}

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-hairline bg-card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-brand [&>svg]:size-[15px]">{icon}</span>
        <p className="text-[13px] font-semibold">{title}</p>
        {typeof count === "number" && <span className="text-[11px] text-text-tertiary">({count})</span>}
      </div>
      {children}
    </div>
  );
}

export function ConsultSession({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [extending, setExtending] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    fetch(`/api/hospital/patient-access/${sessionId}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (r.status === 410) { setExpired(true); return null; } // timed out server-side
        if (!r.ok) throw new Error(body?.error ?? "Failed to load.");
        return body as HistoryData;
      })
      .then((d) => {
        if (!d) return;
        setData(d);
        if (d.session.activeExpiresAt) setExpiresAt(new Date(d.session.activeExpiresAt).getTime());
      })
      .catch((e) => setError(e.message));
  }, [sessionId]);

  // 1s tick drives the live countdown; when it hits zero the consult auto-logs-off.
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remainingMs = expiresAt != null ? expiresAt - nowTs : null;
  useEffect(() => {
    if (remainingMs != null && remainingMs <= 0 && !ended && !expired) setExpired(true);
  }, [remainingMs, ended, expired]);

  async function continueSession() {
    setExtending(true);
    try {
      const res = await fetch(`/api/hospital/patient-access/${sessionId}/extend`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { push(body?.error ?? "Could not extend.", "amber"); if (res.status === 400) setExpired(true); return; }
      if (body.activeExpiresAt) setExpiresAt(new Date(body.activeExpiresAt).getTime());
      push("Session continued — 10 more minutes.", "emerald");
    } finally {
      setExtending(false);
    }
  }

  async function endVisit() {
    setEnding(true);
    try {
      const res = await fetch(`/api/hospital/patient-access/${sessionId}/end`, { method: "POST" });
      if (!res.ok) { push((await res.json()).error ?? "Failed to end.", "red"); return; }
      setEnded(true);
      push("Visit ended and logged.", "emerald");
    } finally {
      setEnding(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-hairline bg-card p-8 text-center">
        <AlertTriangle className="mx-auto text-amber" />
        <p className="mt-3 text-[14px] font-medium">This access session isn&apos;t available</p>
        <p className="mt-1 text-[12.5px] text-text-secondary">{error}</p>
        <button onClick={() => router.push("/patient-login")} className="mt-4 rounded-full border border-hairline px-4 py-2 text-[13px] hover:border-accent/40">
          Back to login
        </button>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-hairline bg-card p-8 text-center">
        <CheckCircle2 className="mx-auto text-emerald" />
        <p className="mt-3 text-[14px] font-medium">Visit logged</p>
        <p className="mt-1 text-[12.5px] text-text-secondary">
          The visit was recorded to both your and the patient&apos;s activity log, and their record is closed.
        </p>
        <button onClick={() => router.push("/patient-login")} className="mt-4 rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-on-accent hover:bg-accent-strong">
          Back to login
        </button>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-hairline bg-card p-8 text-center">
        <Clock className="mx-auto text-amber" />
        <p className="mt-3 text-[14px] font-medium">Session timed out</p>
        <p className="mt-1 text-[12.5px] text-text-secondary">
          The 15-minute consent window ended and the patient was automatically logged off. To continue,
          ask the patient to generate a <span className="font-medium text-text-primary">new access code</span>.
        </p>
        <button onClick={() => router.push("/patient-login")} className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-on-accent hover:bg-accent-strong">
          <KeyRound size={14} /> Enter a new code
        </button>
      </div>
    );
  }

  if (!data) {
    return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-2xl bg-fill-muted" /></div>;
  }

  const p = data.patient;
  const remainingSec = remainingMs != null ? Math.max(0, Math.floor(remainingMs / 1000)) : null;
  const warning = remainingMs != null && remainingMs <= WARN_THRESHOLD_MS;
  const countdown = remainingSec != null ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}` : null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <ToastViewport />

      {/* Active-session banner */}
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${warning ? "border-amber/40 bg-amber/[0.08]" : "border-accent/30 bg-accent/[0.06]"}`}>
        <div className="flex items-center gap-2.5">
          <ShieldCheck size={18} className="text-brand" />
          <div>
            <p className="text-[14px] font-semibold">{p.fullName} · <span className="font-normal text-text-secondary">{p.uhid}</span></p>
            <p className="text-[12px] text-text-tertiary">
              {p.sex}{p.ageYears != null ? `, ${p.ageYears}y` : ""}{p.bloodGroup ? ` · ${p.bloodGroup}` : ""} · Access granted by patient code · opened {fmt(data.session.redeemedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Live consent countdown */}
          {countdown != null && (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium tabular-nums ${warning ? "border-amber/40 text-amber" : "border-hairline text-text-secondary"}`}>
              <Clock size={13} /> Consent active · {countdown}
            </span>
          )}
          {/* "Continue this session" appears in the last few minutes */}
          {warning && (
            <button
              onClick={continueSession}
              disabled={extending}
              className="inline-flex animate-pulse items-center gap-2 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition hover:bg-accent-strong disabled:opacity-60"
            >
              {extending ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
              Continue session
            </button>
          )}
          <button
            onClick={endVisit}
            disabled={ending}
            title="End this visit now and log the patient off"
            className="inline-flex items-center gap-2 rounded-full bg-cta px-4 py-2 text-[13px] font-medium text-on-cta transition hover:bg-cta-strong disabled:opacity-60"
          >
            {ending ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
            Log out &amp; end visit
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Allergies — safety first */}
        <Section icon={<TriangleAlert />} title="Allergies" count={p.allergies.length}>
          {p.allergies.length ? (
            <ul className="space-y-1 text-[12.5px]">
              {p.allergies.map((a) => (
                <li key={a.id} className="text-danger">
                  {a.substance ?? "Allergen"}{a.reaction ? ` — ${a.reaction}` : ""}{a.severity ? ` (${a.severity})` : ""}
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-text-tertiary">No known allergies recorded.</p>}
        </Section>

        {/* Problems */}
        <Section icon={<ClipboardList />} title="Problems" count={p.problems.length}>
          {p.problems.length ? (
            <ul className="space-y-1 text-[12.5px] text-text-secondary">
              {p.problems.map((pr) => <li key={pr.id}>{pr.description ?? pr.name}{pr.status ? ` · ${pr.status}` : ""}</li>)}
            </ul>
          ) : <p className="text-[12.5px] text-text-tertiary">None recorded.</p>}
        </Section>

        {/* Medications */}
        <Section icon={<Pill />} title="Medications" count={p.medicationOrders.length}>
          {p.medicationOrders.length ? (
            <ul className="space-y-1 text-[12.5px] text-text-secondary">
              {p.medicationOrders.slice(0, 12).map((m) => <li key={m.id}>{m.drugName} {m.dose} <span className="text-text-tertiary">· {m.status}</span></li>)}
            </ul>
          ) : <p className="text-[12.5px] text-text-tertiary">No medication orders.</p>}
        </Section>

        {/* Recent labs */}
        <Section icon={<FlaskConical />} title="Recent labs" count={data.labResults.length}>
          {data.labResults.length ? (
            <ul className="space-y-1 text-[12.5px] text-text-secondary">
              {data.labResults.slice(0, 12).map((l) => (
                <li key={l.id} className={l.flag && l.flag !== "NORMAL" ? "text-amber" : ""}>
                  {(l.catalogTest?.name ?? l.labOrder?.catalogTest?.name ?? "Test")}: {l.value ?? l.valueText ?? "—"}{l.flag && l.flag !== "NORMAL" ? ` (${l.flag})` : ""}
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-text-tertiary">No results on file.</p>}
        </Section>
      </div>

      {/* Encounters timeline */}
      <Section icon={<Stethoscope />} title="Encounter history" count={p.encounters.length}>
        {p.encounters.length ? (
          <ul className="space-y-2">
            {p.encounters.map((e) => (
              <li key={e.id} className="flex items-start gap-2 border-b border-hairline pb-2 last:border-0 last:pb-0">
                <Activity size={13} className="mt-0.5 shrink-0 text-brand" />
                <div className="text-[12.5px]">
                  <p className="font-medium">{e.type} · <span className="font-normal text-text-secondary">{e.status}</span></p>
                  <p className="text-text-tertiary">
                    {fmt(e.registeredAt)}{e.department ? ` · ${e.department.name}` : ""}{e.attendingStaff?.user ? ` · ${e.attendingStaff.user.displayName}` : ""}
                    {e.chiefComplaint ? ` — ${e.chiefComplaint}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-text-tertiary">No encounters recorded.</p>}
      </Section>

      {/* Vitals */}
      <Section icon={<Activity />} title="Recent vitals" count={data.vitals.length}>
        {data.vitals.length ? (
          <div className="flex flex-wrap gap-2 text-[12px]">
            {data.vitals.slice(0, 8).map((v) => (
              <span key={v.id} className="rounded-lg border border-hairline bg-fill-subtle px-2.5 py-1 text-text-secondary">
                {fmt(v.recordedAt)}{v.spo2 != null ? ` · SpO₂ ${v.spo2}%` : ""}
              </span>
            ))}
          </div>
        ) : <p className="text-[12.5px] text-text-tertiary">No vitals recorded.</p>}
      </Section>
    </div>
  );
}
