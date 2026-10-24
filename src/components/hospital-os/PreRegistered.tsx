"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";

/**
 * Week 5c — the desk's pre-registered patients (pre-arrival check-in): the
 * token, the visit, eligibility (never waited for), and the next step:
 * mark READY (straight to the doctor) or NEEDS_DESK, verify the card
 * through its card share, and mark the patient arrived.
 */
interface Row { id: string; token: string; status: string; kind: string; patientName: string; uhid: string; at: string | null; doctor: string | null; eligibility: string; hasCard: boolean; hasShare: boolean; needsDeskReason: string | null }
interface CardView { payerId: string | null; payerName: string; payerTypeLabel: string; scheme: string | null; memberId: string; policyNumber: string | null; validTo: string | null }
const ELIG: Record<string, string> = { SELF_PAY: "Self-pay", PENDING: "Eligibility pending", VERIFIED: "Card verified", NOT_VERIFIED: "Card not verified" };

export function PreRegistered() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [card, setCard] = useState<{ id: string; view: CardView } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [payers, setPayers] = useState<{ id: string; name: string; type: string }[]>([]);
  const [payerId, setPayerId] = useState("");
  useEffect(() => {
    fetch("/api/hospital/insurance/payers").then((r) => (r.ok ? r.json() : { payers: [] })).then((d) => setPayers((d.payers ?? []).filter((p: { type: string }) => p.type !== "CASH"))).catch(() => setPayers([]));
  }, []);
  const load = useCallback(() => {
    fetch("/api/hospital/checkins").then((r) => (r.ok ? r.json() : null)).then((d) => setRows(d?.checkIns ?? [])).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  async function act(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/api/hospital/checkins/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? null : d.error ?? "That didn't go through.");
    if (r.ok) { setCard(null); load(); }
  }
  async function openCard(id: string) {
    const r = await fetch(`/api/hospital/checkins/${id}/card`);
    if (r.ok) { const view = (await r.json()) as CardView; setCard({ id, view }); setPayerId(view.payerId ?? payers.find((p) => p.name === view.payerName)?.id ?? ""); } else setMsg("The card can't be opened.");
  }
  return (
    <Card>
      <CardLabel>Pre-registered today</CardLabel>
      {rows === null ? <p className="mt-2 text-xs text-text-tertiary">Loading…</p> : rows.length === 0 ? <p className="mt-2 text-xs text-text-tertiary">Nobody has checked in ahead yet.</p> : (
        <ul className="mt-3 space-y-2" aria-label="Pre-registered">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-hairline px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary"><span className="font-mono">{r.token}</span> · {r.patientName} · {r.uhid}</p>
                  <p className="text-[11px] text-text-secondary">{r.kind === "ADMISSION" ? "Planned admission" : `${r.doctor ?? ""} · ${r.at ? new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`} · {ELIG[r.eligibility]}{r.hasShare ? " · record shared" : ""}{r.needsDeskReason ? ` · ${r.needsDeskReason.toLowerCase().replaceAll("_", " ")}` : ""}</p>
                </div>
                <StatusPill tone={r.status === "READY" ? "emerald" : r.status === "NEEDS_DESK" ? "amber" : r.status === "ARRIVED" ? "cyan" : "neutral"} label={r.status === "SUBMITTED" ? "PRE-REGISTERED" : r.status} />
              </div>
              {["SUBMITTED", "READY", "NEEDS_DESK"].includes(r.status) && (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {r.status !== "READY" && <button onClick={() => act(r.id, { action: "READY" })} className="rounded-full border border-emerald/40 px-2.5 py-1 text-emerald">Ready</button>}
                  {r.status !== "NEEDS_DESK" && <button onClick={() => act(r.id, { action: "NEEDS_DESK", reason: "DETAILS_MISMATCH" })} className="rounded-full border border-amber/40 px-2.5 py-1 text-amber">Needs the desk</button>}
                  {r.hasCard && r.eligibility === "PENDING" && <button onClick={() => openCard(r.id)} className="rounded-full border border-hairline px-2.5 py-1">Check the card</button>}
                  <button onClick={() => act(r.id, { action: "ARRIVED" })} className="rounded-full border border-cyan/40 px-2.5 py-1 text-cyan">Arrived</button>
                </div>
              )}
              {card?.id === r.id && (
                <div className="mt-2 rounded-lg border border-hairline p-2 text-[12px]" aria-label="Card">
                  <p>{card.view.payerName} · {card.view.payerTypeLabel} · member {card.view.memberId}{card.view.policyNumber ? ` · policy ${card.view.policyNumber}` : ""}{card.view.validTo ? ` · valid until ${card.view.validTo}` : ""}</p>
                  <select aria-label="Payer" value={payerId} onChange={(e) => setPayerId(e.target.value)} className="mt-1 rounded-md border border-hairline bg-transparent px-2 py-1">
                    <option value="">Which payer is this card with?</option>
                    {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="mt-1 flex gap-2">
                    <button disabled={!payerId} onClick={() => act(r.id, { action: "VERIFY_CARD", outcome: "VERIFIED", payerId })} className="rounded-full border border-emerald/40 px-2.5 py-1 text-emerald disabled:opacity-50">Verified</button>
                    <button onClick={() => act(r.id, { action: "VERIFY_CARD", outcome: "NOT_VERIFIED" })} className="rounded-full border border-red/40 px-2.5 py-1 text-red">Couldn&apos;t verify</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="mt-2 text-[11px] text-amber" role="status">{msg}</p>}
    </Card>
  );
}
