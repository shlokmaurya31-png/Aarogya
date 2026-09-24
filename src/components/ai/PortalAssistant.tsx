"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X, Mic, ArrowUp, Loader2, TriangleAlert, Command } from "lucide-react";
import { StreamingText } from "./StreamingText";
import { cn } from "@/lib/utils";

/**
 * PortalAssistant — "Aarogya AI", the head of the product. Made portable so
 * every logged-in area (patient portal, Hospital OS, Scholar) leads with the
 * same AI. Self-contained: takes a `role`, does not depend on the demo zustand
 * stores. Talks to /api/chat and degrades gracefully to a canned reply when the
 * AI service is unavailable (e.g. no ANTHROPIC_API_KEY / no credit balance).
 *
 * Exposes:
 *  - <AiAssistantProvider>  wraps a portal; renders the floating launcher +
 *    slide-up panel once and shares open state via context (so a top-bar
 *    command bar and the launcher control the same panel). Adds a ⌘K shortcut.
 *  - useAiAssistant()       { open, close, toggle } for any child (command bar).
 *  - <AiCommandBar>         the always-on "Ask Aarogya anything…" bar.
 *  - <PortalAssistant>      backward-compatible launcher-only usage.
 *  - <AiConversation>       the reusable chat body (used by the panel + cockpit).
 *  - configForRole()        role → copy/mode, shared with the cockpit.
 */

// The /api/chat route only distinguishes "patient" from everything-else
// ("doctor" clinical briefing). Map each portal role onto one of those.
type ChatMode = "patient" | "doctor";

export interface AssistantConfig {
  mode: ChatMode;
  title: string;
  subtitle: string;
  greeting: string;
  suggestions: string[];
  placeholder: string;
  /** Shown as a small caution banner (clinical roles only). */
  caution?: string;
}

export function configForRole(role: string, displayName?: string): AssistantConfig {
  const firstName = displayName?.trim().split(/\s+/)[0];

  if (role === "PATIENT") {
    return {
      mode: "patient",
      title: "Aarogya AI",
      subtitle: "Your personal health intelligence",
      greeting: firstName
        ? `Hi ${firstName}, I'm Aarogya AI — here for your health, appointments, medicines, reports and bills. What's on your mind?`
        : "Hi, I'm Aarogya AI — here for your health, appointments, medicines, reports and bills. What's on your mind?",
      suggestions: [
        "Explain my latest report",
        "When is my next appointment?",
        "Remind me about my medicines",
        "How do I book a bed in an emergency?",
      ],
      placeholder: "Ask Aarogya anything about your health…",
    };
  }

  if (role === "STUDENT") {
    return {
      mode: "doctor",
      title: "Aarogya AI",
      subtitle: "Your clinical reasoning tutor",
      greeting:
        "I'm Aarogya AI. Ask me to explain a case, quiz you viva-style, or walk through a differential.",
      suggestions: [
        "Quiz me on this case",
        "Explain the differential",
        "What labs would you order?",
        "Give me a viva question",
      ],
      placeholder: "Ask about a case, drug, or diagnosis…",
    };
  }

  // Clinical / operational staff roles → clinical intelligence briefing.
  const isClinical = role === "DOCTOR" || role === "NURSE";
  return {
    mode: "doctor",
    title: "Aarogya AI",
    subtitle: isClinical ? "Chart-aware clinical intelligence" : "Your Hospital OS intelligence",
    greeting: isClinical
      ? "I'm Aarogya AI. I can summarise histories, flag interactions, surface lab trends, and draft notes. What do you need?"
      : "I'm Aarogya AI. I can help you run the hospital — summarise the workspace, surface what needs attention, and answer operational questions.",
    suggestions: isClinical
      ? [
          "Summarize this patient's history",
          "Check drug interactions",
          "Show recent lab trends",
          "Draft a consultation note",
        ]
      : [
          "What needs my attention today?",
          "Summarize this workspace",
          "How do I use this page?",
          "Where do I find claims?",
        ],
    placeholder: isClinical ? "Query history, labs, or interactions…" : "Ask Aarogya about the hospital…",
    caution: isClinical
      ? "AI guidance supports, but does not replace, your clinical judgment. Verify before acting."
      : undefined,
  };
}

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  loading?: boolean;
}

const FALLBACKS: Record<ChatMode, string[]> = {
  patient: [
    "I can't reach the assistant service right now, but I've noted your question. Please try again in a moment.",
    "The AI service seems to be offline at the moment. Your care team is always available in the meantime.",
  ],
  doctor: [
    "The assistant service is unavailable right now. Please retry shortly.",
    "I can't reach the clinical intelligence service at the moment. Try again in a bit.",
  ],
};

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

function nextId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The reusable conversation body: message list, suggestion chips, and the
 * composer (text + voice + send). Shared by the floating panel and the
 * full-page AI Cockpit so both behave identically.
 */
export function AiConversation({
  config,
  pageLabel,
  minHeight = 220,
  maxHeight = 260,
  seedPrompt,
}: {
  config: AssistantConfig;
  pageLabel?: string;
  minHeight?: number;
  maxHeight?: number;
  /** When set, this prompt is auto-sent once on mount. */
  seedPrompt?: string;
}) {
  const [value, setValue] = useState("");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: nextId(), role: "ai", text: config.greeting },
  ]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  async function handleSend(text?: string) {
    const toSend = (text ?? value).trim();
    if (!toSend) return;
    setMessages((m) => [...m, { id: nextId(), role: "user", text: toSend }]);
    setValue("");

    const loadingId = nextId();
    setMessages((m) => [...m, { id: loadingId, role: "ai", text: "", loading: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: toSend, mode: config.mode, page: pageLabel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Request failed");
      setMessages((m) =>
        m.map((msg) => (msg.id === loadingId ? { id: loadingId, role: "ai", text: data.text } : msg))
      );
    } catch {
      const replies = FALLBACKS[config.mode];
      const fallback = replies[Math.floor(Math.random() * replies.length)];
      setMessages((m) =>
        m.map((msg) => (msg.id === loadingId ? { id: loadingId, role: "ai", text: fallback } : msg))
      );
    }
  }

  useEffect(() => {
    if (seedPrompt && !seededRef.current) {
      seededRef.current = true;
      handleSend(seedPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPrompt]);

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Ctor =
      (window as WindowWithSpeech).SpeechRecognition ??
      (window as WindowWithSpeech).webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
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

  return (
    <>
      {config.caution && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-amber/25 bg-amber/[0.08] px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-[12px] leading-relaxed text-amber">{config.caution}</p>
        </div>
      )}

      <div
        ref={scrollRef}
        style={{ minHeight, maxHeight }}
        className="space-y-2 overflow-y-auto rounded-2xl border border-hairline bg-black/[0.03] p-4"
      >
        {messages.map((m, i) => (
          <p
            key={m.id}
            className={cn(
              "flex items-center gap-1.5 text-[13px] leading-relaxed",
              m.role === "user"
                ? "justify-end text-right font-medium text-text-primary"
                : "text-text-secondary"
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
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {config.suggestions.map((s) => (
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
          placeholder={config.placeholder}
          className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-tertiary"
        />
        <button
          onClick={toggleMic}
          className={cn("transition hover:text-cyan", listening ? "animate-pulse text-cyan" : "text-text-tertiary")}
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
    </>
  );
}

function Panel({
  config,
  pageLabel,
  onClose,
}: {
  config: AssistantConfig;
  pageLabel?: string;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-[20px] border border-hairline bg-card p-5 shadow-lg"
    >
      <div className="mb-3 flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan/25 bg-cyan/10">
            <Sparkles size={14} className="text-cyan" />
          </div>
          <div>
            <p className="text-[13px] font-medium">{config.title}</p>
            <p className="text-[11px] text-text-tertiary">{config.subtitle}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close assistant"
          className="flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary transition hover:bg-black/[0.05] hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </div>
      <AiConversation config={config} pageLabel={pageLabel} />
    </motion.div>
  );
}

// ── Shared open-state context ────────────────────────────────────────────
interface AiAssistantControls {
  open: () => void;
  close: () => void;
  toggle: () => void;
}
const AiAssistantContext = createContext<AiAssistantControls | null>(null);

export function useAiAssistant(): AiAssistantControls {
  const ctx = useContext(AiAssistantContext);
  // No provider (shouldn't happen in wired portals) → no-op controls.
  return ctx ?? { open: () => {}, close: () => {}, toggle: () => {} };
}

export function AiAssistantProvider({
  role,
  displayName,
  pageLabel,
  children,
}: {
  role: string;
  displayName?: string;
  pageLabel?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const config = configForRole(role, displayName);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const controls: AiAssistantControls = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen((o) => !o),
  };

  return (
    <AiAssistantContext.Provider value={controls}>
      {children}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-24 right-5 z-[60] w-[calc(100vw-2.5rem)] max-w-[380px] sm:right-6"
          >
            <Panel config={config} pageLabel={pageLabel} onClose={() => setOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-[60] flex h-[52px] w-[52px] items-center justify-center rounded-full bg-cyan text-ink shadow-lg transition hover:brightness-110 active:scale-95 sm:right-6"
        aria-label={open ? "Close Aarogya AI" : "Open Aarogya AI"}
      >
        {open ? <X size={20} /> : <Sparkles size={20} />}
        {!open && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-ink bg-emerald" />
        )}
      </motion.button>
    </AiAssistantContext.Provider>
  );
}

/**
 * The always-on AI command bar for portal top bars. Clicking (or ⌘K) opens the
 * shared assistant panel. This is what makes AI the visible head of the OS.
 */
export function AiCommandBar({ className }: { className?: string }) {
  const { open } = useAiAssistant();
  return (
    <button
      onClick={open}
      className={cn(
        "focus-ring group flex h-9 items-center gap-2 rounded-full border border-cyan/30 bg-gradient-to-r from-cyan/10 to-transparent px-3.5 text-[12.5px] text-text-secondary transition-colors hover:border-cyan/50 hover:text-text-primary",
        className
      )}
      aria-label="Open Aarogya AI"
    >
      <Sparkles size={14} className="shrink-0 text-cyan" />
      <span className="hidden truncate sm:inline">Ask Aarogya anything…</span>
      <kbd className="ml-1 hidden items-center gap-0.5 rounded border border-hairline px-1 text-[10px] text-text-tertiary sm:flex">
        <Command size={9} /> K
      </kbd>
    </button>
  );
}

/** Backward-compatible launcher-only usage (patient & scholar portals). */
export function PortalAssistant({
  role,
  displayName,
  pageLabel,
}: {
  role: string;
  displayName?: string;
  pageLabel?: string;
}) {
  return <AiAssistantProvider role={role} displayName={displayName} pageLabel={pageLabel} />;
}
