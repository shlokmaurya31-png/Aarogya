"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  HeartPulse, Activity, Thermometer, Wind, Droplets, Brain, FlaskConical,
  Stethoscope, ChevronRight, Send, Plus, Trash2, Trophy, RotateCcw, ArrowRight,
} from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { PrescriptionForm, type RxEntry } from "@/components/student/PrescriptionForm";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<string, string> = {
  TRIAGE: "Triage", HISTORY: "History", PHYSICAL: "Examination", DIFFERENTIAL: "Differential",
  INVESTIGATIONS: "Investigations", INTERPRETATION: "Interpretation", DIAGNOSIS: "Diagnosis",
  MANAGEMENT: "Management", PRESCRIPTION: "Prescription", MONITORING: "Monitoring",
  DISPOSITION: "Disposition", DOCUMENTATION: "Documentation", VIVA: "Viva", DEBRIEF: "Debrief", COMPLETE: "Complete",
};
const UI_STAGES = ["HISTORY", "PHYSICAL", "DIFFERENTIAL", "INVESTIGATIONS", "DIAGNOSIS", "MANAGEMENT", "PRESCRIPTION", "DOCUMENTATION", "VIVA", "DEBRIEF"];
const AUTO_ADVANCE = new Set(["TRIAGE", "INTERPRETATION", "MONITORING", "DISPOSITION"]);

interface HistoryQ { id: string; question: string; category: string }
interface HistoryA { id: string; question: string; answer: string; category: string }
interface ExamFinding { id: string; system: string; finding: string }
interface InvCatalog { id: string; name: string; category: string; indication: string; turnaroundMinutes: number }
interface InvResult extends InvCatalog { resultSummary: string; interpretation: string }
interface ManagementOption { id: string; label: string; description: string }
interface Vitals { hr: number; sbp: number; dbp: number; rr: number; spo2: number; tempC: number; gcs: number; status: string }

interface CaseView {
  id: string; title: string; specialty: string; difficulty: string; acuity: string;
  patientName: string; patientAgeBand: string; patientSex: string; chiefComplaint: string;
  learningObjectives: string[]; presentation: string; currentVitals: Vitals;
  availableHistoryQuestions: HistoryQ[]; revealedHistory: HistoryA[]; unaskedHistoryCategories: string[];
  availableExamSystems: string[]; revealedExamFindings: ExamFinding[];
  availableInvestigationCatalog: InvCatalog[]; orderedInvestigationResults: InvResult[];
  managementOptions: ManagementOption[];
  prescriptionContext: { allergies: string[]; renalFunction: string; hepaticFunction: string; pregnancyStatus?: string; currentMedications: string[] };
  stage: string; hintsUsed: number;
}

interface DifferentialRow { diagnosis: string; probability: number; supportingEvidence: string; contradictingEvidence: string; mustNotMiss: boolean }

const EMPTY_ROW: DifferentialRow = { diagnosis: "", probability: 50, supportingEvidence: "", contradictingEvidence: "", mustNotMiss: false };

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const push = useToastStore((s) => s.push);
  const [view, setView] = useState<CaseView | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoAdvancing = useRef(false);

  const [differential, setDifferential] = useState<DifferentialRow[]>([{ ...EMPTY_ROW }]);
  const [diagnosis, setDiagnosis] = useState("");
  const [selectedMgmt, setSelectedMgmt] = useState<string[]>([]);
  const [vivaTranscript, setVivaTranscript] = useState<{ prompt: string; studentAnswer: string }[]>([]);
  const [vivaQuestion, setVivaQuestion] = useState<string | null>(null);
  const [vivaInput, setVivaInput] = useState("");
  const [vivaLoading, setVivaLoading] = useState(false);
  const [result, setResult] = useState<{ score: any; debrief: any; newAchievements: string[]; xpGain: number } | null>(null); // eslint-disable-line @typescript-eslint/no-explicit-any

  const load = useCallback(async (restart = false) => {
    const res = await fetch(`/api/student/cases/${caseId}${restart ? "?restart=true" : ""}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to load case.");
      return;
    }
    setAttemptId(data.attemptId);
    setView(data.view);
    setResult(null);
  }, [caseId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async data fetch on mount; setState happens inside load()'s own async callback, not synchronously in the effect body.
  useEffect(() => { load(); }, [load]);

  const postAction = useCallback(async (action: Record<string, unknown>) => {
    if (!attemptId) return null;
    const res = await fetch(`/api/student/cases/${caseId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId, action }),
    });
    const data = await res.json();
    if (!res.ok) {
      push(data.error ?? "Action failed.", "red");
      return null;
    }
    setView(data.view);
    return data;
  }, [attemptId, caseId, push]);

  // Auto-advance stages that don't need a dedicated UI section.
  useEffect(() => {
    if (!view || autoAdvancing.current) return;
    if (AUTO_ADVANCE.has(view.stage)) {
      autoAdvancing.current = true;
      const order = ["TRIAGE", "HISTORY", "PHYSICAL", "DIFFERENTIAL", "INVESTIGATIONS", "INTERPRETATION", "DIAGNOSIS", "MANAGEMENT", "PRESCRIPTION", "MONITORING", "DISPOSITION", "DOCUMENTATION", "VIVA", "DEBRIEF", "COMPLETE"];
      const next = order[Math.min(order.indexOf(view.stage) + 1, order.length - 1)];
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes server-driven stage with the case engine; setState is inside postAction()'s async callback, guarded by the autoAdvancing ref against re-entrancy.
      postAction({ type: "advance-stage", to: next }).finally(() => { autoAdvancing.current = false; });
    }
  }, [view, postAction]);

  async function handleSubmitCase() {
    const res = await fetch(`/api/student/cases/${caseId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId }),
    });
    const data = await res.json();
    if (!res.ok) {
      push(data.error ?? "Submission failed.", "red");
      return;
    }
    setResult(data);
    push(`Case submitted — ${data.score.total}/${data.score.maxTotal}`, data.score.passed ? "emerald" : "amber");
  }

  async function askViva() {
    setVivaLoading(true);
    try {
      const res = await fetch("/api/student/viva", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, transcript: vivaTranscript, type: "next" }),
      });
      const data = await res.json();
      setVivaQuestion(data.complete ? null : data.question?.prompt ?? null);
    } finally {
      setVivaLoading(false);
    }
  }

  function submitVivaAnswer() {
    if (!vivaQuestion || !vivaInput.trim()) return;
    setVivaTranscript((prev) => [...prev, { prompt: vivaQuestion, studentAnswer: vivaInput }]);
    setVivaInput("");
    setVivaQuestion(null);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the viva loop when the case reaches VIVA stage; setState is inside askViva()'s async callback.
    if (view?.stage === "VIVA" && !vivaQuestion && vivaTranscript.length === 0) askViva();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.stage]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- advances the viva loop after each answer; setState is inside askViva()'s async callback.
    if (view?.stage === "VIVA" && !vivaQuestion && vivaTranscript.length > 0 && vivaTranscript.length < 6) askViva();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vivaTranscript]);

  if (error) return <Card className="mx-auto max-w-lg rounded-[20px] text-center">{error}</Card>;
  if (!view) return <div className="mx-auto max-w-6xl animate-pulse space-y-4"><div className="h-8 w-80 rounded bg-black/[0.05]" /><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  const uiStage = view.stage === "TRIAGE" || view.stage === "INTERPRETATION" || view.stage === "MONITORING" || view.stage === "DISPOSITION" ? "HISTORY" : view.stage;
  const uiStageIndex = UI_STAGES.indexOf(uiStage);

  return (
    <div className="mx-auto max-w-6xl">
      <ToastViewport />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">{view.title}</h1>
          <p className="mt-0.5 text-[12px] text-text-tertiary">Case {view.id.slice(0, 8).toUpperCase()} · Synthetic educational case</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill label={view.specialty} tone="cyan" className="rounded-md" />
          <StatusPill label={view.difficulty.replaceAll("_", " ")} tone="neutral" className="rounded-md" />
          <StatusPill label={view.acuity} tone={view.acuity === "EMERGENCY" ? "red" : "amber"} className="rounded-md" />
        </div>
      </div>

      {/* Stage progress */}
      <div className="mt-4 flex items-center gap-1 overflow-x-auto pb-1">
        {UI_STAGES.map((s, i) => (
          <div key={s} className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10.5px] font-medium",
            i < uiStageIndex ? "bg-emerald/10 text-emerald" : i === uiStageIndex ? "bg-cyan/10 text-cyan" : "bg-black/[0.03] text-text-tertiary"
          )}>
            {STAGE_LABELS[s]}
            {i < UI_STAGES.length - 1 && <ChevronRight size={10} className="opacity-40" />}
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* Left: patient card */}
        <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
          <Card className="rounded-[20px]">
            <CardLabel>Patient</CardLabel>
            <p className="mt-1.5 text-[14px] font-medium">{view.patientName}</p>
            <p className="text-[12px] text-text-tertiary">{view.patientAgeBand} · {view.patientSex}</p>
            <p className="mt-2 rounded-md bg-black/[0.03] px-2.5 py-2 text-[12px] italic text-text-secondary">&ldquo;{view.chiefComplaint}&rdquo;</p>
          </Card>
          <Card className="rounded-[20px]">
            <CardLabel>Vitals</CardLabel>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <VitalChip icon={HeartPulse} label="HR" value={`${view.currentVitals.hr}`} status={view.currentVitals.status} />
              <VitalChip icon={Activity} label="BP" value={`${view.currentVitals.sbp}/${view.currentVitals.dbp}`} status={view.currentVitals.status} />
              <VitalChip icon={Wind} label="RR" value={`${view.currentVitals.rr}`} status={view.currentVitals.status} />
              <VitalChip icon={Droplets} label="SpO2" value={`${view.currentVitals.spo2}%`} status={view.currentVitals.status} />
              <VitalChip icon={Thermometer} label="Temp" value={`${view.currentVitals.tempC}°C`} status={view.currentVitals.status} />
              <VitalChip icon={Brain} label="GCS" value={`${view.currentVitals.gcs}`} status={view.currentVitals.status} />
            </div>
          </Card>
          <Card className="rounded-[20px]">
            <CardLabel>Learning objectives</CardLabel>
            <ul className="mt-2 space-y-1.5 text-[11.5px] text-text-secondary">
              {view.learningObjectives.map((o) => <li key={o} className="flex gap-1.5"><span className="text-cyan">•</span>{o}</li>)}
            </ul>
          </Card>
        </div>

        {/* Center: stage content */}
        <div className="space-y-4">
          {!result && uiStage === "HISTORY" && (
            <Card className="rounded-[20px]">
              <div className="flex items-center justify-between">
                <CardLabel>History</CardLabel>
                <button onClick={() => postAction({ type: "advance-stage", to: "PHYSICAL" })} className="flex items-center gap-1 text-[12px] text-cyan hover:underline">
                  Continue to examination <ArrowRight size={12} />
                </button>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{view.presentation}</p>

              <div className="mt-4 space-y-2.5">
                {view.revealedHistory.map((h) => (
                  <div key={h.id} className="rounded-md bg-black/[0.02] px-3 py-2 text-[12.5px]">
                    <p className="text-text-tertiary">Q: {h.question}</p>
                    <p className="mt-0.5 font-medium text-text-primary">{h.answer}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">Ask</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {view.availableHistoryQuestions
                    .filter((q) => !view.revealedHistory.some((r) => r.id === q.id))
                    .map((q) => (
                      <button
                        key={q.id}
                        onClick={() => postAction({ type: "ask-history", historyNodeId: q.id })}
                        className="rounded-full border border-hairline px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
                      >
                        {q.question}
                      </button>
                    ))}
                </div>
              </div>
            </Card>
          )}

          {!result && uiStage === "PHYSICAL" && (
            <Card className="rounded-[20px]">
              <div className="flex items-center justify-between">
                <CardLabel>Physical examination</CardLabel>
                <button onClick={() => postAction({ type: "advance-stage", to: "DIFFERENTIAL" })} className="flex items-center gap-1 text-[12px] text-cyan hover:underline">
                  Continue to differential <ArrowRight size={12} />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {view.availableExamSystems.map((sys) => (
                  <button
                    key={sys}
                    onClick={() => postAction({ type: "select-exam", system: sys })}
                    className="flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[11.5px] capitalize text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
                  >
                    <Stethoscope size={11} /> {sys.replaceAll("-", " ")}
                  </button>
                ))}
              </div>
              <div className="mt-4 space-y-2">
                {view.revealedExamFindings.map((f) => (
                  <div key={f.id} className="rounded-md bg-black/[0.02] px-3 py-2 text-[12.5px]">
                    <span className="text-text-tertiary capitalize">{f.system.replaceAll("-", " ")}: </span>
                    <span className="font-medium">{f.finding}</span>
                  </div>
                ))}
                {view.revealedExamFindings.length === 0 && <p className="text-[12px] text-text-tertiary">Select a system above to examine.</p>}
              </div>
            </Card>
          )}

          {!result && uiStage === "DIFFERENTIAL" && (
            <Card className="rounded-[20px]">
              <CardLabel>Differential diagnosis</CardLabel>
              <p className="mt-1 text-[12px] text-text-tertiary">Rank up to 5 diagnoses with supporting/contradicting evidence.</p>
              <div className="mt-3 space-y-3">
                {differential.map((row, i) => (
                  <div key={i} className="rounded-lg border border-hairline p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-text-tertiary">#{i + 1}</span>
                      <input value={row.diagnosis} onChange={(e) => setDifferential((p) => p.map((r, idx) => idx === i ? { ...r, diagnosis: e.target.value } : r))} placeholder="Diagnosis" className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40" />
                      <input type="number" value={row.probability} onChange={(e) => setDifferential((p) => p.map((r, idx) => idx === i ? { ...r, probability: Number(e.target.value) } : r))} className="w-16 rounded-md border border-hairline bg-black/[0.02] px-2 py-1.5 text-[12px] outline-none focus:border-cyan/40" />
                      <label className="flex items-center gap-1 text-[11px] text-text-tertiary">
                        <input type="checkbox" checked={row.mustNotMiss} onChange={(e) => setDifferential((p) => p.map((r, idx) => idx === i ? { ...r, mustNotMiss: e.target.checked } : r))} /> must-not-miss
                      </label>
                      {differential.length > 1 && <button onClick={() => setDifferential((p) => p.filter((_, idx) => idx !== i))}><Trash2 size={13} className="text-red" /></button>}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <input value={row.supportingEvidence} onChange={(e) => setDifferential((p) => p.map((r, idx) => idx === i ? { ...r, supportingEvidence: e.target.value } : r))} placeholder="Supporting evidence" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40" />
                      <input value={row.contradictingEvidence} onChange={(e) => setDifferential((p) => p.map((r, idx) => idx === i ? { ...r, contradictingEvidence: e.target.value } : r))} placeholder="Contradicting evidence" className="rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12px] outline-none focus:border-cyan/40" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                {differential.length < 5 && (
                  <button onClick={() => setDifferential((p) => [...p, { ...EMPTY_ROW }])} className="flex items-center gap-1 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-cyan/30"><Plus size={12} /> Add</button>
                )}
                <button
                  onClick={() => postAction({ type: "submit-differential", entries: differential.filter((d) => d.diagnosis.trim()) })}
                  className="ml-auto rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110"
                >
                  Submit differential
                </button>
              </div>
            </Card>
          )}

          {!result && uiStage === "INVESTIGATIONS" && (
            <Card className="rounded-[20px]">
              <div className="flex items-center justify-between">
                <CardLabel>Investigations</CardLabel>
                <button onClick={() => postAction({ type: "advance-stage", to: "DIAGNOSIS" })} className="flex items-center gap-1 text-[12px] text-cyan hover:underline">
                  Continue to diagnosis <ArrowRight size={12} />
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {view.availableInvestigationCatalog.map((inv) => {
                  const resulted = view.orderedInvestigationResults.find((r) => r.id === inv.id);
                  return (
                    <div key={inv.id} className={cn("rounded-lg border p-3", resulted ? "border-cyan/30 bg-cyan/[0.03]" : "border-hairline")}>
                      <div className="flex items-center justify-between">
                        <p className="text-[12.5px] font-medium">{inv.name}</p>
                        {!resulted && (
                          <button onClick={() => postAction({ type: "order-investigation", investigationId: inv.id })} className="flex items-center gap-1 rounded-md bg-cyan/10 px-2 py-1 text-[11px] font-medium text-cyan hover:bg-cyan/20">
                            <FlaskConical size={11} /> Order
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-text-tertiary">{inv.indication} · TAT ~{inv.turnaroundMinutes}min</p>
                      {resulted && (
                        <div className="mt-2 rounded-md bg-black/[0.03] p-2 text-[11.5px]">
                          <p className="font-medium">{resulted.resultSummary}</p>
                          <p className="mt-0.5 text-text-tertiary">{resulted.interpretation}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {!result && uiStage === "DIAGNOSIS" && (
            <Card className="rounded-[20px]">
              <CardLabel>Provisional / final diagnosis</CardLabel>
              <textarea
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                rows={3}
                placeholder="State your diagnosis..."
                className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40"
              />
              <button
                onClick={() => postAction({ type: "submit-diagnosis", diagnosis })}
                disabled={!diagnosis.trim()}
                className="mt-3 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40"
              >
                Submit diagnosis
              </button>
            </Card>
          )}

          {!result && uiStage === "MANAGEMENT" && (
            <Card className="rounded-[20px]">
              <CardLabel>Management plan</CardLabel>
              <div className="mt-3 space-y-2">
                {view.managementOptions.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline p-3 hover:border-cyan/30">
                    <input
                      type="checkbox"
                      checked={selectedMgmt.includes(m.id)}
                      onChange={(e) => setSelectedMgmt((p) => (e.target.checked ? [...p, m.id] : p.filter((id) => id !== m.id)))}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-[12.5px] font-medium">{m.label}</p>
                      <p className="text-[11.5px] text-text-tertiary">{m.description}</p>
                    </div>
                  </label>
                ))}
              </div>
              <button
                onClick={() => postAction({ type: "submit-management", selectedStepIds: selectedMgmt })}
                className="mt-3 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110"
              >
                Submit management plan
              </button>
            </Card>
          )}

          {!result && uiStage === "PRESCRIPTION" && (
            <PrescriptionForm
              caseId={caseId}
              context={view.prescriptionContext}
              onSubmit={(drugs: RxEntry[]) => postAction({ type: "submit-prescription", drugs })}
            />
          )}

          {!result && uiStage === "DOCUMENTATION" && (
            <Card className="rounded-[20px]">
              <CardLabel>Documentation</CardLabel>
              <p className="mt-1 text-[12px] text-text-tertiary">Brief SOAP-style note (not separately graded in this build — see architecture notes).</p>
              <textarea rows={5} placeholder="S: ... O: ... A: ... P: ..." className="mt-2 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40" />
              <button onClick={() => postAction({ type: "advance-stage", to: "VIVA" })} className="mt-3 flex items-center gap-1 rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110">
                Continue to viva <ArrowRight size={12} />
              </button>
            </Card>
          )}

          {!result && uiStage === "VIVA" && (
            <Card className="rounded-[20px]">
              <CardLabel>AI Viva</CardLabel>
              <div className="mt-3 space-y-2.5">
                {vivaTranscript.map((t, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-[12.5px] text-text-tertiary">Examiner: {t.prompt}</p>
                    <p className="rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[12.5px]">You: {t.studentAnswer}</p>
                  </div>
                ))}
                {vivaLoading && <p className="text-[12px] text-text-tertiary">Examiner is thinking...</p>}
                {vivaQuestion && (
                  <div>
                    <p className="text-[12.5px] font-medium text-cyan">Examiner: {vivaQuestion}</p>
                    <div className="mt-2 flex gap-2">
                      <input value={vivaInput} onChange={(e) => setVivaInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitVivaAnswer()} placeholder="Your answer..." className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
                      <button onClick={submitVivaAnswer} className="rounded-md bg-cyan px-3 py-2 text-ink"><Send size={13} /></button>
                    </div>
                  </div>
                )}
              </div>
              {vivaTranscript.length >= 2 && (
                <button onClick={() => postAction({ type: "advance-stage", to: "DEBRIEF" })} className="mt-4 flex items-center gap-1 rounded-md border border-hairline-strong px-4 py-1.5 text-[12.5px] font-medium hover:border-cyan/40 hover:text-cyan">
                  Finish viva & continue <ArrowRight size={12} />
                </button>
              )}
            </Card>
          )}

          {!result && uiStage === "DEBRIEF" && (
            <Card className="rounded-[20px] text-center">
              <CardLabel>Ready to submit</CardLabel>
              <p className="mt-2 text-[13px] text-text-secondary">Submit this case for scoring. Your reference answers and detailed debrief unlock afterward.</p>
              <button onClick={handleSubmitCase} className="mt-4 rounded-md bg-emerald px-5 py-2.5 text-[13px] font-medium text-white hover:brightness-110">
                Submit case for scoring
              </button>
            </Card>
          )}

          {result && <DebriefPanel result={result} onReplay={() => load(true)} />}
        </div>
      </div>
    </div>
  );
}

function VitalChip({ icon: Icon, label, value, status }: { icon: typeof HeartPulse; label: string; value: string; status: string }) {
  const tone = status === "critical" ? "text-red" : status === "concern" ? "text-amber" : "text-emerald";
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-black/[0.02] px-2 py-1.5">
      <Icon size={12} className={tone} />
      <div>
        <p className="text-[10px] text-text-tertiary">{label}</p>
        <p className="text-[12px] font-medium tabular-nums">{value}</p>
      </div>
    </div>
  );
}

function DebriefPanel({ result, onReplay }: { result: { score: any; debrief: any; newAchievements: string[]; xpGain: number }; onReplay: () => void }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { score, debrief, newAchievements, xpGain } = result;
  return (
    <div className="space-y-4">
      <Card className={cn("rounded-[20px] text-center", score.passed ? "border-emerald/30 bg-emerald/[0.04]" : "border-amber/30 bg-amber/[0.04]")}>
        <p className="text-[13px] text-text-tertiary">Final score</p>
        <p className="mt-1 text-[36px] font-semibold tabular-nums">{score.total}<span className="text-[16px] text-text-tertiary">/{score.maxTotal}</span></p>
        <StatusPill label={score.passed ? "Passed" : "Below pass threshold"} tone={score.passed ? "emerald" : "amber"} className="mt-2 rounded-md" />
        <p className="mt-2 text-[12px] text-text-tertiary">+{xpGain} Clinical XP{score.hintsUsed > 0 ? ` · -${score.hintPenalty} hint penalty` : ""}</p>
        {newAchievements.length > 0 && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[12.5px] text-amber"><Trophy size={13} /> New: {newAchievements.join(", ")}</p>
        )}
      </Card>

      <Card className="rounded-[20px]">
        <CardLabel>Score breakdown</CardLabel>
        <div className="mt-3 space-y-2.5">
          {score.dimensions.map((d: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
            <div key={d.key}>
              <div className="flex items-center justify-between text-[12px]">
                <span>{d.label}</span>
                <span className="tabular-nums text-text-tertiary">{d.earned}/{d.maxEarnable}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
                <div className="h-full rounded-full bg-cyan" style={{ width: `${d.maxEarnable ? (d.earned / d.maxEarnable) * 100 : 0}%` }} />
              </div>
              {d.notes.map((n: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-text-tertiary">{n}</p>)}
            </div>
          ))}
        </div>
      </Card>

      <Card className="rounded-[20px]">
        <CardLabel>Reference reasoning</CardLabel>
        <p className="mt-2 text-[13px]"><span className="text-text-tertiary">Reference diagnosis:</span> <span className="font-medium">{debrief.referenceDx}</span></p>
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">Reference differentials</p>
          <ul className="mt-1.5 space-y-1.5">
            {debrief.referenceDifferentials.map((d: any, i: number) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
              <li key={i} className="text-[12.5px]">
                <span className="font-medium">{d.diagnosis}</span>{d.mustNotMiss && <span className="ml-1.5 text-[10px] text-red">must-not-miss</span>}
                <p className="text-[11.5px] text-text-tertiary">{d.rationale}</p>
              </li>
            ))}
          </ul>
        </div>
        {score.missedCriticalActions?.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-red">Missed critical actions</p>
            <ul className="mt-1 space-y-1 text-[12px] text-text-secondary">{score.missedCriticalActions.map((a: string) => <li key={a}>• {a}</li>)}</ul>
          </div>
        )}
        {score.unsafeActionsChosen?.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-red">Unsafe actions chosen</p>
            <ul className="mt-1 space-y-1 text-[12px] text-text-secondary">{score.unsafeActionsChosen.map((a: string) => <li key={a}>• {a}</li>)}</ul>
          </div>
        )}
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">Clinical pearls</p>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-text-secondary">{debrief.debrief.pearls.map((p: string) => <li key={p}>• {p}</li>)}</ul>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2.5">
        <button onClick={onReplay} className="flex items-center gap-1.5 rounded-md border border-hairline-strong px-4 py-2 text-[12.5px] font-medium hover:border-cyan/40 hover:text-cyan">
          <RotateCcw size={13} /> Replay case
        </button>
        <Link href="/student/cases" className="flex items-center gap-1.5 rounded-md bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink hover:brightness-110">
          Try another case <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
