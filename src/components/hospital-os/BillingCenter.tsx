"use client";

import { useEffect, useState, useCallback } from "react";
import { Receipt, Plus, FileText, CreditCard } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { rupeesToMinor, minorToRupees } from "@/lib/hospital/billing/money";

interface EncounterRow { id: string; type: string; chiefComplaint: string | null; patient: { fullName: string; uhid: string } }
interface Charge { id: string; description: string; category: string; chargeCode: string | null; netAmountMinor: number; status: string; createdAt: string }
interface InvoiceLine { id: string; description: string; netAmountMinor: number }
interface Invoice { id: string; invoiceNumber: string | null; status: string; subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; lines: InvoiceLine[] }
interface Summary { grossChargesMinor: number; invoicedMinor: number; paidMinor: number; unappliedCreditMinor: number; outstandingMinor: number }

const INVOICE_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  DRAFT: "neutral", ISSUED: "amber", PARTIALLY_PAID: "cyan", PAID: "emerald", VOID: "red",
};

function money(minor: number) {
  return `₹${minorToRupees(minor).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BillingCenter() {
  const push = useToastStore((s) => s.push);
  const [encounters, setEncounters] = useState<EncounterRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<"charges" | "invoices" | "payments">("charges");

  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("PROCEDURE");
  const [chargeCode, setChargeCode] = useState("");

  const [draftInvoiceId, setDraftInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [allocateInvoiceId, setAllocateInvoiceId] = useState("");

  function load() {
    fetch("/api/hospital/encounters?all=true").then((r) => r.json()).then((d) => setEncounters(d.encounters ?? []));
  }
  useEffect(load, []);

  const openEncounter = useCallback((id: string) => {
    setSelected(id);
    fetch(`/api/hospital/billing/${id}`).then((r) => r.json()).then((d) => {
      setCharges(d.charges ?? []);
      setInvoices(d.invoices ?? []);
      setSummary(d.summary ?? null);
    });
  }, []);

  async function addCharge() {
    if (!selected || !description.trim() || !chargeCode.trim()) { push("description and chargeCode are required.", "amber"); return; }
    const res = await fetch(`/api/hospital/billing/${selected}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, category, chargeCode }),
    });
    const result = await res.json();
    if (!res.ok) { push(result.error ?? "Failed to add charge.", "red"); return; }
    push("Charge added.", "emerald");
    setDescription(""); setChargeCode("");
    openEncounter(selected);
  }

  async function draftInvoice() {
    if (!selected) return;
    const res = await fetch("/api/hospital/invoices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId: selected }),
    });
    const result = await res.json();
    if (!res.ok) { push(result.error ?? "Failed to draft invoice.", "red"); return; }
    push("Draft invoice created — add charges to it below.", "emerald");
    setDraftInvoiceId(result.invoice.id);
    openEncounter(selected);
  }

  async function addChargeToDraft(chargeId: string) {
    if (!draftInvoiceId) { push("Draft an invoice first.", "amber"); return; }
    const res = await fetch(`/api/hospital/invoices/${draftInvoiceId}/lines`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chargeId }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to add line.", "red"); return; }
    if (selected) openEncounter(selected);
  }

  async function issueDraft() {
    if (!draftInvoiceId) return;
    const res = await fetch(`/api/hospital/invoices/${draftInvoiceId}/issue`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const result = await res.json();
    if (!res.ok) { push(result.error ?? "Failed to issue invoice.", "red"); return; }
    push(`Invoice ${result.invoice.invoiceNumber} issued.`, "emerald");
    setDraftInvoiceId(null);
    if (selected) openEncounter(selected);
  }

  async function recordPayment() {
    if (!selected || !paymentAmount) return;
    const idempotencyKey = `ui-${selected}-${Date.now()}`;
    const res = await fetch("/api/hospital/payments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId: selected, amountMinor: rupeesToMinor(Number(paymentAmount)), method: paymentMethod, idempotencyKey }),
    });
    const result = await res.json();
    if (!res.ok) { push(result.error ?? "Failed to record payment.", "red"); return; }
    if (allocateInvoiceId) {
      await fetch(`/api/hospital/payments/${result.payment.id}/allocate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: allocateInvoiceId, amountMinor: rupeesToMinor(Number(paymentAmount)) }),
      });
    }
    push("Payment recorded.", "emerald");
    setPaymentAmount("");
    openEncounter(selected);
  }

  if (!encounters) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />
      <div className="flex items-center gap-2"><Receipt size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Billing</h1></div>
      <p className="mt-1 text-[13px] text-text-secondary">Charge capture, invoicing, and payments — every amount server-priced and traceable to its clinical source.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="rounded-[20px]">
          <CardLabel>Encounters</CardLabel>
          <div className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto">
            {encounters.map((e) => (
              <button key={e.id} onClick={() => openEncounter(e.id)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left ${selected === e.id ? "border-cyan/40 bg-cyan/[0.04]" : "border-hairline"}`}>
                <div>
                  <p className="text-[13px] font-medium">{e.patient.fullName}</p>
                  <p className="text-[11px] text-text-tertiary">{e.patient.uhid} · {e.type} · {e.chiefComplaint}</p>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {!selected ? (
          <Card className="rounded-[20px]"><p className="text-[12.5px] text-text-tertiary">Select an encounter to view its billing account.</p></Card>
        ) : (
          <div className="space-y-4">
            {summary && (
              <Card className="rounded-[20px]">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div><CardLabel>Gross charges</CardLabel><p className="mt-1 text-[15px] font-semibold tabular-nums">{money(summary.grossChargesMinor)}</p></div>
                  <div><CardLabel>Invoiced</CardLabel><p className="mt-1 text-[15px] font-semibold tabular-nums">{money(summary.invoicedMinor)}</p></div>
                  <div><CardLabel>Paid</CardLabel><p className="mt-1 text-[15px] font-semibold tabular-nums">{money(summary.paidMinor)}</p></div>
                  <div><CardLabel>Unapplied credit</CardLabel><p className="mt-1 text-[15px] font-semibold tabular-nums">{money(summary.unappliedCreditMinor)}</p></div>
                  <div><CardLabel>Outstanding</CardLabel><p className="mt-1 text-[15px] font-semibold tabular-nums text-cyan">{money(summary.outstandingMinor)}</p></div>
                </div>
              </Card>
            )}

            <div className="flex gap-1 rounded-lg border border-hairline p-1 text-[12px]">
              {(["charges", "invoices", "payments"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 capitalize ${tab === t ? "bg-cyan/10 text-cyan" : "text-text-tertiary"}`}>{t}</button>
              ))}
            </div>

            {tab === "charges" && (
              <Card className="rounded-[20px]">
                <CardLabel>Charges</CardLabel>
                <div className="mt-3 space-y-2">
                  {charges.map((c) => (
                    <div key={c.id} className="flex items-center justify-between text-[12px]">
                      <span>{c.description} <span className="text-text-tertiary">({c.category}{c.chargeCode ? ` · ${c.chargeCode}` : ""})</span></span>
                      <div className="flex items-center gap-2">
                        <StatusPill label={c.status} tone={c.status === "VOIDED" ? "red" : "neutral"} className="rounded-md" />
                        <span className="tabular-nums">{money(c.netAmountMinor)}</span>
                        {draftInvoiceId && c.status === "POSTED" && (
                          <button onClick={() => addChargeToDraft(c.id)} className="text-cyan hover:underline">+ to draft</button>
                        )}
                      </div>
                    </div>
                  ))}
                  {charges.length === 0 && <p className="text-[12px] text-text-tertiary">No charges yet.</p>}
                </div>
                <div className="mt-4 space-y-2 border-t border-hairline pt-3">
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                  <div className="flex gap-2">
                    <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40">
                      {["CONSULTATION", "BED", "PROCEDURE", "LAB", "IMAGING", "PHARMACY", "NURSING", "PACKAGE", "OTHER"].map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input value={chargeCode} onChange={(e) => setChargeCode(e.target.value)} placeholder="Charge code (e.g. CONSULT_OPD)" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                  </div>
                  <button onClick={addCharge} className="flex items-center gap-1.5 rounded-md bg-cyan px-3 py-1.5 text-[12px] font-medium text-ink hover:brightness-110"><Plus size={12} /> Add charge (server-priced)</button>
                </div>
              </Card>
            )}

            {tab === "invoices" && (
              <Card className="rounded-[20px]">
                <div className="flex items-center justify-between">
                  <CardLabel>Invoices</CardLabel>
                  {!draftInvoiceId && <button onClick={draftInvoice} className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] hover:border-cyan/40"><FileText size={12} /> Draft invoice</button>}
                </div>
                {draftInvoiceId && (
                  <div className="mt-2 rounded-md border border-cyan/30 bg-cyan/[0.04] px-3 py-2 text-[12px]">
                    Draft invoice open — use &ldquo;+ to draft&rdquo; on the Charges tab, then
                    <button onClick={issueDraft} className="ml-2 rounded-md bg-cyan px-2 py-1 text-[11.5px] font-medium text-ink hover:brightness-110">Issue</button>
                  </div>
                )}
                <div className="mt-3 space-y-3">
                  {invoices.map((inv) => (
                    <div key={inv.id} className="rounded-md border border-hairline p-2.5 text-[12px]">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{inv.invoiceNumber ?? "DRAFT"}</span>
                        <StatusPill label={inv.status} tone={INVOICE_TONE[inv.status] ?? "neutral"} className="rounded-md" />
                      </div>
                      <div className="mt-1 flex justify-between text-text-tertiary">
                        <span>{inv.lines.length} line(s)</span>
                        <span className="tabular-nums font-medium text-ink">{money(inv.totalMinor)}</span>
                      </div>
                    </div>
                  ))}
                  {invoices.length === 0 && <p className="text-[12px] text-text-tertiary">No invoices yet.</p>}
                </div>
              </Card>
            )}

            {tab === "payments" && (
              <Card className="rounded-[20px]">
                <CardLabel>Record a payment</CardLabel>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="Amount (₹)" type="number" className="w-32 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40">
                    {["CASH", "CARD", "UPI", "NETBANKING", "CHEQUE", "INSURANCE_SETTLEMENT"].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select value={allocateInvoiceId} onChange={(e) => setAllocateInvoiceId(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40">
                    <option value="">Unallocated (deposit)</option>
                    {invoices.filter((i) => i.status === "ISSUED" || i.status === "PARTIALLY_PAID").map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber}</option>)}
                  </select>
                  <button onClick={recordPayment} className="flex items-center gap-1.5 rounded-md bg-cyan px-3 py-1.5 text-[12px] font-medium text-ink hover:brightness-110"><CreditCard size={12} /> Record payment</button>
                </div>
                <p className="mt-2 text-[11px] text-text-tertiary">Leaving the invoice unselected records the payment as an unapplied deposit/advance — allocate it to an invoice later.</p>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
