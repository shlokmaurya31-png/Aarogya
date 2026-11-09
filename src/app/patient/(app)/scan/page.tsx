"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, SectionTitle, Empty } from "@/components/patient-portal/ui";

/**
 * Flagship 6 — Scan and Share (docs/ABDM_CERTIFICATION_PLAN.md §8): you
 * scanned the hospital's QR at the counter. Confirm your ABHA address and
 * share your ABHA profile; you get a token and join the check-in queue, with
 * no form to fill. (A mock ABDM gateway until the sandbox; your Aadhaar
 * number is never asked for or kept.)
 */
function Scan() {
  const q = useSearchParams();
  const [hip, counter, sig] = [q.get("hip") ?? "", q.get("counter") ?? "", q.get("sig") ?? ""];
  const [target, setTarget] = useState<{ facility: string; counter: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [abha, setAbha] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ token: string; status: string; facility: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/patient/scan-share/target?hip=${encodeURIComponent(hip)}&counter=${encodeURIComponent(counter)}&sig=${encodeURIComponent(sig)}`).then(async (r) => {
      const d = await r.json().catch(() => null);
      if (alive) { if (r.ok) setTarget(d); else setErr(d?.error ?? "This QR code couldn't be read."); }
    }).catch(() => alive && setErr("This QR code couldn't be read."));
    return () => { alive = false; };
  }, [hip, counter, sig]);
  async function share() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/patient/scan-share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hip, counter, sig, abhaAddress: abha }) }).catch(() => null);
    const d = await r?.json().catch(() => null);
    setBusy(false);
    if (r?.ok) setDone(d); else setErr(d?.error ?? "That didn't go through. Try again.");
  }
  if (done) {
    return (
      <Card>
        <SectionTitle>You&apos;re in the queue</SectionTitle>
        <p className="mt-2 text-[13px]">{done.facility}</p>
        <p className="mt-3 text-[40px] font-semibold tracking-tight" aria-label="Your token">{done.token}</p>
        <p className="mt-1 text-[12.5px] text-text-secondary">{done.status === "QUEUED" ? "The hospital has your record: wait to be called." : "Show this token at the counter: the desk registers you from your ABHA profile."}</p>
      </Card>
    );
  }
  if (err && !target) return <p className="text-[13px] text-amber">{err}</p>;
  if (!target) return <Empty>Reading the QR code…</Empty>;
  return (
    <Card>
      <SectionTitle>Check in at {target.facility}</SectionTitle>
      <p className="mt-1 text-[12.5px] text-text-secondary">{target.counter}. Share your ABHA profile (name, sex, date of birth, phone) and get a token. Nothing else is shared, and your Aadhaar number is never asked for.</p>
      <label className="mt-3 block text-[12px] text-text-secondary">Your ABHA address
        <input aria-label="ABHA address" value={abha} onChange={(e) => setAbha(e.target.value)} placeholder="name@sbx" className="mt-1 block w-full rounded-md border border-hairline bg-card px-3 py-2 text-[14px]" />
      </label>
      <button disabled={busy || !abha.trim()} onClick={share} className="mt-3 rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-ink disabled:opacity-50">Share and get my token</button>
      {err && <p className="mt-2 text-[12.5px] text-amber">{err}</p>}
    </Card>
  );
}

export default function ScanPage() {
  return <Suspense fallback={<Empty>Reading the QR code…</Empty>}><Scan /></Suspense>;
}
