"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldCheck, Loader2, Copy, Check, X, Stethoscope } from "lucide-react";

interface LiveSession {
  id: string;
  status: "PENDING" | "ACTIVE" | "ENDED" | "EXPIRED" | "CANCELLED";
  purpose?: string | null;
  expiresAt?: string;
  redeemedAt?: string | null;
  doctorName?: string | null;
}

export default function PatientSharePage() {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [code, setCode] = useState<string | null>(null); // shown once, at issue time
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/patient/access-session");
    const data = await res.json();
    setSession(data.session ?? null);
    setLoading(false);
    // The one-time code is meaningless once the session is no longer live.
    if (!data.session || (data.session.status !== "PENDING" && data.session.status !== "ACTIVE")) {
      setCode(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while a session is live so the patient sees "doctor is viewing" / "ended".
  useEffect(() => {
    if (!session || (session.status !== "PENDING" && session.status !== "ACTIVE")) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [session, refresh]);

  async function generate() {
    setWorking(true);
    try {
      const res = await fetch("/api/patient/access-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (res.ok) {
        setCode(data.displayCode ?? data.code ?? null);
        await refresh();
      }
    } finally {
      setWorking(false);
    }
  }

  async function end() {
    if (!session) return;
    setWorking(true);
    try {
      await fetch(`/api/patient/access-session/${session.id}/end`, { method: "POST" });
      setCode(null);
      await refresh();
    } finally {
      setWorking(false);
    }
  }

  function copy() {
    if (!code) return;
    navigator.clipboard?.writeText(code.replace(/-/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const live = session && (session.status === "PENDING" || session.status === "ACTIVE");

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div className="flex items-center gap-2">
        <KeyRound size={18} className="text-brand" />
        <h1 className="text-[20px] font-semibold tracking-tight">Share with a doctor</h1>
      </div>
      <p className="text-[13px] leading-relaxed text-text-secondary">
        Generate a one-time code and read it out to your doctor. While it&apos;s active they can view your
        full history. You&apos;ll see when they open your record, and you can end access any time — it also
        ends automatically when the doctor finishes.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-text-tertiary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : !live ? (
        <div className="rounded-2xl border border-hairline bg-card p-6 text-center">
          <ShieldCheck size={26} className="mx-auto text-brand" />
          <p className="mt-3 text-[14px] font-medium">No active sharing</p>
          <p className="mt-1 text-[12.5px] text-text-secondary">
            Generate a code when you&apos;re with your doctor.
          </p>
          <button
            onClick={generate}
            disabled={working}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-on-accent transition hover:bg-accent-strong disabled:opacity-60"
          >
            {working ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            Generate access code
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border border-hairline bg-card p-6">
          {/* Status */}
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
              <span className={`size-2 rounded-full ${session!.status === "ACTIVE" ? "bg-emerald" : "bg-amber animate-pulse"}`} />
              {session!.status === "ACTIVE"
                ? `Dr. ${session!.doctorName ?? "your doctor"} is viewing your record`
                : "Waiting for your doctor to enter the code…"}
            </span>
          </div>

          {/* The code (only available right after generating) */}
          {code ? (
            <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-5 text-center">
              <p className="type-label text-text-tertiary">Your access code</p>
              <p className="mt-1 font-mono text-[30px] font-semibold tracking-[0.2em] text-brand">{code}</p>
              <button onClick={copy} className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-brand">
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy code"}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-hairline bg-fill-subtle p-4 text-center text-[12.5px] text-text-secondary">
              <Stethoscope size={18} className="mx-auto mb-1 text-brand" />
              Your code was shown once. If the doctor didn&apos;t catch it, end this and generate a new one.
            </div>
          )}

          <button
            onClick={end}
            disabled={working}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-hairline px-4 py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-danger/40 hover:text-danger disabled:opacity-60"
          >
            {working ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            End access now
          </button>
        </div>
      )}
    </div>
  );
}
