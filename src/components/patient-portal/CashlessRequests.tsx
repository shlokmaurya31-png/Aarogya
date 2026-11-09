"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, rupees } from "@/components/patient-portal/ui";

/**
 * Flagship 5, step 5 — cashless at the hospital (docs/CASHLESS_CLAIMS_DESIGN.md
 * §6): the documents the hospital proposes to send your insurer, each yours to
 * approve or remove (nothing is sent before), and the insurer's decision in
 * plain words: "Approved ₹X; your share ₹Y" from the hospital's estimate.
 * A household member with INSURANCE sees and approves for the member
 * (?memberPersonId=).
 */
interface Doc { id: string; title: string; status: "PROPOSED" | "APPROVED" | "REMOVED"; toDecide: boolean }
interface Req { id: string; hospital: string; status: string; text: string; approvedAmountMinor: number | null; estimateMinor: number; shareMinor: number | null; shareText: string | null; reasonText: string | null; documents: Doc[] }

function Approve({ r, member, onDone }: { r: Req; member: string | null; onDone: () => void }) {
  const pending = r.documents.filter((d) => d.toDecide);
  const [choice, setChoice] = useState<Record<string, "APPROVE" | "REMOVE">>(() => Object.fromEntries(pending.map((d) => [d.id, "APPROVE"])));
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function send() {
    const res = await fetch(`/api/patient/insurance/cashless/${r.id}/documents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: pending.map((d) => ({ documentId: d.id, decision: choice[d.id] })), confirmSensitive, ...(member ? { memberPersonId: member } : {}) }),
    }).catch(() => null);
    if (res?.ok) { onDone(); return; }
    setMsg((await res?.json().catch(() => null))?.error ?? "That didn't go through. Try again.");
  }
  return (
    <fieldset className="mt-2 space-y-1.5 rounded-lg border border-amber/30 bg-amber/5 p-2 text-[13px]">
      <legend className="px-1 text-[12.5px] font-medium">Documents for your insurer: approve each one you&apos;re happy to send</legend>
      {pending.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-2" role="group" aria-label={d.title}>
          <span>{d.title}</span>
          <span className="flex gap-3 text-[12.5px]">
            <label className="flex min-h-[44px] items-center gap-1"><input type="radio" name={`doc-${d.id}`} checked={choice[d.id] === "APPROVE"} onChange={() => setChoice({ ...choice, [d.id]: "APPROVE" })} /> Send</label>
            <label className="flex min-h-[44px] items-center gap-1"><input type="radio" name={`doc-${d.id}`} checked={choice[d.id] === "REMOVE"} onChange={() => setChoice({ ...choice, [d.id]: "REMOVE" })} /> Don&apos;t send</label>
          </span>
        </div>
      ))}
      {msg && <p role="alert" className="text-[12px] text-amber">{msg}</p>}
      {msg?.includes("sensitive") && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={confirmSensitive} onChange={(e) => setConfirmSensitive(e.target.checked)} /> Yes, send it to my insurer for this request</label>}
      <button onClick={send} className="min-h-[44px] rounded-md bg-cyan px-3 py-1 text-[13px] font-medium text-ink">Confirm my choices</button>
    </fieldset>
  );
}

export function CashlessRequests() {
  const member = useSearchParams().get("memberPersonId");
  const data = usePatientData<{ requests: Req[] }>(`/api/patient/insurance/cashless${member ? `?memberPersonId=${encodeURIComponent(member)}` : ""}`);
  return (
    <Card>
      <SectionTitle>Cashless at the hospital</SectionTitle>
      {data.state.status === "loading" ? <Empty>Loading…</Empty> : data.state.status === "error" ? <Unavailable label="Cashless" /> : data.state.data.requests.length === 0 ? <Empty>No cashless request.</Empty> : (
        <ul className="space-y-3">{data.state.data.requests.map((r) => (
          <li key={r.id} role="region" aria-label={`Cashless at ${r.hospital}`} className="border-b border-hairline pb-3 last:border-0">
            <p className="text-[14px] font-medium">{r.hospital}</p>
            <p role="status" className="text-[13px]">{r.text}.</p>
            {r.approvedAmountMinor !== null && (
              <p className="text-[14px] font-medium" aria-label="Cashless decision">Approved {rupees(r.approvedAmountMinor)}; your share {rupees(r.shareMinor ?? 0)}</p>
            )}
            {r.shareText && <p className="text-[12px] text-text-secondary">{r.shareText} ({rupees(r.estimateMinor)}).</p>}
            {r.reasonText && <p className="text-[12.5px]">{r.reasonText}.</p>}
            {r.documents.some((d) => d.toDecide) ? <Approve r={r} member={member} onDone={data.reload} /> : r.documents.length > 0 && (
              <ul className="mt-1 text-[12px] text-text-secondary" aria-label="Documents">
                {r.documents.map((d) => <li key={d.id}>{d.title}: {d.status === "APPROVED" ? "sent with your approval" : d.status === "REMOVED" ? "not sent (you removed it)" : "waiting"}</li>)}
              </ul>
            )}
          </li>
        ))}</ul>
      )}
    </Card>
  );
}
