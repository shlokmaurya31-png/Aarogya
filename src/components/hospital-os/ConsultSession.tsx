"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Loader2, LogOut, AlertTriangle, CheckCircle2, Clock, KeyRound } from "lucide-react";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { ageLabel } from "@/lib/patient/age";
import { ChartAi } from "@/components/ai/ChartAi";
import { SharedRecordSections, type SharedRecordData } from "./SharedRecordSections";

// Mirror of the server windows (src/lib/patient/accessSession.ts).
const WARN_THRESHOLD_MS = 1000 * 60 * 3;

/** Week 4c: the shared record (only what the patient's code shares) and the session. */
interface HistoryData extends SharedRecordData {
  session: { id: string; status: string; redeemedAt: string | null; doctorName: string | null; activeExpiresAt: string | null; extensionCount?: number };
  patient: { id: string; fullName: string; uhid: string; sex: string; dob: string | null; dobPrecision?: string; bloodGroup: string | null };
}

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  // Either the server said so (410 / failed extend) or the local countdown ran out.
  const isExpired = expired || (remainingMs != null && remainingMs <= 0 && !ended);

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

  if (isExpired) {
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
              {p.sex}{p.dob ? `, ${ageLabel(p)}y` : ""}{p.bloodGroup ? ` · ${p.bloodGroup}` : ""} · Shared by the patient&apos;s code · opened {fmt(data.session.redeemedAt)}
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

      {/* The AI over what this code shares (visit brief, chart Q&A); the server checks the share on every request. */}
      {data.session.status === "ACTIVE" && <ChartAi patientId={p.id} shareId={data.session.id} title="Visit brief from the shared record (cited, advisory)" />}

      <SharedRecordSections data={data} shareRef={sessionId} />
    </div>
  );
}
