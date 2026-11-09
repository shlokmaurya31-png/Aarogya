"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileInput } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";

/**
 * Flagship 4a — the hospital admin's import review queue
 * (docs/LEGACY_IMPORT_DESIGN.md §11.3). A re-imported patient whose details
 * differ waits here: accept the incoming details or keep the existing ones,
 * each with a reason, both audited. Accepting changes only the fields that
 * differed, and is refused if the patient's details changed since.
 */
type Details = { fullName: string; sex: string; dob: string | null; phone: string | null };
type Status = "OPEN" | "ACCEPTED" | "KEPT";
interface Review {
  id: string; sourceSystem: string; sourceKey: string; patientId: string;
  incoming: Details; existing: Details; differences: string[]; status: Status;
  createdAt: string; decidedAt: string | null; decisionReason: string | null; decidedBy: string | null;
  patient: { uhid: string; name: string } | null;
}

const FIELD_TEXT: Record<string, string> = { fullName: "Name", sex: "Sex", dob: "Date of birth", phone: "Phone" };
const TABS: [Status, string][] = [["OPEN", "To review"], ["ACCEPTED", "Accepted"], ["KEPT", "Kept"]];
const show = (field: string, d: Details) => {
  const v = d[field as keyof Details];
  if (!v) return "—";
  return field === "dob" ? new Date(v).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : v;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export function ImportReviewQueue() {
  const push = useToastStore((s) => s.push);
  const [status, setStatus] = useState<Status>("OPEN");
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback((s: Status) => {
    fetch(`/api/hospital/legacy-import/reviews?status=${s}`)
      .then(async (r) => (r.ok ? (setReviews((await r.json()).reviews), setError(null)) : setError((await r.json().catch(() => null))?.error ?? "The review queue is unavailable.")))
      .catch(() => setError("The review queue is unavailable."));
  }, []);
  useEffect(() => { load(status); }, [load, status]);

  async function decide(id: string, decision: "ACCEPT" | "KEEP") {
    if (!reason.trim()) { push("A reason is required.", "amber"); return; }
    setBusy(true);
    const r = await fetch(`/api/hospital/legacy-import/reviews/${id}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { push((await r?.json().catch(() => null))?.error ?? "That didn't go through.", "red"); load(status); return; }
    push(decision === "ACCEPT" ? "The incoming details are now the patient's." : "The existing details were kept.", "emerald");
    setOpen(null); setReason(""); load(status);
  }

  return (
    <div className="mx-auto max-w-5xl" aria-label="Import review">
      <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight"><FileInput size={18} /> Import review</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        Patients imported again from the old system with details that differ from the ones here. Nothing changes until you decide.
      </p>
      <div role="tablist" aria-label="Reviews" className="mt-4 flex gap-1">
        {TABS.map(([s, label]) => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => { setStatus(s); setReviews(null); setOpen(null); }}
            className={`rounded-full px-3 py-1 text-[12.5px] ${status === s ? "bg-cyan font-medium text-ink" : "border border-hairline text-text-secondary"}`}>
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="mt-4 text-[13px] text-amber">{error}</p>
        : !reviews ? <p className="mt-4 text-[13px] text-text-secondary">Loading…</p>
        : !reviews.length ? (
          <p className="mt-4 flex items-center gap-1.5 text-[13px] text-text-secondary">
            {status === "OPEN" ? <><CheckCircle2 size={14} className="text-success" /> Nothing waiting.</> : "None yet."}
          </p>
        ) : (
          <Card className="mt-4">
            <CardLabel>{status === "OPEN" ? `${reviews.length} to review` : `${reviews.length} decided`}</CardLabel>
            <ul className="mt-2 space-y-2">
              {reviews.map((r) => (
                <li key={r.id} aria-label={`Review for ${r.patient?.name ?? r.sourceKey}`} className="rounded-lg border border-hairline px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {r.patient?.name ?? "A patient"}
                      <span className="font-normal text-text-secondary"> · {r.patient?.uhid ?? "—"} · {r.sourceSystem} MRN {r.sourceKey}</span>
                    </span>
                    <span className="text-[11.5px] text-text-tertiary">queued {when(r.createdAt)}</span>
                  </div>
                  <table className="mt-2 w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[11.5px] text-text-tertiary"><th className="font-normal">Field</th><th className="font-normal">Here now</th><th className="font-normal">In the import</th></tr>
                    </thead>
                    <tbody>
                      {r.differences.map((f) => (
                        <tr key={f}><td className="py-0.5 pr-3 text-text-secondary">{FIELD_TEXT[f] ?? f}</td><td className="pr-3">{show(f, r.existing)}</td><td className="font-medium">{show(f, r.incoming)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {r.status !== "OPEN" ? (
                    <p className="mt-1.5 text-[12px] text-text-secondary">
                      {r.status === "ACCEPTED" ? "Accepted" : "Kept the existing details"} {when(r.decidedAt)}{r.decidedBy ? ` by ${r.decidedBy}` : ""}: {r.decisionReason}
                    </p>
                  ) : open === r.id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, audited)" maxLength={500}
                        className="min-w-[240px] flex-1 rounded-md border border-hairline bg-card px-2 py-1 text-[12px]" />
                      <button disabled={busy} onClick={() => decide(r.id, "ACCEPT")} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Accept the import</button>
                      <button disabled={busy} onClick={() => decide(r.id, "KEEP")} className="rounded-md border border-hairline px-3 py-1 text-[12px] font-medium disabled:opacity-50">Keep existing</button>
                      <button onClick={() => setOpen(null)} className="text-[12px] text-text-secondary">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => { setOpen(r.id); setReason(""); }} className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[12px]">Decide…</button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
    </div>
  );
}
