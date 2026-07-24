"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, Mic, ArrowUp, TriangleAlert, Paperclip, Loader2, FileUp } from "lucide-react";
import { StreamingText } from "./StreamingText";
import { useUiStore } from "@/store/useUiStore";
import { useToastStore } from "@/store/useToastStore";
import { useRecordsStore } from "@/store/useRecordsStore";
import { cn } from "@/lib/utils";
import type { ReportKind } from "@/types";

interface SpeechRecognitionResultLike {
  transcript: string;
}
interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultLike[][];
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
interface WindowWithSpeech extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

const CONTENT = {
  patient: {
    title: "Ask Aarogya",
    subtitle: "Here to help, anytime",
    message:
      "Your blood sugar has been a little high lately. Want some easy tips for managing it?",
    suggestions: [
      "What should I eat today?",
      "Remind me about my pills",
      "Am I doing okay?",
      "Talk to my doctor",
    ],
    placeholder: "Ask me anything about your health…",
  },
  doctor: {
    title: "Aarogya Clinical Intelligence",
    subtitle: "Reviewing Meera Kulkarni · Updated 2m ago",
    message:
      "8-year longitudinal history reviewed. HbA1c trending +0.4% over the last quarter; eGFR mildly reduced at 76 mL/min. No acute findings on current presentation.",
    suggestions: [
      "Summarize full history",
      "Check drug interactions",
      "Show lab trend",
      "Draft consultation note",
    ],
    placeholder: "Query patient history, labs, or interactions…",
  },
};

const ACKS = {
  patient: [
    "Got it — I'll keep an eye on that and let you know if anything changes.",
    "Noted, I've added that to your daily summary.",
    "I'll remind you at the right time. Anything else?",
    "Good question — I've flagged it for your next doctor visit too.",
  ],
  doctor: [
    "Pulling that up now — cross-referencing the last 8 years of records.",
    "No conflicting entries found. I'll flag anything relevant in the brief.",
    "Trend data refreshed — see the vitals panel for the full series.",
    "Noted. I'll draft that and attach it to the chart for review.",
  ],
};

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  loading?: boolean;
}

function nextId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function guessReportKind(filename: string): ReportKind {
  const lower = filename.toLowerCase();
  if (/scan|mri|ct|x-?ray|radiology/.test(lower)) return "radiology";
  if (/discharge/.test(lower)) return "discharge";
  if (/prescription|rx/.test(lower)) return "prescription";
  return "lab";
}

const ANALYSIS_LINE: Record<ReportKind, string> = {
  lab: "Values look broadly within expected ranges, with one or two markers worth keeping an eye on.",
  radiology: "Nothing acute stands out at a glance — worth a radiologist's confirmation at your next visit.",
  discharge: "Summary captured, and the follow-up items have been noted for you.",
  prescription: "Medication details captured and cross-checked against what you're already taking.",
};

export function AiAssistantPanel() {
  const [value, setValue] = useState("");
  const [listening, setListening] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const mode = useUiStore((s) => s.mode);
  const content = CONTENT[mode];
  const push = useToastStore((s) => s.push);
  const addReport = useRecordsStore((s) => s.addReport);
  const addNotification = useRecordsStore((s) => s.addNotification);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: nextId(), role: "ai", text: CONTENT[mode].message },
  ]);

  useEffect(() => {
    setMessages([{ id: nextId(), role: "ai", text: CONTENT[mode].message }]);
    setValue("");
  }, [mode]);

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  function handleSend(text?: string) {
    const toSend = (text ?? value).trim();
    if (!toSend) return;
    setMessages((m) => [...m, { id: nextId(), role: "user", text: toSend }]);
    setValue("");
    const replies = ACKS[mode];
    setTimeout(() => {
      const reply = replies[Math.floor(Math.random() * replies.length)];
      setMessages((m) => [...m, { id: nextId(), role: "ai", text: reply }]);
    }, 700);
  }

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SpeechRecognitionCtor =
      (window as WindowWithSpeech).SpeechRecognition ?? (window as WindowWithSpeech).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      push("Voice input isn't supported in this browser", "amber");
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function ingestFile(file: File) {
    const title = file.name.replace(/\.[^/.]+$/, "");
    const kind = guessReportKind(file.name);
    const loadingId = nextId();

    setMessages((m) => [
      ...m,
      { id: nextId(), role: "user", text: `📎 Uploaded ${file.name}` },
      { id: loadingId, role: "ai", text: "Reading and analyzing your report…", loading: true },
    ]);

    setTimeout(() => {
      const reportId = `up-${nextId()}`;
      addReport({
        id: reportId,
        title,
        kind,
        facility: "Uploaded by you",
        date: new Date().toISOString().slice(0, 10),
        sizeKb: Math.max(1, Math.round(file.size / 1024)),
        verified: false,
      });
      addNotification({
        id: `note-${reportId}`,
        kind: "lab",
        title: "New record uploaded",
        detail: `${title} — analyzed by Aarogya AI and added to your records`,
        time: "Just now",
        risk: "watch",
      });
      setMessages((m) =>
        m.map((msg) =>
          msg.id === loadingId
            ? {
                id: loadingId,
                role: "ai",
                text: `I've reviewed "${title}". ${ANALYSIS_LINE[kind]} I've added it to your records — your doctor will see it at your next visit.`,
              }
            : msg
        )
      );
      push("Record analyzed and added to your health records", "emerald");
    }, 1600);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) ingestFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) ingestFile(file);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-[20px] border border-hairline bg-card p-5"
    >
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan/25 bg-cyan/10">
            <Sparkles size={14} className="text-cyan" />
          </div>
          <div>
            <p className="text-[13px] font-medium">{content.title}</p>
            <p className="text-[11px] text-text-tertiary">{content.subtitle}</p>
          </div>
        </div>
        {mode === "patient" && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-cyan px-3.5 py-2 text-[12px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <FileUp size={13} /> Upload a record
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf"
        onChange={handleFileChange}
        className="hidden"
      />

      {mode === "doctor" && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber/25 bg-amber/[0.08] px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-[12px] leading-relaxed text-amber">
            Drug interaction flag: current ACE inhibitor (patient history) may interact with
            newly prescribed statin — consider dose adjustment.
          </p>
        </div>
      )}

      <div
        onDragOver={(e) => {
          if (mode === "patient") {
            e.preventDefault();
            setDragActive(true);
          }
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={mode === "patient" ? handleDrop : undefined}
        className={cn(
          "mt-3 max-h-[260px] min-h-[220px] space-y-2 overflow-y-auto rounded-2xl border p-4 transition-colors",
          dragActive ? "border-cyan/50 bg-cyan/[0.06]" : "border-hairline bg-black/[0.03]"
        )}
      >
        {messages.map((m, i) => (
          <p
            key={m.id}
            className={cn(
              "flex items-center gap-1.5 text-[13px] leading-relaxed",
              m.role === "user" ? "justify-end text-right font-medium text-text-primary" : "text-text-secondary"
            )}
          >
            {m.loading && <Loader2 size={12} className="shrink-0 animate-spin text-cyan" />}
            {m.role === "ai" && !m.loading && i === messages.length - 1 ? (
              <StreamingText key={m.id} text={m.text} />
            ) : (
              m.text
            )}
          </p>
        ))}
        {mode === "patient" && (
          <p className="pt-1 text-center text-[11px] text-text-tertiary">
            Drop a file here or use Upload a record above
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {content.suggestions.map((s) => (
          <button
            key={s}
            onClick={() => handleSend(s)}
            className="rounded-full border border-hairline px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-full border border-hairline bg-black/[0.025] px-4 py-2.5 transition focus-within:border-cyan/40">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          placeholder={content.placeholder}
          className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-tertiary"
        />
        {mode === "patient" && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-text-tertiary transition hover:text-cyan"
            aria-label="Upload a record"
          >
            <Paperclip size={15} />
          </button>
        )}
        <button
          onClick={toggleMic}
          className={cn(
            "transition hover:text-cyan",
            listening ? "animate-pulse text-cyan" : "text-text-tertiary"
          )}
          aria-label="Voice input"
          aria-pressed={listening}
        >
          <Mic size={15} />
        </button>
        <button
          onClick={() => handleSend()}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan text-ink transition hover:scale-105 active:scale-95"
          aria-label="Send"
        >
          <ArrowUp size={13} />
        </button>
      </div>
    </motion.div>
  );
}
