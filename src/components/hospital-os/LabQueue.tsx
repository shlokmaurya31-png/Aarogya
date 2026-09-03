"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { SectionCard, Row, ActionButton, type PatientRef } from "@/components/hospital-os/diagnostics/shared";

interface LabOrderRef { id: string; testName: string; catalogTestId: string | null }
interface SpecimenRow { id: string; accessionNumber: string; specimenType: string; status: string; ageMinutes: number | null; labOrder: LabOrderRef & { patient: PatientRef } }
interface ResultRow { id: string; value: string; unit: string | null; isCritical: boolean; abnormalFlag: string | null; ageMinutes: number | null; labOrder: LabOrderRef & { patient: PatientRef } }

interface Worklist {
  pendingCollection: SpecimenRow[];
  pendingReceipt: SpecimenRow[];
  pendingAcceptance: SpecimenRow[];
  rejectedAwaitingRecollection: SpecimenRow[];
  pendingResult: SpecimenRow[];
  pendingVerification: ResultRow[];
  criticalResults: ResultRow[];
}

const REJECTION_REASONS = ["INSUFFICIENT_SPECIMEN", "WRONG_CONTAINER", "HEMOLYZED", "MISLABELED", "LEAKED", "EXPIRED_TRANSPORT", "INCORRECT_SPECIMEN_TYPE", "OTHER"];

export function LabQueue() {
  const push = useToastStore((s) => s.push);
  const [worklist, setWorklist] = useState<Worklist | null>(null);
  const [resultForm, setResultForm] = useState<{ labOrderId: string; catalogTestId: string | null } | null>(null);
  const [rejectForm, setRejectForm] = useState<string | null>(null);
  const [amendLabOrderId, setAmendLabOrderId] = useState("");
  const [amendResultId, setAmendResultId] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [isCritical, setIsCritical] = useState(false);
  const [rejectReason, setRejectReason] = useState(REJECTION_REASONS[0]);
  const [rejectNotes, setRejectNotes] = useState("");
  const [amendReason, setAmendReason] = useState("");

  function load() {
    fetch("/api/hospital/orders/lab/worklist").then((r) => r.json()).then(setWorklist);
  }
  useEffect(load, []);

  async function call(url: string, body?: object) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { push(json.error ?? "Action failed.", "red"); return false; }
    return true;
  }

  async function collect(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/specimen/collect`)) { push("Specimen collected.", "emerald"); load(); }
  }
  async function receive(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/specimen/receive`)) { push("Specimen received.", "emerald"); load(); }
  }
  async function accept(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/specimen/accept`)) { push("Specimen accepted.", "emerald"); load(); }
  }
  async function recollect(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/specimen/recollect`)) { push("Recollection specimen created.", "emerald"); load(); }
  }
  async function submitReject(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/specimen/reject`, { reason: rejectReason, notes: rejectNotes })) {
      push("Specimen rejected.", "amber"); setRejectForm(null); setRejectNotes(""); load();
    }
  }
  async function submitResult(labOrderId: string, catalogTestId: string | null) {
    if (!value.trim()) return;
    const numeric = Number(value);
    if (await call(`/api/hospital/orders/lab/${labOrderId}/result`, { value, unit, isCritical, catalogTestId, resultType: catalogTestId ? "NUMERIC" : undefined, numericValue: catalogTestId && !Number.isNaN(numeric) ? numeric : undefined })) {
      push("Result entered.", "emerald"); setResultForm(null); setValue(""); setUnit(""); setIsCritical(false); load();
    }
  }
  async function verify(labOrderId: string, resultId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/result/${resultId}/verify`)) { push("Result verified.", "emerald"); load(); }
  }
  async function submitAmend() {
    if (!amendLabOrderId.trim() || !amendResultId.trim() || !value.trim() || !amendReason.trim()) return;
    if (await call(`/api/hospital/orders/lab/${amendLabOrderId}/result/${amendResultId}/amend`, { value, unit, reason: amendReason })) {
      push("Result amended — previous version preserved.", "emerald"); setAmendLabOrderId(""); setAmendResultId(""); setValue(""); setAmendReason(""); load();
    }
  }
  async function acknowledge(labOrderId: string) {
    if (await call(`/api/hospital/orders/lab/${labOrderId}/acknowledge`)) { push("Critical result acknowledged.", "emerald"); load(); }
  }

  if (!worklist) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const totalPending =
    worklist.pendingCollection.length + worklist.pendingReceipt.length + worklist.pendingAcceptance.length +
    worklist.rejectedAwaitingRecollection.length + worklist.pendingResult.length + worklist.pendingVerification.length + worklist.criticalResults.length;

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <ToastViewport />
      <div className="flex items-center gap-2"><FlaskConical size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Lab Worklist</h1></div>
      <p className="text-[13px] text-text-secondary">{totalPending} items across the specimen and result pipeline.</p>

      <SectionCard title="Critical results — unacknowledged" count={worklist.criticalResults.length}>
        {worklist.criticalResults.map((r) => (
          <Row key={r.id} patient={r.labOrder.patient} title={r.labOrder.testName} meta={`${r.value} ${r.unit ?? ""}${r.abnormalFlag ? ` · ${r.abnormalFlag.replace("_", " ")}` : ""}`} ageMinutes={r.ageMinutes}>
            <ActionButton label="Acknowledge" tone="red" onClick={() => acknowledge(r.labOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Rejected — awaiting recollection" count={worklist.rejectedAwaitingRecollection.length}>
        {worklist.rejectedAwaitingRecollection.map((s) => (
          <Row key={s.id} patient={s.labOrder.patient} title={s.labOrder.testName} meta={`${s.accessionNumber} · ${s.specimenType}`} ageMinutes={s.ageMinutes}>
            <ActionButton label="Recollect" onClick={() => recollect(s.labOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Pending collection" count={worklist.pendingCollection.length}>
        {worklist.pendingCollection.map((s) => (
          <Row key={s.id} patient={s.labOrder.patient} title={s.labOrder.testName} meta={`${s.accessionNumber} · ${s.specimenType}`} ageMinutes={s.ageMinutes}>
            <ActionButton label="Collect" tone="emerald" onClick={() => collect(s.labOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Pending receipt" count={worklist.pendingReceipt.length}>
        {worklist.pendingReceipt.map((s) => (
          <div key={s.id}>
            <Row patient={s.labOrder.patient} title={s.labOrder.testName} meta={`${s.accessionNumber} · ${s.specimenType}`} ageMinutes={s.ageMinutes}>
              <ActionButton label="Receive" tone="emerald" onClick={() => receive(s.labOrder.id)} />
              <ActionButton label="Reject" tone="red" onClick={() => setRejectForm(rejectForm === s.id ? null : s.id)} />
            </Row>
            {rejectForm === s.id && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2.5">
                <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[11.5px]">
                  {REJECTION_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </select>
                <input value={rejectNotes} onChange={(e) => setRejectNotes(e.target.value)} placeholder="Notes (optional)" className="min-w-[160px] flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[11.5px]" />
                <ActionButton label="Confirm rejection" tone="red" onClick={() => submitReject(s.labOrder.id)} />
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Pending acceptance" count={worklist.pendingAcceptance.length}>
        {worklist.pendingAcceptance.map((s) => (
          <div key={s.id}>
            <Row patient={s.labOrder.patient} title={s.labOrder.testName} meta={`${s.accessionNumber} · ${s.specimenType}`} ageMinutes={s.ageMinutes}>
              <ActionButton label="Accept" tone="emerald" onClick={() => accept(s.labOrder.id)} />
              <ActionButton label="Reject" tone="red" onClick={() => setRejectForm(rejectForm === s.id ? null : s.id)} />
            </Row>
            {rejectForm === s.id && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2.5">
                <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[11.5px]">
                  {REJECTION_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </select>
                <input value={rejectNotes} onChange={(e) => setRejectNotes(e.target.value)} placeholder="Notes (optional)" className="min-w-[160px] flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[11.5px]" />
                <ActionButton label="Confirm rejection" tone="red" onClick={() => submitReject(s.labOrder.id)} />
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Pending result entry" count={worklist.pendingResult.length}>
        {worklist.pendingResult.map((s) => (
          <div key={s.id}>
            <Row patient={s.labOrder.patient} title={s.labOrder.testName} meta={`${s.accessionNumber} · ${s.specimenType}`} ageMinutes={s.ageMinutes}>
              <ActionButton label="Enter result" onClick={() => setResultForm(resultForm?.labOrderId === s.labOrder.id ? null : { labOrderId: s.labOrder.id, catalogTestId: s.labOrder.catalogTestId })} />
            </Row>
            {resultForm?.labOrderId === s.labOrder.id && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2.5">
                <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" className="w-28 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" className="w-24 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
                <label className="flex items-center gap-1.5 text-[11.5px] text-red"><input type="checkbox" checked={isCritical} onChange={(e) => setIsCritical(e.target.checked)} /> Critical</label>
                <ActionButton label="Release result" tone="emerald" onClick={() => submitResult(s.labOrder.id, resultForm.catalogTestId)} />
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Pending verification" count={worklist.pendingVerification.length}>
        {worklist.pendingVerification.map((r) => (
          <div key={r.id}>
            <Row patient={r.labOrder.patient} title={r.labOrder.testName} meta={`${r.value} ${r.unit ?? ""}`} ageMinutes={r.ageMinutes}>
              <ActionButton label="Verify" tone="emerald" onClick={() => verify(r.labOrder.id, r.id)} />
            </Row>
          </div>
        ))}
      </SectionCard>

      <Card className="rounded-[20px]">
        <p className="text-[13px] font-semibold">Amend a verified result</p>
        <p className="mt-1 text-[11px] text-text-tertiary">Paste the lab order and result IDs from the Patient Chart to correct it — the previous verified version is preserved, never overwritten.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={amendLabOrderId} onChange={(e) => setAmendLabOrderId(e.target.value)} placeholder="Lab order ID" className="w-36 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <input value={amendResultId} onChange={(e) => setAmendResultId(e.target.value)} placeholder="Result ID" className="w-36 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Corrected value" className="w-28 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} placeholder="Amendment reason" className="min-w-[160px] flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <ActionButton label="Submit amendment" tone="emerald" onClick={submitAmend} />
        </div>
      </Card>

      {totalPending === 0 && <p className="text-[13px] text-text-tertiary">Worklist is clear.</p>}
    </div>
  );
}
