"use client";

import { useEffect, useState } from "react";
import { ScanLine } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { SectionCard, Row, ActionButton, type PatientRef } from "@/components/hospital-os/diagnostics/shared";

interface ImagingOrderRef { id: string; modality: string; studyDescription: string }
interface OrderRow extends ImagingOrderRef { ageMinutes: number | null; patient: PatientRef }
interface StudyRow { id: string; modality: string; accessionNumber: string; status: string; ageMinutes: number | null; imagingOrder: ImagingOrderRef & { patient: PatientRef } }
interface ReportRow { id: string; impression: string; isCritical: boolean; ageMinutes: number | null; imagingOrder: ImagingOrderRef & { patient: PatientRef } }
interface Resource { id: string; name: string; modality: string }

interface Worklist {
  pendingScheduling: OrderRow[];
  scheduledAwaitingArrival: StudyRow[];
  readyForImaging: StudyRow[];
  inProgress: StudyRow[];
  pendingReport: OrderRow[];
  pendingVerification: ReportRow[];
  criticalFindings: ReportRow[];
}

export function RadiologyQueue() {
  const push = useToastStore((s) => s.push);
  const [worklist, setWorklist] = useState<Worklist | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [scheduleForm, setScheduleForm] = useState<string | null>(null);
  const [resourceId, setResourceId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [reportForm, setReportForm] = useState<string | null>(null);
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [indication, setIndication] = useState("");
  const [isCritical, setIsCritical] = useState(false);
  const [amendOrderId, setAmendOrderId] = useState("");
  const [amendReportId, setAmendReportId] = useState("");
  const [amendFindings, setAmendFindings] = useState("");
  const [amendImpression, setAmendImpression] = useState("");
  const [amendReason, setAmendReason] = useState("");

  function load() {
    fetch("/api/hospital/orders/imaging/worklist").then((r) => r.json()).then(setWorklist);
    fetch("/api/hospital/imaging-resources").then((r) => r.json()).then((d) => setResources(d.resources ?? []));
  }
  useEffect(load, []);

  async function call(url: string, body?: object) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { push(json.error ?? "Action failed.", "red"); return false; }
    return true;
  }

  async function submitSchedule(orderId: string) {
    if (!scheduledAt) return;
    if (await call(`/api/hospital/orders/imaging/${orderId}/study/schedule`, { resourceId: resourceId || undefined, scheduledAt: new Date(scheduledAt).toISOString() })) {
      push("Study scheduled.", "emerald"); setScheduleForm(null); setScheduledAt(""); setResourceId(""); load();
    }
  }
  async function checkin(orderId: string) {
    if (await call(`/api/hospital/orders/imaging/${orderId}/study/checkin`)) { push("Patient checked in.", "emerald"); load(); }
  }
  async function start(orderId: string) {
    if (await call(`/api/hospital/orders/imaging/${orderId}/study/start`, { preparationCompleted: true })) { push("Study started.", "emerald"); load(); }
  }
  async function complete(orderId: string) {
    if (await call(`/api/hospital/orders/imaging/${orderId}/study/complete`)) { push("Study completed.", "emerald"); load(); }
  }
  async function submitReport(orderId: string) {
    if (!findings.trim() || !impression.trim()) return;
    if (await call(`/api/hospital/orders/imaging/${orderId}/report`, { indication, findings, impression, isCritical })) {
      push("Report entered.", "emerald"); setReportForm(null); setFindings(""); setImpression(""); setIndication(""); setIsCritical(false); load();
    }
  }
  async function verify(orderId: string, reportId: string) {
    if (await call(`/api/hospital/orders/imaging/${orderId}/report/${reportId}/verify`)) { push("Report verified.", "emerald"); load(); }
  }
  async function acknowledge(orderId: string, reportId: string) {
    if (await call(`/api/hospital/orders/imaging/${orderId}/report/${reportId}/acknowledge`)) { push("Critical finding acknowledged.", "emerald"); load(); }
  }
  async function submitAmend() {
    if (!amendOrderId.trim() || !amendReportId.trim() || !amendFindings.trim() || !amendImpression.trim() || !amendReason.trim()) return;
    if (await call(`/api/hospital/orders/imaging/${amendOrderId}/report/${amendReportId}/amend`, { findings: amendFindings, impression: amendImpression, reason: amendReason })) {
      push("Report amended — previous version preserved.", "emerald");
      setAmendOrderId(""); setAmendReportId(""); setAmendFindings(""); setAmendImpression(""); setAmendReason(""); load();
    }
  }

  if (!worklist) return <div className="mx-auto max-w-4xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const total =
    worklist.pendingScheduling.length + worklist.scheduledAwaitingArrival.length + worklist.readyForImaging.length +
    worklist.inProgress.length + worklist.pendingReport.length + worklist.pendingVerification.length + worklist.criticalFindings.length;

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <ToastViewport />
      <div className="flex items-center gap-2"><ScanLine size={18} className="text-cyan" /><h1 className="text-[20px] font-semibold tracking-tight">Radiology Worklist</h1></div>
      <p className="text-[13px] text-text-secondary">{total} items across the scheduling, execution and reporting pipeline.</p>

      <SectionCard title="Critical findings — unacknowledged" count={worklist.criticalFindings.length}>
        {worklist.criticalFindings.map((r) => (
          <Row key={r.id} patient={r.imagingOrder.patient} title={`${r.imagingOrder.modality} — ${r.imagingOrder.studyDescription}`} meta={r.impression} ageMinutes={r.ageMinutes}>
            <ActionButton label="Acknowledge" tone="red" onClick={() => acknowledge(r.imagingOrder.id, r.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Pending scheduling" count={worklist.pendingScheduling.length}>
        {worklist.pendingScheduling.map((o) => (
          <div key={o.id}>
            <Row patient={o.patient} title={`${o.modality} — ${o.studyDescription}`} meta="awaiting schedule" ageMinutes={o.ageMinutes}>
              <ActionButton label="Schedule" tone="emerald" onClick={() => setScheduleForm(scheduleForm === o.id ? null : o.id)} />
            </Row>
            {scheduleForm === o.id && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-hairline p-2.5">
                <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[11.5px]">
                  <option value="">No specific resource</option>
                  {resources.filter((r) => r.modality === o.modality).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[11.5px]" />
                <ActionButton label="Confirm slot" tone="emerald" onClick={() => submitSchedule(o.id)} />
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Scheduled — awaiting arrival" count={worklist.scheduledAwaitingArrival.length}>
        {worklist.scheduledAwaitingArrival.map((s) => (
          <Row key={s.id} patient={s.imagingOrder.patient} title={`${s.imagingOrder.modality} — ${s.imagingOrder.studyDescription}`} meta={s.accessionNumber} ageMinutes={s.ageMinutes}>
            <ActionButton label="Check in" tone="emerald" onClick={() => checkin(s.imagingOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Ready for imaging" count={worklist.readyForImaging.length}>
        {worklist.readyForImaging.map((s) => (
          <Row key={s.id} patient={s.imagingOrder.patient} title={`${s.imagingOrder.modality} — ${s.imagingOrder.studyDescription}`} meta={s.accessionNumber} ageMinutes={s.ageMinutes}>
            <ActionButton label="Start study" tone="emerald" onClick={() => start(s.imagingOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="In progress" count={worklist.inProgress.length}>
        {worklist.inProgress.map((s) => (
          <Row key={s.id} patient={s.imagingOrder.patient} title={`${s.imagingOrder.modality} — ${s.imagingOrder.studyDescription}`} meta={s.accessionNumber} ageMinutes={s.ageMinutes}>
            <ActionButton label="Complete" tone="emerald" onClick={() => complete(s.imagingOrder.id)} />
          </Row>
        ))}
      </SectionCard>

      <SectionCard title="Pending report entry" count={worklist.pendingReport.length}>
        {worklist.pendingReport.map((o) => (
          <div key={o.id}>
            <Row patient={o.patient} title={`${o.modality} — ${o.studyDescription}`} meta="study completed" ageMinutes={o.ageMinutes}>
              <ActionButton label="Enter report" onClick={() => setReportForm(reportForm === o.id ? null : o.id)} />
            </Row>
            {reportForm === o.id && (
              <div className="mt-1.5 space-y-2 rounded-lg border border-hairline p-2.5">
                <input value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="Clinical indication" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
                <textarea value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Findings" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
                <textarea value={impression} onChange={(e) => setImpression(e.target.value)} placeholder="Impression" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11.5px] text-red"><input type="checkbox" checked={isCritical} onChange={(e) => setIsCritical(e.target.checked)} /> Critical finding</label>
                  <ActionButton label="Submit report" tone="emerald" onClick={() => submitReport(o.id)} />
                </div>
              </div>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Pending verification" count={worklist.pendingVerification.length}>
        {worklist.pendingVerification.map((r) => (
          <Row key={r.id} patient={r.imagingOrder.patient} title={`${r.imagingOrder.modality} — ${r.imagingOrder.studyDescription}`} meta={r.impression} ageMinutes={r.ageMinutes}>
            <ActionButton label="Verify" tone="emerald" onClick={() => verify(r.imagingOrder.id, r.id)} />
          </Row>
        ))}
      </SectionCard>

      <Card className="rounded-[20px]">
        <p className="text-[13px] font-semibold">Amend a verified report</p>
        <p className="mt-1 text-[11px] text-text-tertiary">Paste the imaging order and report IDs from the Patient Chart to correct it — the previous verified version is preserved, never overwritten.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={amendOrderId} onChange={(e) => setAmendOrderId(e.target.value)} placeholder="Imaging order ID" className="w-36 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <input value={amendReportId} onChange={(e) => setAmendReportId(e.target.value)} placeholder="Report ID" className="w-36 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
        </div>
        <div className="mt-2 space-y-2">
          <textarea value={amendFindings} onChange={(e) => setAmendFindings(e.target.value)} placeholder="Corrected findings" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <textarea value={amendImpression} onChange={(e) => setAmendImpression(e.target.value)} placeholder="Corrected impression" rows={2} className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
          <div className="flex items-center gap-2">
            <input value={amendReason} onChange={(e) => setAmendReason(e.target.value)} placeholder="Amendment reason" className="min-w-[160px] flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px]" />
            <ActionButton label="Submit amendment" tone="emerald" onClick={submitAmend} />
          </div>
        </div>
      </Card>

      {total === 0 && <p className="text-[13px] text-text-tertiary">Worklist is clear.</p>}
    </div>
  );
}
