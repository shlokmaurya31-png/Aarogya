"use client";

import { useEffect, useState } from "react";
import { Send, MessageSquareText } from "lucide-react";
import { Card } from "@/components/ui/Card";

interface CaseOption { id: string; title: string; specialty: string }

export function VivaStandalone() {
  const [cases, setCases] = useState<CaseOption[]>([]);
  const [caseId, setCaseId] = useState<string>("");
  const [transcript, setTranscript] = useState<{ prompt: string; studentAnswer: string }[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/student/cases").then((r) => r.json()).then((d) => setCases(d.cases ?? []));
  }, []);

  async function askNext(nextTranscript: { prompt: string; studentAnswer: string }[]) {
    setLoading(true);
    try {
      const res = await fetch("/api/student/viva", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, transcript: nextTranscript, type: "next" }),
      });
      const data = await res.json();
      setQuestion(data.complete ? null : data.question?.prompt ?? null);
    } finally {
      setLoading(false);
    }
  }

  function startViva() {
    setTranscript([]);
    setFeedback(null);
    askNext([]);
  }

  function submitAnswer() {
    if (!question || !input.trim()) return;
    const next = [...transcript, { prompt: question, studentAnswer: input }];
    setTranscript(next);
    setInput("");
    setQuestion(null);
    askNext(next);
  }

  async function finish() {
    const res = await fetch("/api/student/viva", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId, transcript, type: "feedback" }),
    });
    const data = await res.json();
    setFeedback(data.feedback);
    setQuestion(null);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Viva AI</h1>
      <p className="mt-1 text-[13px] text-text-secondary">Free-practice oral examination. Pick a case and defend your clinical reasoning, one question at a time.</p>

      <Card className="mt-5 rounded-[20px]">
        <div className="flex flex-wrap items-center gap-2">
          <select value={caseId} onChange={(e) => { setCaseId(e.target.value); setTranscript([]); setQuestion(null); setFeedback(null); }} className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[12.5px] outline-none focus:border-cyan/40">
            <option value="">Select a case...</option>
            {cases.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.specialty})</option>)}
          </select>
          <button onClick={startViva} disabled={!caseId || loading} className="flex items-center gap-1.5 rounded-md bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink hover:brightness-110 disabled:opacity-40">
            <MessageSquareText size={13} /> Start viva
          </button>
        </div>

        {transcript.length > 0 && (
          <div className="mt-5 space-y-2.5">
            {transcript.map((t, i) => (
              <div key={i} className="space-y-1">
                <p className="text-[12.5px] text-text-tertiary">Examiner: {t.prompt}</p>
                <p className="rounded-md bg-black/[0.03] px-2.5 py-1.5 text-[12.5px]">You: {t.studentAnswer}</p>
              </div>
            ))}
          </div>
        )}

        {loading && <p className="mt-4 text-[12px] text-text-tertiary">Examiner is thinking...</p>}

        {question && (
          <div className="mt-4">
            <p className="text-[12.5px] font-medium text-cyan">Examiner: {question}</p>
            <div className="mt-2 flex gap-2">
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAnswer()} placeholder="Your answer..." className="flex-1 rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[12.5px] outline-none focus:border-cyan/40" />
              <button onClick={submitAnswer} className="rounded-md bg-cyan px-3 py-2 text-ink"><Send size={13} /></button>
            </div>
          </div>
        )}

        {transcript.length >= 2 && !question && !feedback && (
          <button onClick={finish} className="mt-4 rounded-md border border-hairline-strong px-4 py-1.5 text-[12.5px] font-medium hover:border-cyan/40 hover:text-cyan">
            Finish & get feedback
          </button>
        )}

        {feedback && (
          <div className="mt-4 rounded-md bg-emerald/10 p-3 text-[12.5px] text-emerald">{feedback}</div>
        )}
      </Card>
    </div>
  );
}
