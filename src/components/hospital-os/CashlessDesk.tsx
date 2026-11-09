"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeIndianRupee } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";

/**
 * Flagship 5, step 5 — the cashless desk (docs/CASHLESS_CLAIMS_DESIGN.md §6):
 * start a pre-authorisation from an admission, proposing the hospital's
 * documents (the patient approves them in the app before anything is sent);
 * follow each request; answer the insurer's questions. The exchange is the
 * mock NHCX adapter until the real one is written.
 */
type Status = "AWAITING_PATIENT" | "SUBMITTED" | "QUERY" | "APPROVED" | "PARTIAL" | "REJECTED" | "CANCELLED";
interface Doc { id: string; title: string; round: number; status: "PROPOSED" | "APPROVED" | "REMOVED"; decidedVia: "OWNER" | "PROXY" | null }
interface Req {
  id: string; status: Status; patient: { name: string; uhid: string } | null; diagnosis: string; plannedProcedure: string;
  estimateMinor: number; approvedAmountMinor: number | null; decisionReason: string | null; queryText: string | null; queryAnswer: string | null;
  documents: Doc[]; canAdd: { id: string; title: string }[];
}
interface Candidate { encounterId: string; patient: { name: string; uhid: string }; diagnosis: string | null; documents: { id: string; title: string }[] }

const STATUS_TEXT: Record<Status, string> = {
  AWAITING_PATIENT: "Waiting for the patient to approve documents", SUBMITTED: "With the insurer", QUERY: "The insurer asked a question",
  APPROVED: "Approved", PARTIAL: "Partly approved", REJECTED: "Rejected", CANCELLED: "Withdrawn",
};
const DOC_TEXT: Record<Doc["status"], string> = { PROPOSED: "waiting for the patient", APPROVED: "approved, sent", REMOVED: "removed by the patient" };
const inr = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const data = await r?.json().catch(() => null);
  return r?.ok ? { ok: true as const } : { ok: false as const, error: (data?.error as string) ?? "That didn't go through." };
}

function StartRequest({ c, onDone }: { c: Candidate; onDone: () => void }) {
  const push = useToastStore((s) => s.push);
  const [f, setF] = useState({ diagnosis: c.diagnosis ?? "", plannedProcedure: "", estimate: "" });
  const [docs, setDocs] = useState<string[]>([]);
  const input = "w-full rounded-md border border-hairline bg-card px-2 py-1 text-[12.5px]";
  async function start() {
    const r = await post("/api/hospital/cashless", { encounterId: c.encounterId, diagnosis: f.diagnosis, plannedProcedure: f.plannedProcedure, estimateMinor: Math.round(Number(f.estimate) * 100), documentIds: docs });
    if (!r.ok) { push(r.error, "red"); return; }
    push("Sent to the patient to approve the documents.", "emerald");
    onDone();
  }
  return (
    <div role="region" aria-label={`Start cashless for ${c.patient.name}`} className="mt-2 space-y-1.5 rounded-lg border border-hairline p-2">
      <label className="block text-[11.5px] text-text-secondary">Diagnosis<input aria-label="Diagnosis" className={input} value={f.diagnosis} onChange={(e) => setF({ ...f, diagnosis: e.target.value })} /></label>
      <label className="block text-[11.5px] text-text-secondary">Planned procedure<input aria-label="Planned procedure" className={input} value={f.plannedProcedure} onChange={(e) => setF({ ...f, plannedProcedure: e.target.value })} /></label>
      <label className="block text-[11.5px] text-text-secondary">Hospital&apos;s estimate (₹)<input aria-label="Estimate in rupees" inputMode="numeric" className={input} value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <fieldset className="text-[12px]">
        <legend className="text-[11.5px] text-text-secondary">Documents the insurer needs (the patient approves each)</legend>
        {c.documents.length === 0 && <p className="text-text-tertiary">No hospital documents for this patient yet.</p>}
        {c.documents.map((d) => (
          <label key={d.id} className="flex items-center gap-2"><input type="checkbox" checked={docs.includes(d.id)} onChange={(e) => setDocs(e.target.checked ? [...docs, d.id] : docs.filter((x) => x !== d.id))} /> {d.title}</label>
        ))}
      </fieldset>
      <button onClick={start} disabled={!docs.length || !f.plannedProcedure || !f.estimate} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Ask the patient to approve</button>
    </div>
  );
}

function AnswerQuery({ r, onDone }: { r: Req; onDone: () => void }) {
  const push = useToastStore((s) => s.push);
  const [answer, setAnswer] = useState("");
  const [docs, setDocs] = useState<string[]>([]);
  async function send() {
    const res = await post(`/api/hospital/cashless/${r.id}/answer`, { answer, documentIds: docs });
    if (!res.ok) { push(res.error, "red"); return; }
    push(docs.length ? "The patient is asked to approve the added documents; the answer goes after." : "The answer was sent to the insurer.", "emerald");
    onDone();
  }
  return (
    <div className="mt-2 space-y-1.5">
      <textarea aria-label="Answer to the insurer" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} className="w-full rounded-md border border-hairline bg-card px-2 py-1 text-[12.5px]" />
      {r.canAdd.length > 0 && (
        <fieldset className="text-[12px]">
          <legend className="text-[11.5px] text-text-secondary">Add documents (the patient approves them first)</legend>
          {r.canAdd.map((d) => <label key={d.id} className="flex items-center gap-2"><input type="checkbox" checked={docs.includes(d.id)} onChange={(e) => setDocs(e.target.checked ? [...docs, d.id] : docs.filter((x) => x !== d.id))} /> {d.title}</label>)}
        </fieldset>
      )}
      <button onClick={send} disabled={answer.trim().length < 5} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink disabled:opacity-50">Send the answer</button>
    </div>
  );
}

export function CashlessDesk() {
  const [data, setData] = useState<{ open: Req[]; decided: Req[]; candidates: Candidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch("/api/hospital/cashless")
      .then(async (r) => (r.ok ? (setData(await r.json()), setError(null)) : setError((await r.json().catch(() => null))?.error ?? "The cashless desk is unavailable.")))
      .catch(() => setError("The cashless desk is unavailable."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const row = (r: Req) => (
    <li key={r.id} aria-label={`Cashless for ${r.patient?.name ?? "a patient"}`} className="rounded-lg border border-hairline px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{r.patient?.name ?? "A patient"} <span className="font-normal text-text-secondary">· {r.patient?.uhid ?? "—"}</span></span>
        <span role="status" className="text-[12px]">{STATUS_TEXT[r.status]}</span>
      </div>
      <p className="mt-0.5 text-[12px] text-text-secondary">{r.diagnosis} · {r.plannedProcedure} · estimate {inr(r.estimateMinor)}{r.approvedAmountMinor !== null ? ` · approved ${inr(r.approvedAmountMinor)}` : ""}{r.decisionReason ? ` · reason ${r.decisionReason.toLowerCase().replace(/_/g, " ")}` : ""}</p>
      <ul className="mt-1 text-[12px]" aria-label="Documents">
        {r.documents.map((d) => <li key={d.id}>{d.title}: {DOC_TEXT[d.status]}{d.decidedVia === "PROXY" ? " (by a family member)" : ""}</li>)}
      </ul>
      {r.status === "QUERY" && (
        <div className="mt-2 rounded-md border border-amber/40 bg-amber/5 p-2">
          <p className="text-[11.5px] text-text-secondary">The insurer&apos;s question, as received:</p>
          <p className="text-[12.5px]" aria-label="Insurer's question">{r.queryText}</p>
          <AnswerQuery r={r} onDone={load} />
        </div>
      )}
    </li>
  );

  return (
    <div className="mx-auto max-w-5xl" aria-label="Cashless desk">
      <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight"><BadgeIndianRupee size={18} /> Cashless</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        Pre-authorisation through the claims exchange (a mock until NHCX is connected). Nothing is sent until the patient approves the documents.
      </p>
      {error ? <p className="mt-4 text-[13px] text-amber">{error}</p> : !data ? <p className="mt-4 text-[13px] text-text-secondary">Loading…</p> : (
        <>
          <Card className="mt-4">
            <CardLabel>Admitted with insurance</CardLabel>
            {data.candidates.length === 0 ? <p className="mt-2 text-[12.5px] text-text-secondary">No admitted patient with verified insurance is waiting for a request.</p> : (
              <ul className="mt-2 space-y-2">
                {data.candidates.map((c) => (
                  <li key={c.encounterId} aria-label={`${c.patient.name}, ${c.diagnosis ?? "admission"}`} className="text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span>{c.patient.name} <span className="text-text-secondary">· {c.patient.uhid}</span></span>
                      <button onClick={() => setStarting(starting === c.encounterId ? null : c.encounterId)} className="rounded-md border border-hairline px-2 py-0.5 text-[12px]">{starting === c.encounterId ? "Close" : "Start cashless"}</button>
                    </div>
                    {starting === c.encounterId && <StartRequest c={c} onDone={() => { setStarting(null); load(); }} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="mt-4">
            <CardLabel>{data.open.length} open</CardLabel>
            {data.open.length === 0 ? <p className="mt-2 text-[12.5px] text-text-secondary">Nothing open.</p> : <ul className="mt-2 space-y-2">{data.open.map(row)}</ul>}
          </Card>
          <Card className="mt-4">
            <CardLabel>Decided</CardLabel>
            {data.decided.length === 0 ? <p className="mt-2 text-[12.5px] text-text-secondary">None yet.</p> : <ul className="mt-2 space-y-2">{data.decided.map(row)}</ul>}
          </Card>
        </>
      )}
    </div>
  );
}
