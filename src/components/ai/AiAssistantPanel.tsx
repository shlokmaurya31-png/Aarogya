"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, Mic, ArrowUp, TriangleAlert } from "lucide-react";
import { StreamingText } from "./StreamingText";
import { useUiStore } from "@/store/useUiStore";

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

export function AiAssistantPanel() {
  const [value, setValue] = useState("");
  const mode = useUiStore((s) => s.mode);
  const content = CONTENT[mode];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-[20px] border border-hairline bg-card p-5"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan/25 bg-cyan/10">
          <Sparkles size={14} className="text-cyan" />
        </div>
        <div>
          <p className="text-[13px] font-medium">{content.title}</p>
          <p className="text-[11px] text-text-tertiary">{content.subtitle}</p>
        </div>
      </div>

      {mode === "doctor" && (
        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber/25 bg-amber/[0.08] px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-[12px] leading-relaxed text-amber">
            Drug interaction flag: current ACE inhibitor (patient history) may interact with
            newly prescribed statin — consider dose adjustment.
          </p>
        </div>
      )}

      <div className="mt-3 rounded-2xl border border-hairline bg-white/[0.025] p-4">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          <StreamingText key={mode} text={content.message} />
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {content.suggestions.map((s) => (
          <button
            key={s}
            className="rounded-full border border-hairline px-3 py-1.5 text-[11px] text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-full border border-hairline bg-white/[0.02] px-4 py-2.5 transition focus-within:border-cyan/40">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={content.placeholder}
          className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-tertiary"
        />
        <button
          className="text-text-tertiary transition hover:text-cyan"
          aria-label="Voice input"
        >
          <Mic size={15} />
        </button>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan text-ink transition hover:scale-105 active:scale-95"
          aria-label="Send"
        >
          <ArrowUp size={13} />
        </button>
      </div>
    </motion.div>
  );
}
