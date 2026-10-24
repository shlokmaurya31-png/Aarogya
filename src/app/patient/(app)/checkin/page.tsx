"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, SectionTitle, Empty, formatDateTime } from "@/components/patient-portal/ui";
import { DEFAULT_SHARE_CHOICE, ShareChoices, choiceBody, type ShareChoiceValue } from "@/components/patient-portal/ShareChoices";

/**
 * Week 5c — check in before you arrive (docs/PATIENT_INSURANCE_DESIGN.md §3):
 * confirm your details, optionally share your record with the doctor and
 * attach an insurance card (or pay yourself), and get your token. Open from
 * 24 hours until 1 hour before the visit. The hospital checks your card;
 * you don't wait for the insurer.
 */
interface CardDto { id: string; payerName: string; payerTypeLabel: string; memberIdMasked: string | null }
interface CheckInDto { id: string; status: string; token: string; eligibilityText: string; needsDesk: string | null; hasShare: boolean; hasCard: boolean }
interface Options {
  visit: { kind: string; id: string; start: string; label: string; opensAt: string; closesAt: string; open: boolean };
  details: { name: string; dateOfBirth: string | null; phone: string | null; uhid: string };
  bookingShare: boolean; cards: CardDto[]; canAttachCard: boolean; checkIn: CheckInDto | null;
}

function CheckIn() {
  const q = useSearchParams();
  const ref = q.get("appointmentId") ? `appointmentId=${q.get("appointmentId")}` : `admissionRequestId=${q.get("admissionRequestId")}`;
  const member = q.get("memberPersonId");
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<"yes" | "no" | "">("");
  const [cardId, setCardId] = useState<string>("");
  const [wantShare, setWantShare] = useState(false);
  const [choice, setChoice] = useState<ShareChoiceValue>({ categories: [...DEFAULT_SHARE_CHOICE], sensitiveCategories: [], from: "", to: "" });
  const [done, setDone] = useState<CheckInDto | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/patient/checkin?${ref}${member ? `&memberPersonId=${member}` : ""}`).then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!alive) return;
      if (r.ok) { setOpts(d); setDone(d.checkIn); } else setErr(d?.error ?? "This visit couldn't be found.");
    });
    return () => { alive = false; };
  }, [ref, member]);
  async function submit() {
    const body: Record<string, unknown> = { ...Object.fromEntries(new URLSearchParams(ref)), ...(member ? { memberPersonId: member } : {}) };
    if (confirmed === "yes") body.detailsConfirmed = true; else body.detailsMismatch = true;
    if (cardId === "SELF") body.selfPay = true; else body.cardId = cardId;
    if (wantShare && !opts?.bookingShare) body.share = choiceBody(choice);
    const r = await fetch("/api/patient/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = await r?.json().catch(() => null);
    if (r?.ok) { setDone(d); setErr(null); } else setErr(d?.error ?? "That didn't go through. Try again.");
  }
  if (err && !opts) return <Empty>{err}</Empty>;
  if (!opts) return <Empty>Loading…</Empty>;
  return (
    <div className="space-y-4">
      <h1 className="text-[18px] font-semibold">Check in before you arrive</h1>
      <p className="text-[13px] text-text-secondary">{opts.visit.label} · {formatDateTime(opts.visit.start)}</p>
      {done ? (
        <Card>
          <div role="region" aria-label="Your check-in">
            <SectionTitle>You&apos;re checked in</SectionTitle>
            <p className="text-[13px]">Your token</p>
            <p className="font-mono text-[28px] tracking-[0.15em] text-brand" aria-label="Token">{done.token}</p>
            <p className="mt-2 text-[13px]">{done.eligibilityText}</p>
            {done.needsDesk && <p className="mt-1 text-[13px] text-amber">{done.needsDesk}</p>}
            <p className="mt-2 text-[12px] text-text-tertiary">Show this token at the hospital. When you arrive you&apos;ll go {done.status === "NEEDS_DESK" ? "to the desk first" : "straight to the doctor's queue once the desk marks you ready"}.</p>
          </div>
        </Card>
      ) : !opts.visit.open ? (
        <Empty>Check-in opens {formatDateTime(opts.visit.opensAt)} and closes {formatDateTime(opts.visit.closesAt)}.</Empty>
      ) : (
        <>
          <Card>
            <SectionTitle>1. Your details at the hospital</SectionTitle>
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[13px]" aria-label="Details">
              <dt className="text-text-tertiary">Name</dt><dd>{opts.details.name}</dd>
              <dt className="text-text-tertiary">Date of birth</dt><dd>{opts.details.dateOfBirth ?? "—"}</dd>
              <dt className="text-text-tertiary">Phone</dt><dd>{opts.details.phone ?? "—"}</dd>
              <dt className="text-text-tertiary">Hospital no.</dt><dd>{opts.details.uhid}</dd>
            </dl>
            <div className="mt-2 flex gap-4 text-[13px]">
              <label className="flex items-center gap-1.5"><input type="radio" name="details" checked={confirmed === "yes"} onChange={() => setConfirmed("yes")} /> These are right</label>
              <label className="flex items-center gap-1.5"><input type="radio" name="details" checked={confirmed === "no"} onChange={() => setConfirmed("no")} /> Something is wrong (the desk will fix it)</label>
            </div>
          </Card>
          <Card>
            <SectionTitle>2. Share your record with the doctor (optional)</SectionTitle>
            {opts.bookingShare ? <p className="text-[13px] text-text-secondary">You already shared your record when you booked.</p> : (
              <>
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={wantShare} onChange={(e) => setWantShare(e.target.checked)} /> Share my record for this visit</label>
                {wantShare && <div className="mt-2"><ShareChoices value={choice} onChange={setChoice} /></div>}
              </>
            )}
          </Card>
          <Card>
            <SectionTitle>3. Insurance</SectionTitle>
            <select aria-label="Insurance" value={cardId} onChange={(e) => setCardId(e.target.value)} className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]">
              <option value="">Choose…</option>
              {opts.cards.map((c) => <option key={c.id} value={c.id}>{c.payerName} · {c.payerTypeLabel} · {c.memberIdMasked}</option>)}
              <option value="SELF">I&apos;ll pay myself</option>
            </select>
            {opts.canAttachCard && opts.cards.length === 0 && <p className="mt-1 text-[12px] text-text-tertiary">No cards yet. <Link href="/patient/insurance" className="text-cyan">Add one</Link>.</p>}
            <p className="mt-1 text-[12px] text-text-tertiary">The hospital checks your card; your check-in doesn&apos;t wait for the insurer.</p>
          </Card>
          {err && <p className="text-[12px] text-red" role="alert">{err}</p>}
          <button onClick={submit} disabled={!confirmed || !cardId} className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">Check in and get my token</button>
        </>
      )}
    </div>
  );
}

export default function CheckInPage() {
  return <Suspense fallback={<Empty>Loading…</Empty>}><CheckIn /></Suspense>;
}
