"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";

/**
 * Week 4c — asking the patient for their records from other hospitals
 * (docs/CONSENT_SHARING_DESIGN.md §5): pick the categories and a reason; the
 * patient approves (perhaps narrower) or declines in their app. An approved
 * request opens the shared record. The server decides who may ask.
 */
interface Req { id: string; status: string; categories: string[]; createdAt: string; share: { id: string; status: string; expiresAt: string } | null }
const LABEL: Record<string, string> = { PRESCRIPTIONS: "Prescriptions", LABS: "Labs", IMAGING: "Imaging", DISCHARGE_SUMMARIES: "Discharge summaries", UPLOADS: "Patient uploads" };
const STATUS: Record<string, string> = { REQUESTED: "Waiting for the patient", APPROVED: "Approved", DECLINED: "Declined", CANCELLED: "Withdrawn", EXPIRED: "Expired" };

export function RecordRequests({ patientId }: { patientId: string }) {
  const [list, setList] = useState<Req[] | null>(null);
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<string[]>(["LABS", "PRESCRIPTIONS"]);
  const [purpose, setPurpose] = useState("CONSULTATION");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    fetch(`/api/hospital/access-requests?patientId=${encodeURIComponent(patientId)}`).then((r) => (r.ok ? r.json() : null)).then((d) => alive && setList(d?.requests ?? [])).catch(() => undefined);
    return () => { alive = false; };
  }, [patientId, tick]);

  async function send() {
    setMessage(null);
    const r = await fetch("/api/hospital/access-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId, categories, purpose, reason: reason.trim() || undefined }) }).catch(() => null);
    if (!r?.ok) return setMessage(r?.status === 404 ? "This patient has no Aarogya account linked here, so they can't be asked." : ((await r?.json().catch(() => null))?.error ?? "The request didn't go through."));
    setOpen(false); setReason(""); setMessage("Sent. The patient decides in their app."); load();
  }

  return (
    <section className="rounded-2xl border border-hairline p-4" aria-label="Records from other hospitals">
      <div className="flex items-center gap-2">
        <Inbox size={15} className="text-cyan" aria-hidden />
        <h2 className="text-[13.5px] font-semibold">Records from other hospitals</h2>
        <button onClick={() => setOpen(!open)} className="ml-auto rounded-md border border-hairline px-2.5 py-1 text-[12px]">{open ? "Close" : "Ask the patient"}</button>
      </div>
      {open && (
        <div className="mt-3 space-y-2 text-[12.5px]">
          <div className="flex flex-wrap gap-3">
            {Object.entries(LABEL).map(([k, v]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={categories.includes(k)} onChange={() => setCategories((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]))} />{v}</label>
            ))}
          </div>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Purpose" className="rounded-md border border-hairline bg-transparent px-2 py-1">
            <option value="CONSULTATION">Consultation</option><option value="SECOND_OPINION">Second opinion</option><option value="FOLLOW_UP">Follow-up</option><option value="REFERRAL">Referral</option>
          </select>
          <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 280))} placeholder="Why (shown to the patient)" aria-label="Reason" className="w-full rounded-md border border-hairline bg-transparent px-2.5 py-1.5" />
          <p className="text-text-tertiary">Sensitive records (mental health, HIV and similar) can only be added by the patient.</p>
          <button onClick={send} disabled={!categories.length} className="rounded-md bg-cyan px-3 py-1.5 font-medium text-ink disabled:opacity-50">Send request</button>
        </div>
      )}
      {message && <p className="mt-2 text-[12px] text-text-secondary">{message}</p>}
      {list && list.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[12.5px]">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{r.categories.map((c) => LABEL[c] ?? c).join(", ")} · <span className="text-text-secondary">{STATUS[r.status] ?? r.status}</span></span>
              {r.share?.status === "ACTIVE" && <Link href={`/hospital-os/doctor/shares/${r.share.id}`} className="text-cyan underline-offset-2 hover:underline">Open shared record</Link>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
