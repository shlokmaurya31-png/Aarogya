"use client";

import { useEffect, useState } from "react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill, rupees } from "@/components/patient-portal/ui";

/**
 * Insurance (Phase D11; Week 5c): your insurance cards; for each visit the
 * pre-authorization, cashless at discharge, the itemised bill, your share
 * (paid to the hospital's own payment account) and the claim from submitted
 * to settled; documents the hospital asked for. Only decided values: never a
 * prediction. The hospital's own coverage records are listed below.
 */
interface CardDto { id: string; payerTypeLabel: string; scheme: string | null; payerName: string; planName: string | null; memberIdMasked: string | null; validTo: string | null; hasFront: boolean }
interface Share { known: boolean; insurerMinor: number | null; shareMinor: number | null; paidByYouMinor: number; dueMinor: number; text: string }
interface Bill {
  invoiceId: string; invoiceNumber: string | null; statusLabel: string; totalMinor: number; payer: string; lines: { description: string; quantity: number; amountMinor: number }[];
  share: Share; payable: boolean;
  claim: { claimNumber: string | null; status: string; text: string; steps: { key: string; label: string; done: boolean }[]; approvedAmountMinor: number | null; settledAmountMinor: number | null; settledAt: string | null } | null;
  documentRequests: { id: string; description: string; status: string }[];
}
interface Visit { encounterId: string; facility: string; kind: string; at: string; preAuth: { text: string; insurer: string; approvedAmountMinor: number | null } | null; cashless: { stage: string; text: string; approvedUptoMinor?: number | null } | null; bills: Bill[] }
interface Coverage { id: string; payer: string; plan: string | null; memberIdMasked: string; statusLabel: string; validFrom: string; validTo: string | null; isPrimary: boolean }

async function call(url: string, body?: unknown, method = "POST") {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  const data = await r?.json().catch(() => null);
  return r?.ok ? { ok: true as const, data } : { ok: false as const, error: (data?.error as string) ?? "That didn't go through. Try again." };
}

function AddCard({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ payerType: "PRIVATE_INSURER", scheme: "PM_JAY", payerName: "", planName: "", memberId: "", policyNumber: "", validTo: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const r = await call("/api/patient/insurance/cards", { ...f, scheme: f.payerType === "GOVERNMENT_SCHEME" ? f.scheme : undefined, payerName: f.payerName || undefined, planName: f.planName || undefined, policyNumber: f.policyNumber || undefined, validTo: f.validTo || undefined });
    if (r.ok) onDone(); else setMsg(r.error);
  }
  const input = "w-full rounded-md border border-hairline bg-surface px-3 py-2 text-[13px]";
  return (
    <div role="region" aria-label="Add a card" className="mt-3 space-y-2 rounded-xl border border-hairline p-3">
      <select aria-label="Type" value={f.payerType} onChange={(e) => setF({ ...f, payerType: e.target.value })} className={input}>
        <option value="PRIVATE_INSURER">Health insurance</option><option value="CORPORATE">Employer (corporate) cover</option><option value="GOVERNMENT_SCHEME">Government scheme</option>
      </select>
      {f.payerType === "GOVERNMENT_SCHEME" && (
        <select aria-label="Scheme" value={f.scheme} onChange={(e) => setF({ ...f, scheme: e.target.value })} className={input}>
          <option value="PM_JAY">Ayushman Bharat PM-JAY</option><option value="CGHS">CGHS</option><option value="ESIC">ESIC</option><option value="STATE_SCHEME">State health scheme</option>
        </select>
      )}
      <input aria-label="Insurer" placeholder={f.payerType === "GOVERNMENT_SCHEME" ? "Scheme name (optional)" : "Insurer or TPA"} value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} className={input} />
      <input aria-label="Plan" placeholder="Plan (optional)" value={f.planName} onChange={(e) => setF({ ...f, planName: e.target.value })} className={input} />
      <input aria-label="Member number" placeholder="Member / card number" value={f.memberId} onChange={(e) => setF({ ...f, memberId: e.target.value })} className={input} />
      <input aria-label="Policy number" placeholder="Policy number (optional)" value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value })} className={input} />
      <label className="flex items-center gap-2 text-[12.5px]">Valid until <input aria-label="Valid until" type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} className="rounded-md border border-hairline bg-surface px-2 py-1" /></label>
      <p className="text-[11px] text-text-tertiary">Numbers are stored encrypted and shown only as the last 4 digits. The hospital sees your card only for a visit you check in for.</p>
      {msg && <p className="text-[12px] text-red">{msg}</p>}
      <button onClick={save} disabled={!f.memberId} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50">Save card</button>
    </div>
  );
}

function PayShare({ bill, onPaid }: { bill: Bill; onPaid: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  useEffect(() => {
    if (!orderId) return;
    const t = setInterval(async () => {
      const r = await call(`/api/patient/insurance/orders/${orderId}`, undefined, "GET");
      if (r.ok && r.data.status === "PAID") { clearInterval(t); onPaid(); }
      if (r.ok && r.data.status === "FAILED") { clearInterval(t); setMsg("The payment didn't go through. You can try again."); setOrderId(null); }
    }, 2000);
    return () => clearInterval(t);
  }, [orderId, onPaid]);
  async function pay() {
    const r = await call("/api/patient/insurance/pay", { invoiceId: bill.invoiceId });
    if (!r.ok) return setMsg(r.error);
    if (r.data.status === "PROVIDER_NOT_CONFIGURED") return setMsg("This hospital doesn't take payments in the app yet. Please pay at the hospital.");
    setOrderId(r.data.orderId);
    const w = window as unknown as { Razorpay?: new (o: Record<string, unknown>) => { open(): void } };
    if (String(r.data.providerOrderRef).startsWith("order_stub")) return setMsg(`Test payment started (${rupees(r.data.amountMinor)}). Waiting for the hospital's payment account to confirm it.`);
    const open = () => new w.Razorpay!({ key: r.data.keyId, order_id: r.data.providerOrderRef, amount: r.data.amountMinor, currency: r.data.currency, name: "Hospital bill", description: "Your share" }).open();
    if (w.Razorpay) open();
    else {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = open;
      document.body.appendChild(s);
    }
    setMsg("Complete the payment in the window. It counts once the hospital's payment account confirms it.");
  }
  return (
    <div className="mt-2">
      <button onClick={pay} disabled={!!orderId} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50">Pay your share {rupees(bill.share.dueMinor)}</button>
      {msg && <p className="mt-1 text-[12px] text-text-secondary" role="status">{msg}</p>}
    </div>
  );
}

function AttachDocuments({ requestId, onDone }: { requestId: string; onDone: () => void }) {
  const docs = usePatientData<{ documents: { id: string; title: string; type: string }[] }>("/api/patient/person/documents");
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function send() {
    const r = await call(`/api/patient/insurance/claim-documents/${requestId}`, { documentIds: picked, confirmSensitive });
    if (r.ok) onDone(); else setMsg(r.error);
  }
  return (
    <div className="mt-1 space-y-1">
      {docs.state.status === "ok" && docs.state.data.documents.filter((d) => d.type !== "ID_PROOF").map((d) => (
        <label key={d.id} className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} /> {d.title}</label>
      ))}
      {msg && <p className="text-[12px] text-amber">{msg}</p>}
      {msg?.includes("sensitive") && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={confirmSensitive} onChange={(e) => setConfirmSensitive(e.target.checked)} /> Yes, share it with the hospital for this claim</label>}
      <button onClick={send} disabled={!picked.length} className="rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">Send to the hospital</button>
    </div>
  );
}

function BillCard({ bill, reload }: { bill: Bill; reload: () => void }) {
  const [paid, setPaid] = useState(false);
  return (
    <div role="region" aria-label={`Bill ${bill.invoiceNumber ?? ""}`.trim()} className="mt-3 rounded-xl border border-hairline p-3">
      <div className="flex items-center justify-between text-[13px]"><span className="font-medium">Bill {bill.invoiceNumber ?? ""}</span><StatusPill label={bill.statusLabel} /></div>
      <table className="mt-2 w-full text-[12.5px]" aria-label="Itemised bill">
        <tbody>
          {bill.lines.map((l, i) => <tr key={i}><td className="py-0.5">{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ""}</td><td className="text-right">{rupees(l.amountMinor)}</td></tr>)}
          <tr className="border-t border-hairline font-medium"><td className="pt-1">Total</td><td className="pt-1 text-right">{rupees(bill.totalMinor)}</td></tr>
        </tbody>
      </table>
      <div className="mt-2 text-[13px]" aria-label="Your share">
        {bill.share.known ? (
          <>
            {bill.share.insurerMinor ? <p>Your insurer covers {rupees(bill.share.insurerMinor)}.</p> : null}
            <p className="font-medium">Your share: {rupees(bill.share.shareMinor ?? 0)}{bill.share.paidByYouMinor ? ` (you've paid ${rupees(bill.share.paidByYouMinor)})` : ""}</p>
          </>
        ) : null}
        <p className="text-[12px] text-text-secondary">{bill.share.text}</p>
      </div>
      {bill.payable && <PayShare bill={bill} onPaid={() => { setPaid(true); reload(); }} />}
      {paid && <p className="mt-1 text-[12px] text-emerald" role="status">Paid. The hospital has received your payment.</p>}
      {bill.claim && (
        <div className="mt-3" aria-label="Claim">
          <p className="text-[13px] font-medium">Claim {bill.claim.claimNumber ?? ""}: {bill.claim.text}</p>
          <ol className="mt-1 space-y-0.5 text-[12px]">{bill.claim.steps.map((s) => <li key={s.key} className={s.done ? "text-emerald" : "text-text-tertiary"}>{s.done ? "✓" : "○"} {s.label}</li>)}</ol>
          {bill.claim.settledAmountMinor !== null && bill.claim.settledAt && <p className="mt-1 text-[12px]">Your insurer paid the hospital {rupees(bill.claim.settledAmountMinor)} on {formatDate(bill.claim.settledAt)}.</p>}
        </div>
      )}
      {bill.documentRequests.map((r) => (
        <div key={r.id} className="mt-2 rounded-lg border border-amber/30 bg-amber/5 p-2 text-[12.5px]">
          <p>The hospital needs: {r.description}</p>
          {r.status === "OPEN" ? <AttachDocuments requestId={r.id} onDone={reload} /> : <p className="text-text-tertiary">{r.status === "FULFILLED" ? "Sent to the hospital." : "No longer needed."}</p>}
        </div>
      ))}
    </div>
  );
}

export default function InsurancePage() {
  const cards = usePatientData<{ cards: CardDto[] }>("/api/patient/insurance/cards");
  const status = usePatientData<{ visits: Visit[] }>("/api/patient/insurance/status");
  const legacy = usePatientData<{ coverages: Coverage[] }>("/api/patient/insurance");
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Insurance</h1>
      <Card>
        <div className="flex items-center justify-between"><SectionTitle>Your insurance cards</SectionTitle><button onClick={() => setAdding((v) => !v)} className="rounded-md border border-hairline px-2 py-1 text-[12px]">{adding ? "Close" : "Add a card"}</button></div>
        {cards.state.status === "ok" && cards.state.data.cards.length ? (
          <ul className="space-y-2" aria-label="Cards">{cards.state.data.cards.map((c) => (
            <li key={c.id} className="text-[13px]"><span className="font-medium">{c.payerName}</span> · {c.payerTypeLabel}{c.planName ? ` · ${c.planName}` : ""} · {c.memberIdMasked}{c.validTo ? ` · valid until ${formatDate(c.validTo)}` : ""}</li>
          ))}</ul>
        ) : <Empty>No cards yet.</Empty>}
        {adding && <AddCard onDone={() => { setAdding(false); cards.reload(); }} />}
      </Card>
      <Card>
        <SectionTitle>Visits and bills</SectionTitle>
        {status.state.status === "loading" ? <Empty>Loading…</Empty> : status.state.status === "error" ? <Unavailable label="Bills" /> : status.state.data.visits.length === 0 ? <Empty>No bills yet.</Empty> : (
          <div className="space-y-4">{status.state.data.visits.map((v) => (
            <div key={v.encounterId} role="region" aria-label={`Visit ${formatDate(v.at)}`} className="border-b border-hairline pb-4 last:border-0">
              <p className="text-[14px] font-medium">{v.facility} · {v.kind === "ADMISSION" ? "Admission" : "Visit"} · {formatDate(v.at)}</p>
              {v.preAuth && <p className="text-[13px]">{v.preAuth.text}{v.preAuth.approvedAmountMinor ? ` (up to ${rupees(v.preAuth.approvedAmountMinor)})` : ""}.</p>}
              {v.cashless && <p className="text-[13px]" aria-label="Cashless">{v.cashless.text}{v.cashless.approvedUptoMinor ? ` (${rupees(v.cashless.approvedUptoMinor)})` : ""}.</p>}
              {v.bills.map((b) => <BillCard key={b.invoiceId} bill={b} reload={status.reload} />)}
            </div>
          ))}</div>
        )}
      </Card>
      <Card>
        <SectionTitle>Coverage the hospital has on record</SectionTitle>
        {legacy.state.status === "ok" && legacy.state.data.coverages.length ? (
          <ul className="space-y-2">{legacy.state.data.coverages.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-[13px]"><span>{c.payer}{c.plan ? ` · ${c.plan}` : ""} · {c.memberIdMasked}</span><StatusPill label={c.statusLabel} tone="info" /></li>
          ))}</ul>
        ) : <Empty>None yet: the hospital adds it after checking your card.</Empty>}
      </Card>
    </div>
  );
}
