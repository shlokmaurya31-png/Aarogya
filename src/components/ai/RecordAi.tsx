"use client";

import { useState } from "react";
import { Sparkles, ShieldCheck, AlertTriangle } from "lucide-react";
import { createSseParser } from "@/lib/ai/sse";

/**
 * Week 4b — the AI over one patient's record (POST /api/ai/ask), shared by
 * the Hospital OS cockpit, the doctor's and nurse's chart, and the patient
 * portal. Shows the AI-generated label, each line with its citation numbers
 * and its labels (verified / patient-provided / translated / handwritten /
 * not yet confirmed), and the cited entries with links into the record.
 * Staff answers stream line by line; patient answers arrive whole (the
 * server withholds a patient answer that fails validation).
 */
export type RecordAiMode = "VISIT_BRIEF" | "CHART_QA" | "NURSE_HANDOFF" | "EXPLAIN_REPORT" | "HEALTH_TIMELINE" | "PREVISIT_QUESTIONS";

const MODE_LABEL: Record<RecordAiMode, string> = {
  VISIT_BRIEF: "Visit brief", CHART_QA: "Ask about the chart", NURSE_HANDOFF: "Nurse handoff",
  EXPLAIN_REPORT: "Explain this report", HEALTH_TIMELINE: "Health timeline", PREVISIT_QUESTIONS: "Questions for my visit",
};
const NEEDS_QUESTION: RecordAiMode[] = ["CHART_QA"];
const LANGUAGES = [["en", "English"], ["hi", "हिन्दी"], ["mr", "मराठी"], ["bn", "বাংলা"], ["ta", "தமிழ்"], ["te", "తెలుగు"], ["kn", "ಕನ್ನಡ"], ["ml", "മലയാളം"], ["gu", "ગુજરાતી"], ["or", "ଓଡ଼ିଆ"], ["ur", "اردو"]] as const;
const OUTCOME_TEXT: Record<string, string> = {
  NO_RECORD: "Nothing in the record answers this.",
  REFUSED_SAFETY: "This isn't something the assistant can answer.",
  CITATION_INVALID: "The answer couldn't be checked against the record, so it was stopped.",
  ERROR: "The assistant is unavailable right now.",
};

interface Sentence { text: string; citations: number[]; labels: string[]; kind: "FACT" | "GUIDANCE" }
interface Citation { n: number; title: string; origin: string; link: string; recordedAt: string; handwritten: boolean; translated: boolean }

export function RecordAi({ patientId, modes, documentId, appointmentId, shareId, patient = false, defaultLanguage = "en", title = "AI assistant" }: {
  patientId: string; modes: RecordAiMode[]; documentId?: string; appointmentId?: string | null; shareId?: string; patient?: boolean; defaultLanguage?: string; title?: string;
}) {
  const [mode, setMode] = useState<RecordAiMode>(modes[0]);
  const [question, setQuestion] = useState("");
  const [language, setLanguage] = useState(defaultLanguage);
  const [label, setLabel] = useState<string | null>(null);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    if (NEEDS_QUESTION.includes(mode) && !question.trim()) return;
    setBusy(true); setError(null); setSentences([]); setCitations([]); setOutcome(null); setLabel(null);
    const body = {
      mode, patientId,
      ...(shareId ? { shareId } : {}),
      ...(mode === "EXPLAIN_REPORT" && documentId ? { documentId } : {}),
      ...(appointmentId && (mode === "VISIT_BRIEF" || mode === "PREVISIT_QUESTIONS") ? { appointmentId } : {}),
      ...((mode === "CHART_QA" || mode === "EXPLAIN_REPORT") && question.trim() ? { question: question.trim() } : {}),
      ...(patient ? { language } : {}),
    };
    try {
      const res = await fetch("/api/ai/ask", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}));
        setError(res.status === 429 ? "Too many requests — try again in a minute." : res.status === 404 ? "Not available for this patient." : res.status === 403 ? "Not available here." : (e.error ?? "Something went wrong."));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createSseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of feed(decoder.decode(value, { stream: true }))) {
          if (ev.event === "meta") setLabel((ev.data as { label: string }).label);
          else if (ev.event === "sentence") setSentences((s) => [...s, ev.data as Sentence]);
          else if (ev.event === "citations") setCitations(ev.data as Citation[]);
          else if (ev.event === "done") setOutcome((ev.data as { outcome: string }).outcome);
        }
      }
    } catch {
      setError("The assistant is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-hairline bg-black/[0.015] p-4" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={15} className="text-cyan" aria-hidden />
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <div className="ml-auto flex flex-wrap gap-1.5" role="tablist">
          {modes.map((m) => (
            <button key={m} role="tab" aria-selected={m === mode} onClick={() => setMode(m)}
              className={`rounded-full border px-2.5 py-1 text-[11.5px] ${m === mode ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-hairline text-text-secondary hover:bg-black/[0.03]"}`}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {(mode === "CHART_QA" || (mode === "EXPLAIN_REPORT" && documentId)) && (
          <input value={question} onChange={(e) => setQuestion(e.target.value.slice(0, 1000))} onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder={mode === "CHART_QA" ? "e.g. What was the latest creatinine?" : "A question about this report (optional)"} aria-label="Question"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
        )}
        {patient && (
          <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language" className="rounded-md border border-hairline bg-transparent px-2 py-2 text-[12.5px]">
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        )}
        <button onClick={ask} disabled={busy || (mode === "EXPLAIN_REPORT" && !documentId)} className="rounded-md bg-cyan px-4 py-1.5 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-50">
          {busy ? "Working…" : mode === "CHART_QA" ? "Ask" : "Generate"}
        </button>
      </div>
      {mode === "EXPLAIN_REPORT" && !documentId && <p className="mt-2 text-[12px] text-text-secondary">Choose a report to explain.</p>}

      {error && <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-red"><AlertTriangle size={13} aria-hidden /> {error}</p>}
      {label && (
        <div className="mt-3 rounded-xl border border-amber/30 bg-amber/5 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber"><ShieldCheck size={12} aria-hidden /> {label}</p>
          <ol className="mt-2 space-y-1.5" aria-live="polite">
            {sentences.map((s, i) => (
              <li key={i} className={`text-[13px] leading-snug ${s.kind === "GUIDANCE" ? "text-text-secondary" : ""}`}>
                {s.text}
                {s.citations.map((n) => <sup key={n} className="ml-0.5 text-[10px] text-cyan">[{n}]</sup>)}
                {s.labels.length > 0 && <span className="ml-1.5 inline-flex flex-wrap gap-1">{s.labels.map((l) => <span key={l} className="rounded border border-hairline px-1 text-[10px] text-text-secondary">{l}</span>)}</span>}
              </li>
            ))}
          </ol>
          {outcome && outcome !== "ANSWERED" && <p className="mt-2 text-[12px] text-text-secondary">{OUTCOME_TEXT[outcome] ?? outcome}</p>}
          {citations.length > 0 && (
            <div className="mt-3 border-t border-hairline pt-2">
              <p className="text-[11px] font-medium text-text-secondary">Sources</p>
              <ul className="mt-1 space-y-0.5">
                {citations.map((c) => (
                  <li key={c.n} className="text-[11.5px]">
                    <span className="text-cyan">[{c.n}]</span>{" "}
                    {patient ? <span>{c.title}</span> : <a className="underline-offset-2 hover:underline" href={c.link}>{c.title}</a>}
                    <span className="ml-1 text-text-secondary">· {c.origin === "VERIFIED" ? "verified" : "patient-provided"}{c.handwritten ? " · handwritten" : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
