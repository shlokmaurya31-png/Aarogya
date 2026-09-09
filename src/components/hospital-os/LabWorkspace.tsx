"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, ClipboardCheck, Gauge, Beaker, Send } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { LabQueue } from "@/components/hospital-os/LabQueue";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "worklist" | "qc" | "calibration" | "external";

export function LabWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("worklist");
  const [qc, setQc] = useState<any[] | null>(null);
  const [cal, setCal] = useState<any[] | null>(null);
  const [ext, setExt] = useState<any[] | null>(null);
  // record forms
  const [qcForm, setQcForm] = useState({ instrumentId: "", controlType: "NORMAL", observedValue: "", result: "PASS" });
  const [calForm, setCalForm] = useState({ instrumentId: "", calibrationType: "" });
  const [extForm, setExtForm] = useState({ patientId: "", externalLabName: "", testDescription: "" });

  const loadTab = useCallback((t: Tab) => {
    if (t === "qc") fetch("/api/hospital/lab/qc").then((r) => r.json()).then((d) => setQc(d.qc ?? []));
    if (t === "calibration") fetch("/api/hospital/lab/calibration").then((r) => r.json()).then((d) => setCal(d.calibrations ?? []));
    if (t === "external") fetch("/api/hospital/lab/external").then((r) => r.json()).then((d) => setExt(d.referrals ?? []));
  }, []);
  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  async function post(url: string, body: unknown, ok: string) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return false; }
    push(ok, "emerald"); loadTab(tab); return true;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <FlaskConical size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Laboratory</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([["worklist", "Worklist", ClipboardCheck], ["qc", "QC", Gauge], ["calibration", "Calibration", Beaker], ["external", "External Labs", Send]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "worklist" && <LabQueue />}

      {tab === "qc" && (
        <div className="space-y-3">
          <Card className="rounded-[20px]"><CardLabel>Record QC run</CardLabel>
            <p className="mt-1 text-[11.5px] text-text-tertiary">Documentary quality-control record — the PASS/FAIL label is entered by staff, never computed as a clinical claim.</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input value={qcForm.instrumentId} onChange={(e) => setQcForm({ ...qcForm, instrumentId: e.target.value })} placeholder="Instrument ID" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <select value={qcForm.controlType} onChange={(e) => setQcForm({ ...qcForm, controlType: e.target.value })} className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]">{["LOW", "NORMAL", "HIGH"].map((c) => <option key={c}>{c}</option>)}</select>
              <input value={qcForm.observedValue} onChange={(e) => setQcForm({ ...qcForm, observedValue: e.target.value })} placeholder="Observed" className="w-24 rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <select value={qcForm.result} onChange={(e) => setQcForm({ ...qcForm, result: e.target.value })} className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]">{["PASS", "FAIL"].map((c) => <option key={c}>{c}</option>)}</select>
              <button disabled={!qcForm.instrumentId} onClick={() => post("/api/hospital/lab/qc", { instrumentId: qcForm.instrumentId, controlType: qcForm.controlType, observedValue: qcForm.observedValue || undefined, result: qcForm.result }, "QC recorded.").then((ok) => ok && setQcForm({ ...qcForm, observedValue: "" }))} className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-1.5 text-[12px] text-cyan disabled:opacity-40">Record</button>
            </div>
          </Card>
          <Card className="rounded-[20px]"><CardLabel>QC runs</CardLabel>
            <div className="mt-2 space-y-1.5">
              {!qc && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
              {qc && qc.length === 0 && <p className="text-[13px] text-text-tertiary">No QC runs.</p>}
              {qc?.map((q: any) => (
                <div key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                  <span>{q.instrumentId} · {q.controlType}{q.observedValue != null ? ` · obs ${q.observedValue}` : ""}{q.result ? ` · ${q.result}` : ""}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={q.status} tone={q.status === "REVIEWED" ? "emerald" : q.status === "REJECTED" ? "red" : "amber"} className="rounded-md" />
                    {q.status === "PENDING" && (["REVIEWED", "REJECTED"] as const).map((s) => <button key={s} onClick={() => post(`/api/hospital/lab/qc/${q.id}/review`, { to: s }, `QC ${s.toLowerCase()}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">{s === "REVIEWED" ? "Review" : "Reject"}</button>)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === "calibration" && (
        <div className="space-y-3">
          <Card className="rounded-[20px]"><CardLabel>Record calibration</CardLabel>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input value={calForm.instrumentId} onChange={(e) => setCalForm({ ...calForm, instrumentId: e.target.value })} placeholder="Instrument ID" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <input value={calForm.calibrationType} onChange={(e) => setCalForm({ ...calForm, calibrationType: e.target.value })} placeholder="Calibration type" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <button disabled={!calForm.instrumentId || !calForm.calibrationType} onClick={() => post("/api/hospital/lab/calibration", { instrumentId: calForm.instrumentId, calibrationType: calForm.calibrationType }, "Calibration recorded.").then((ok) => ok && setCalForm({ instrumentId: "", calibrationType: "" }))} className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-1.5 text-[12px] text-cyan disabled:opacity-40">Record</button>
            </div>
          </Card>
          <Card className="rounded-[20px]"><CardLabel>Calibrations</CardLabel>
            <div className="mt-2 space-y-1.5">
              {!cal && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
              {cal && cal.length === 0 && <p className="text-[13px] text-text-tertiary">No calibrations.</p>}
              {cal?.map((c: any) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                  <span>{c.instrumentId} · {c.calibrationType} · {new Date(c.calibratedAt).toLocaleDateString()}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusPill label={c.status} tone={c.status === "REVIEWED" ? "emerald" : c.status === "REJECTED" ? "red" : "amber"} className="rounded-md" />
                    {c.status === "PENDING" && (["REVIEWED", "REJECTED"] as const).map((s) => <button key={s} onClick={() => post(`/api/hospital/lab/calibration/${c.id}/review`, { to: s }, `Calibration ${s.toLowerCase()}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">{s === "REVIEWED" ? "Review" : "Reject"}</button>)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === "external" && (
        <div className="space-y-3">
          <Card className="rounded-[20px]"><CardLabel>Send to external laboratory</CardLabel>
            <p className="mt-1 text-[11.5px] text-text-tertiary">Referral boundary only — a clean seam for a future connector, not a live integration.</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <input value={extForm.patientId} onChange={(e) => setExtForm({ ...extForm, patientId: e.target.value })} placeholder="Patient ID" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <input value={extForm.externalLabName} onChange={(e) => setExtForm({ ...extForm, externalLabName: e.target.value })} placeholder="External lab name" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <input value={extForm.testDescription} onChange={(e) => setExtForm({ ...extForm, testDescription: e.target.value })} placeholder="Test" className="rounded-lg border border-hairline bg-transparent px-2 py-1.5 text-[12.5px]" />
              <button disabled={!extForm.patientId || !extForm.externalLabName} onClick={() => post("/api/hospital/lab/external", { patientId: extForm.patientId, externalLabName: extForm.externalLabName, testDescription: extForm.testDescription || undefined }, "Referral created.").then((ok) => ok && setExtForm({ patientId: "", externalLabName: "", testDescription: "" }))} className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-1.5 text-[12px] text-cyan disabled:opacity-40">Create</button>
            </div>
          </Card>
          <Card className="rounded-[20px]"><CardLabel>External referrals</CardLabel>
            <div className="mt-2 space-y-1.5">
              {!ext && <div className="h-16 animate-pulse rounded-xl bg-black/[0.04]" />}
              {ext && ext.length === 0 && <p className="text-[13px] text-text-tertiary">No referrals.</p>}
              {ext?.map((r: any) => {
                const next: Record<string, string> = { DRAFT: "SENT", SENT: "RESULT_RECEIVED", RESULT_RECEIVED: "REVIEWED" };
                return (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-1.5 text-[12.5px]">
                    <span>{r.externalLabName}{r.testDescription ? ` · ${r.testDescription}` : ""}</span>
                    <span className="flex items-center gap-1.5">
                      <StatusPill label={r.status.replace(/_/g, " ")} tone={r.status === "REVIEWED" ? "emerald" : r.status === "CANCELLED" ? "red" : "cyan"} className="rounded-md" />
                      {next[r.status] && <button onClick={() => post(`/api/hospital/lab/external/${r.id}/status`, { to: next[r.status] }, `Marked ${next[r.status].replace(/_/g, " ").toLowerCase()}.`)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 hover:text-cyan">→ {next[r.status].replace(/_/g, " ")}</button>}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
