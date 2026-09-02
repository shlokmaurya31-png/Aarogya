"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, FlaskConical, ScanLine, Pill, FileText, ShieldAlert, Stethoscope, History, ClipboardList, Send } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface TimelineEntry { id: string; timestamp: string; type: string; summary: string; department?: string | null }

interface ChartData {
  patient: { id: string; uhid: string; fullName: string; sex: string; ageYears: number | null; bloodGroup: string | null };
  allergies: { id: string; substance: string; severity: string; reaction: string | null }[];
  problems: { id: string; diagnosis: string; status: string }[];
  diagnoses: { id: string; diagnosis: string; type: string; status: string }[];
  encounters: { id: string; type: string; status: string; chiefComplaint: string | null; registeredAt: string }[];
  notes: { id: string; type: string; status: string; content: { assessment?: string; plan?: string; [k: string]: unknown }; author: { user: { displayName: string } }; createdAt: string }[];
  vitals: { id: string; hr: number | null; sbp: number | null; dbp: number | null; spo2: number | null; tempC: number | null; recordedAt: string }[];
  medicationOrders: {
    id: string; drugName: string; dose: string; route: string; frequency: string; status: string; orderedAt: string; isControlled: boolean;
    safetyWarnings: { id: string; severity: string; message: string; acknowledgedAt: string | null }[];
  }[];
  labOrders: { id: string; testName: string; status: string; orderedAt: string; result: { value: string; unit: string | null; isCritical: boolean; acknowledgedAt: string | null } | null }[];
  imagingOrders: { id: string; modality: string; studyDescription: string; status: string; report: { impression: string; isCritical: boolean; verifiedAt: string | null } | null }[];
  carePlans: { id: string; problem: string; goal: string; status: string; interventions: { id: string; description: string; responsibleRole: string; status: string }[] }[];
}

const MED_STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  ORDERED: "neutral", PHARMACY_REVIEW: "amber", VERIFIED: "cyan", DISPENSED: "cyan", ACTIVE: "emerald",
  COMPLETED: "neutral", CANCELLED: "red", DISCONTINUED: "red", HELD: "amber", REJECTED: "red",
};

export function PatientChart({ patientId }: { patientId: string }) {
  const searchParams = useSearchParams();
  const encounterId = searchParams.get("encounterId");
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<ChartData | null>(null);
  const [tab, setTab] = useState<"orders" | "notes" | "clinical" | "timeline" | "careplan">("orders");
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);

  // Care plan composer (brief §6)
  const [cpProblem, setCpProblem] = useState("");
  const [cpGoal, setCpGoal] = useState("");
  const [cpIntervention, setCpIntervention] = useState("");
  const [cpRole, setCpRole] = useState("Nursing");

  // Clinical-core composer state (brief §33 / Phase 1)
  const [diagnosisText, setDiagnosisText] = useState("");
  const [diagnosisType, setDiagnosisType] = useState("PROVISIONAL");
  const [problemText, setProblemText] = useState("");
  const [allergySubstance, setAllergySubstance] = useState("");
  const [allergySeverity, setAllergySeverity] = useState("moderate");

  // Order composer state
  const [drugName, setDrugName] = useState("");
  const [dose, setDose] = useState("");
  const [route, setRoute] = useState("oral");
  const [frequency, setFrequency] = useState("BD");
  const [pendingFlags, setPendingFlags] = useState<{ rule: string; severity: string; message: string }[] | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [labTest, setLabTest] = useState("");
  const [imagingModality, setImagingModality] = useState("XRAY");
  const [imagingDesc, setImagingDesc] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState("PROGRESS");

  const load = useCallback(() => {
    fetch(`/api/hospital/patients/${patientId}/chart`).then((r) => r.json()).then(setData);
  }, [patientId]);
  useEffect(load, [load]);

  async function orderMedication(overrideReason?: string) {
    if (!encounterId) { push("Open this patient from an active encounter to place orders.", "amber"); return; }
    const res = await fetch("/api/hospital/orders/medication", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId, patientId, drugName, genericName: drugName, dose, route, frequency, overrideReason }),
    });
    const result = await res.json();
    if (result.blocked) { setPendingFlags(result.flags); return; }
    if (!res.ok) { push(result.error ?? "Order failed.", "red"); return; }
    if (result.flags?.length) push(`Order placed with ${result.flags.length} safety flag(s) noted.`, "amber");
    else push("Medication ordered.", "emerald");
    setPendingFlags(null); setOverrideReason(""); setDrugName(""); setDose(""); load();
  }

  async function orderLab() {
    if (!encounterId || !labTest.trim()) return;
    const res = await fetch("/api/hospital/orders/lab", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId, patientId, testName: labTest, category: "biochemistry" }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Order failed.", "red"); return; }
    push("Lab test ordered.", "emerald"); setLabTest(""); load();
  }

  async function orderImaging() {
    if (!encounterId || !imagingDesc.trim()) return;
    const res = await fetch("/api/hospital/orders/imaging", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encounterId, patientId, modality: imagingModality, studyDescription: imagingDesc }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Order failed.", "red"); return; }
    push("Imaging study ordered.", "emerald"); setImagingDesc(""); load();
  }

  async function addNote(supersedesId?: string) {
    if (!encounterId || !noteText.trim()) return;
    let amendmentReason: string | undefined;
    if (supersedesId) {
      amendmentReason = window.prompt("Reason for amending this signed note?") ?? undefined;
      if (!amendmentReason) return;
    }
    const res = await fetch(`/api/hospital/encounters/${encounterId}/notes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: noteType, content: { assessment: noteText }, sign: true, supersedesId, amendmentReason }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to save note.", "red"); return; }
    push(supersedesId ? "Amendment signed and saved." : "Note signed and saved.", "emerald"); setNoteText(""); load();
  }

  async function acknowledgeLab(labOrderId: string) {
    const res = await fetch(`/api/hospital/orders/lab/${labOrderId}/acknowledge`, { method: "POST" });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Critical result acknowledged.", "emerald"); load();
  }

  async function verifyImaging(imagingOrderId: string) {
    const res = await fetch(`/api/hospital/orders/imaging/${imagingOrderId}/verify`, { method: "POST" });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Critical finding verified.", "emerald"); load();
  }

  async function addDiagnosis() {
    if (!encounterId || !diagnosisText.trim()) return;
    const res = await fetch(`/api/hospital/encounters/${encounterId}/diagnoses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnosis: diagnosisText, type: diagnosisType }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to add diagnosis.", "red"); return; }
    push("Diagnosis recorded.", "emerald"); setDiagnosisText(""); load();
  }

  async function addProblem() {
    if (!problemText.trim()) return;
    const res = await fetch(`/api/hospital/patients/${patientId}/problems`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diagnosis: problemText }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to add problem.", "red"); return; }
    push("Added to problem list.", "emerald"); setProblemText(""); load();
  }

  async function addAllergy() {
    if (!allergySubstance.trim()) return;
    const res = await fetch(`/api/hospital/patients/${patientId}/allergies`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ substance: allergySubstance, severity: allergySeverity }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to add allergy.", "red"); return; }
    push("Allergy recorded.", "emerald"); setAllergySubstance(""); load();
  }

  function loadTimeline() {
    fetch(`/api/hospital/patients/${patientId}/timeline`).then((r) => r.json()).then((d) => setTimeline(d.timeline ?? []));
  }

  async function createCarePlan() {
    if (!cpProblem.trim() || !cpGoal.trim()) return;
    const res = await fetch(`/api/hospital/patients/${patientId}/care-plans`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encounterId: encounterId ?? undefined, problem: cpProblem, goal: cpGoal,
        interventions: cpIntervention.trim() ? [{ description: cpIntervention, responsibleRole: cpRole }] : undefined,
      }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to create care plan.", "red"); return; }
    push("Care plan created.", "emerald");
    setCpProblem(""); setCpGoal(""); setCpIntervention(""); load();
  }

  async function closeCarePlan(id: string) {
    const res = await fetch(`/api/hospital/care-plans/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed.", "red"); return; }
    push("Care plan closed.", "cyan"); load();
  }

  async function requestHandoff() {
    if (!encounterId) { push("Open this patient from an active encounter to hand off.", "amber"); return; }
    const summary = window.prompt("Handoff summary?");
    if (!summary) return;
    const res = await fetch("/api/hospital/handoffs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, encounterId, type: "DOCTOR", summary }),
    });
    if (!res.ok) { push((await res.json()).error ?? "Failed to create handoff.", "red"); return; }
    push("Handoff created.", "emerald");
  }

  if (!data) return <div className="mx-auto max-w-5xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-5xl">
      <ToastViewport />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{data.patient.fullName}</h1>
          <p className="mt-1 text-[12.5px] text-text-secondary">{data.patient.uhid} · {data.patient.ageYears}{data.patient.sex[0]?.toUpperCase()} · {data.patient.bloodGroup ?? "Blood group unknown"}</p>
        </div>
        {!encounterId && <StatusPill label="Read-only — open from an active encounter to order" tone="amber" className="rounded-md" />}
        {encounterId && (
          <button onClick={requestHandoff} className="flex items-center gap-1.5 rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] font-medium hover:border-cyan/40 hover:text-cyan">
            <Send size={12} /> Request handoff
          </button>
        )}
      </div>

      {data.allergies.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.allergies.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 rounded-md bg-red/10 px-2.5 py-1 text-[11.5px] text-red">
              <ShieldAlert size={12} /> Allergy: {a.substance} ({a.severity})
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <TabButton active={tab === "orders"} onClick={() => setTab("orders")}>Orders</TabButton>
            <TabButton active={tab === "clinical"} onClick={() => setTab("clinical")}>Diagnoses & Problems</TabButton>
            <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>Notes</TabButton>
            <TabButton active={tab === "timeline"} onClick={() => { setTab("timeline"); loadTimeline(); }}>Timeline</TabButton>
            <TabButton active={tab === "careplan"} onClick={() => setTab("careplan")}>Care Plan</TabButton>
          </div>

          {tab === "orders" && (
            <>
              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><Pill size={14} className="text-cyan" /><CardLabel>Medication order</CardLabel></div>
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <input value={drugName} onChange={(e) => setDrugName(e.target.value)} placeholder="Drug" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="Dose" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <input value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Route" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <input value={frequency} onChange={(e) => setFrequency(e.target.value)} placeholder="Frequency" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                </div>
                {pendingFlags && (
                  <div className="mt-3 space-y-2">
                    {pendingFlags.map((f, i) => (
                      <p key={i} className="flex items-start gap-1.5 rounded-md bg-red/10 px-3 py-2 text-[12px] text-red"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {f.message}</p>
                    ))}
                    <div className="flex items-center gap-2">
                      <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Override reason (required to proceed)" className="flex-1 rounded-md border border-red/30 bg-red/[0.02] px-2.5 py-2 text-[12px] outline-none" />
                      <button onClick={() => orderMedication(overrideReason)} disabled={!overrideReason.trim()} className="rounded-md bg-red px-3 py-2 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">Override & order</button>
                    </div>
                  </div>
                )}
                <button onClick={() => orderMedication()} disabled={!encounterId} className="mt-3 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">Place order</button>
              </Card>

              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><FlaskConical size={14} className="text-cyan" /><CardLabel>Lab order</CardLabel></div>
                <div className="mt-3 flex gap-2">
                  <input value={labTest} onChange={(e) => setLabTest(e.target.value)} placeholder="Test name (e.g. CBC, Troponin I)" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <button onClick={orderLab} disabled={!encounterId} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">Order</button>
                </div>
              </Card>

              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><ScanLine size={14} className="text-cyan" /><CardLabel>Imaging order</CardLabel></div>
                <div className="mt-3 flex gap-2">
                  <select value={imagingModality} onChange={(e) => setImagingModality(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40">
                    {["XRAY", "CT", "MRI", "USG"].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input value={imagingDesc} onChange={(e) => setImagingDesc(e.target.value)} placeholder="Study description" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <button onClick={orderImaging} disabled={!encounterId} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">Order</button>
                </div>
              </Card>
            </>
          )}

          {tab === "clinical" && (
            <>
              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><Stethoscope size={14} className="text-cyan" /><CardLabel>Add diagnosis</CardLabel></div>
                <p className="mt-1 text-[11.5px] text-text-tertiary">Tied to this encounter — distinct from the problem list, which persists across encounters.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <input value={diagnosisText} onChange={(e) => setDiagnosisText(e.target.value)} placeholder="Diagnosis" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <select value={diagnosisType} onChange={(e) => setDiagnosisType(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40">
                    {["PRIMARY", "SECONDARY", "PROVISIONAL", "RULE_OUT", "FINAL"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={addDiagnosis} disabled={!encounterId} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">Add</button>
                </div>
              </Card>

              <Card className="rounded-[20px]">
                <CardLabel>Add to problem list</CardLabel>
                <div className="mt-3 flex gap-2">
                  <input value={problemText} onChange={(e) => setProblemText(e.target.value)} placeholder="Problem" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <button onClick={addProblem} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110">Add</button>
                </div>
              </Card>

              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><ShieldAlert size={14} className="text-red" /><CardLabel>Record allergy</CardLabel></div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <input value={allergySubstance} onChange={(e) => setAllergySubstance(e.target.value)} placeholder="Substance" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <select value={allergySeverity} onChange={(e) => setAllergySeverity(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40">
                    {["mild", "moderate", "severe"].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button onClick={addAllergy} className="rounded-md bg-red px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">Record</button>
                </div>
              </Card>
            </>
          )}

          {tab === "timeline" && (
            <Card className="rounded-[20px]">
              <div className="flex items-center gap-2"><History size={14} className="text-cyan" /><CardLabel>Longitudinal timeline</CardLabel></div>
              <div className="mt-3 space-y-2.5">
                {timeline === null && <p className="text-[12px] text-text-tertiary">Loading...</p>}
                {timeline?.map((t) => (
                  <div key={t.id} className="flex gap-3 text-[12.5px]">
                    <span className="w-32 shrink-0 text-[11px] text-text-tertiary">{new Date(t.timestamp).toLocaleString()}</span>
                    <span><span className="font-medium">{t.type}:</span> {t.summary}{t.department ? ` (${t.department})` : ""}</span>
                  </div>
                ))}
                {timeline?.length === 0 && <p className="text-[12px] text-text-tertiary">No history recorded yet.</p>}
              </div>
            </Card>
          )}

          {tab === "careplan" && (
            <>
              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><ClipboardList size={14} className="text-cyan" /><CardLabel>New care plan</CardLabel></div>
                <p className="mt-1 text-[11.5px] text-text-tertiary">Problem/goal/interventions — clinician-authored; no thresholds or protocols are inferred by the system.</p>
                <div className="mt-3 space-y-2">
                  <input value={cpProblem} onChange={(e) => setCpProblem(e.target.value)} placeholder="Problem (e.g. Pneumonia)" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <input value={cpGoal} onChange={(e) => setCpGoal(e.target.value)} placeholder="Goal" className="w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  <div className="flex gap-2">
                    <input value={cpIntervention} onChange={(e) => setCpIntervention(e.target.value)} placeholder="Intervention (optional)" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                    <input value={cpRole} onChange={(e) => setCpRole(e.target.value)} placeholder="Responsible role" className="w-40 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                  </div>
                  <button onClick={createCarePlan} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110">Create care plan</button>
                </div>
              </Card>
              <Card className="rounded-[20px]">
                <CardLabel>Care plans</CardLabel>
                <div className="mt-3 space-y-3">
                  {data.carePlans.map((cp) => (
                    <div key={cp.id} className="rounded-md border border-hairline p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[13px] font-medium">{cp.problem}</p>
                        <div className="flex items-center gap-1.5">
                          <StatusPill label={cp.status} tone={cp.status === "ACTIVE" ? "cyan" : "neutral"} className="rounded-md" />
                          {cp.status === "ACTIVE" && <button onClick={() => closeCarePlan(cp.id)} className="rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-emerald/40">Close</button>}
                        </div>
                      </div>
                      <p className="mt-1 text-[12px] text-text-secondary">Goal: {cp.goal}</p>
                      {cp.interventions.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {cp.interventions.map((i) => (
                            <li key={i.id} className="text-[11.5px] text-text-tertiary">• {i.description} ({i.responsibleRole}) — {i.status}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                  {data.carePlans.length === 0 && <p className="text-[12px] text-text-tertiary">No care plans yet.</p>}
                </div>
              </Card>
            </>
          )}

          {tab === "notes" && (
            <>
              <Card className="rounded-[20px]">
                <CardLabel>New note</CardLabel>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select value={noteType} onChange={(e) => setNoteType(e.target.value)} className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40">
                    {["PROGRESS", "CONSULT", "ADMISSION", "DAILY_ROUND", "PROCEDURE", "DISCHARGE_SUMMARY", "FOLLOW_UP", "HANDOVER"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
                  </select>
                </div>
                <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder="Assessment / plan..." className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
                <button onClick={() => addNote()} disabled={!encounterId} className="mt-2 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">Sign & save note</button>
              </Card>
              <Card className="rounded-[20px]">
                <div className="flex items-center gap-2"><FileText size={14} className="text-cyan" /><CardLabel>Notes</CardLabel></div>
                <div className="mt-3 space-y-2.5">
                  {data.notes.map((n) => (
                    <div key={n.id} className="rounded-md bg-black/[0.02] p-2.5 text-[12.5px]">
                      <div className="flex items-center justify-between">
                        <p className="text-text-tertiary">{n.type} · {n.author.user.displayName} · {new Date(n.createdAt).toLocaleString()}</p>
                        <StatusPill label={n.status} tone={n.status === "SIGNED" ? "emerald" : n.status === "SUPERSEDED" ? "neutral" : "amber"} className="rounded-md" />
                      </div>
                      <p className="mt-1">{n.content.assessment}</p>
                      {n.status === "SIGNED" && encounterId && (
                        <button onClick={() => noteText.trim() && addNote(n.id)} disabled={!noteText.trim()} className="mt-1.5 rounded-md border border-hairline-strong px-2 py-0.5 text-[10.5px] hover:border-cyan/40 disabled:opacity-40">
                          Amend (type replacement text above first)
                        </button>
                      )}
                    </div>
                  ))}
                  {data.notes.length === 0 && <p className="text-[12px] text-text-tertiary">No notes yet.</p>}
                </div>
              </Card>
            </>
          )}
        </div>

        <div className="space-y-4">
          <Card className="rounded-[20px]">
            <CardLabel>Diagnoses</CardLabel>
            <div className="mt-2 space-y-1.5">
              {data.diagnoses.map((d) => (
                <div key={d.id} className="text-[11.5px]">
                  <span className="font-medium">{d.diagnosis}</span> <span className="text-text-tertiary">({d.type})</span>
                </div>
              ))}
              {data.diagnoses.length === 0 && <p className="text-[11.5px] text-text-tertiary">No diagnoses recorded.</p>}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Problem list</CardLabel>
            <div className="mt-2 space-y-1.5">
              {data.problems.map((p) => <StatusPill key={p.id} label={p.diagnosis} tone={p.status === "active" ? "amber" : "neutral"} className="mr-1 rounded-md" />)}
              {data.problems.length === 0 && <p className="text-[11.5px] text-text-tertiary">No documented problems.</p>}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Lab results</CardLabel>
            <div className="mt-2 space-y-2">
              {data.labOrders.map((l) => (
                <div key={l.id} className="text-[11.5px]">
                  <div className="flex items-center justify-between">
                    <span>{l.testName}</span>
                    {l.result ? <span className="tabular-nums">{l.result.value} {l.result.unit}</span> : <StatusPill label={l.status} tone="neutral" className="rounded-md" />}
                  </div>
                  {l.result?.isCritical && !l.result.acknowledgedAt && (
                    <button onClick={() => acknowledgeLab(l.id)} className="mt-1 rounded-md bg-red/10 px-2 py-1 text-[10.5px] font-medium text-red hover:bg-red/20">Acknowledge critical result</button>
                  )}
                </div>
              ))}
              {data.labOrders.length === 0 && <p className="text-[11.5px] text-text-tertiary">No lab orders.</p>}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Imaging</CardLabel>
            <div className="mt-2 space-y-2">
              {data.imagingOrders.map((im) => (
                <div key={im.id} className="text-[11.5px]">
                  <p>{im.modality} — {im.studyDescription}</p>
                  {im.report && <p className="text-text-tertiary">{im.report.impression}</p>}
                  {im.report?.isCritical && !im.report.verifiedAt && (
                    <button onClick={() => verifyImaging(im.id)} className="mt-1 rounded-md bg-red/10 px-2 py-1 text-[10.5px] font-medium text-red hover:bg-red/20">Verify critical finding</button>
                  )}
                </div>
              ))}
              {data.imagingOrders.length === 0 && <p className="text-[11.5px] text-text-tertiary">No imaging orders.</p>}
            </div>
          </Card>

          <Card className="rounded-[20px]">
            <CardLabel>Medications</CardLabel>
            <div className="mt-2 space-y-2">
              {data.medicationOrders.map((m) => (
                <div key={m.id} className="text-[11.5px]">
                  <div className="flex items-center justify-between">
                    <span>{m.drugName} {m.dose}{m.isControlled ? " ⚠" : ""}</span>
                    <StatusPill label={m.status.replace("_", " ")} tone={MED_STATUS_TONE[m.status] ?? "neutral"} className="rounded-md" />
                  </div>
                  {m.safetyWarnings.filter((w) => !w.acknowledgedAt).length > 0 && (
                    <p className="mt-0.5 text-[10.5px] text-red">{m.safetyWarnings.filter((w) => !w.acknowledgedAt).length} unacknowledged safety warning(s)</p>
                  )}
                </div>
              ))}
              {data.medicationOrders.length === 0 && <p className="text-[11.5px] text-text-tertiary">No medication orders.</p>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full px-3.5 py-1.5 text-[12.5px] ${active ? "bg-cyan text-ink" : "border border-hairline text-text-secondary"}`}>
      {children}
    </button>
  );
}
