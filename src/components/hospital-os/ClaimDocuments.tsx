"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Week 5c — documents for a claim: billing staff ask the patient (they never
 * answer the insurer themselves); what the patient attaches opens here one
 * document at a time, through the claim's share, until the claim settles.
 */
interface Req { id: string; description: string; status: string; shareId: string | null; documents: { id: string; title: string }[] }

export function ClaimDocuments({ claimId }: { claimId: string }) {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch(`/api/hospital/claims/${claimId}/document-requests`).then((r) => (r.ok ? r.json() : null)).then((d) => setReqs(d?.requests ?? [])).catch(() => setReqs([]));
  }, [claimId]);
  useEffect(load, [load]);
  async function ask() {
    const r = await fetch(`/api/hospital/claims/${claimId}/document-requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: text }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setText(""); setMsg(d.patientLinked ? "The patient has been asked." : "Asked; the patient hasn't linked their Aarogya account, so tell them at the desk."); load(); } else setMsg(d.error ?? "That didn't go through.");
  }
  async function open(requestId: string, documentId: string) {
    const r = await fetch(`/api/hospital/claim-document-requests/${requestId}/documents/${documentId}`);
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) window.open(d.url, "_blank", "noopener"); else setMsg("The document can't be opened.");
  }
  return (
    <div className="space-y-2 border-t border-hairline pt-3">
      <p className="text-text-tertiary">Documents from the patient</p>
      {reqs.map((r) => (
        <div key={r.id} className="rounded-md border border-hairline p-2">
          <p>{r.description} · <span className="text-text-tertiary">{r.status.toLowerCase()}</span></p>
          {r.shareId && r.documents.map((d) => <button key={d.id} onClick={() => open(r.id, d.id)} className="mt-1 block text-cyan underline">{d.title}</button>)}
        </div>
      ))}
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What does the insurer need? (plain words)" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 outline-none focus:border-cyan/40" />
      <button onClick={ask} disabled={text.trim().length < 5} className="w-full rounded-md border border-hairline px-2 py-1.5 hover:border-cyan/40 disabled:opacity-50">Ask the patient for a document</button>
      {msg && <p className="text-[11px] text-text-secondary">{msg}</p>}
    </div>
  );
}
