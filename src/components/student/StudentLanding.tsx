"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Stethoscope,
  Activity,
  FlaskConical,
  Pill,
  MessageSquareText,
  ShieldCheck,
  GraduationCap,
  ArrowRight,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";

const PILLARS = [
  { icon: Stethoscope, title: "Clinical Arena", desc: "Take a real history, examine, and build a differential before the diagnosis is ever revealed." },
  { icon: FlaskConical, title: "Diagnostic Lab", desc: "Order and interpret investigations with realistic turnaround and cost tradeoffs." },
  { icon: Pill, title: "RxLab", desc: "Write educational prescriptions checked against allergy, renal, hepatic and interaction rules." },
  { icon: MessageSquareText, title: "Viva AI", desc: "Defend your reasoning to an adaptive AI examiner, one question at a time." },
  { icon: Activity, title: "Emergency Arena", desc: "Sequence ABCDE decisions against a deteriorating simulated patient." },
  { icon: ShieldCheck, title: "Clinical Passport", desc: "Track verified competencies, achievements and rotations over your training." },
];

export function StudentLanding({ alreadySignedInOtherRole }: { alreadySignedInOtherRole: boolean }) {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [mode, setMode] = useState<"landing" | "signin">("landing");
  const [email, setEmail] = useState("student@demo.aarogya");
  const [password, setPassword] = useState("Scholar@123");
  const [loading, setLoading] = useState(false);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/scholar-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        push(data.error ?? "Sign-in failed.", "red");
        return;
      }
      if (data.role !== "STUDENT") {
        push("This account isn't a student account.", "amber");
        return;
      }
      router.push("/student/verify");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <ToastViewport />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <GraduationCap size={18} className="text-cyan" />
          Aarogya Scholar
        </Link>
        <div className="flex items-center gap-3 text-[12.5px] text-text-tertiary">
          <Link href="/" className="hover:text-text-secondary">Back to Aarogya</Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-10">
        {alreadySignedInOtherRole && (
          <div className="mb-6 rounded-lg border border-amber/30 bg-amber/10 px-4 py-2.5 text-[12.5px] text-amber">
            You&apos;re signed into a different Aarogya account. Sign in with a student account below to enter Aarogya Scholar.
          </div>
        )}

        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          <div>
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[44px]"
            >
              Learn medicine from cases<br />that think back.
            </motion.h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-text-secondary">
              Practice clinical reasoning, diagnosis, investigations, prescriptions and emergency
              decisions in realistic patient simulations designed for verified healthcare students —
              medicine, nursing, pharmacy, diagnostics, physiotherapy and public health.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setMode("signin")}
                className="flex items-center gap-2 rounded-full bg-cyan px-5 py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110"
              >
                Enter Aarogya Scholar <ArrowRight size={14} />
              </button>
              <Link
                href="/student/verify"
                className="rounded-full border border-hairline-strong px-5 py-2.5 text-[13px] text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
              >
                Explore Clinical Training
              </Link>
            </div>

            <p className="mt-4 text-[11.5px] text-text-tertiary">
              For education and simulation. Not for direct patient-care decisions. All cases are synthetic educational representations — see{" "}
              <Link href="/student/verify" className="underline hover:text-text-secondary">verification</Link>.
            </p>

            <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PILLARS.map((p) => (
                <Card key={p.title} className="rounded-lg bg-white/[0.03] border-white/10">
                  <p.icon size={16} className="text-cyan" />
                  <p className="mt-2.5 text-[13px] font-medium text-text-primary">{p.title}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-tertiary">{p.desc}</p>
                </Card>
              ))}
            </div>
          </div>

          <div>
            {mode === "signin" ? (
              <Card className="rounded-[20px] bg-white/[0.03] border-white/10">
                <p className="text-[15px] font-semibold">Sign in</p>
                <p className="mt-1 text-[12.5px] text-text-tertiary">Verified student, educator or admin account.</p>
                <form onSubmit={handleSignIn} className="mt-5 space-y-3">
                  <div>
                    <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Email</label>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                      required
                      className="mt-1.5 w-full rounded-md border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[13px] outline-none transition focus:border-cyan/50"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Password</label>
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      required
                      className="mt-1.5 w-full rounded-md border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[13px] outline-none transition focus:border-cyan/50"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-md bg-cyan py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110 disabled:opacity-60"
                  >
                    {loading ? "Signing in..." : "Sign in"}
                  </button>
                </form>
                <p className="mt-4 text-[11.5px] text-text-tertiary">
                  New here?{" "}
                  <Link href="/student/verify" className="text-cyan hover:underline">Start verification</Link>
                </p>
                <div className="mt-5 rounded-md border border-white/10 bg-white/[0.02] p-3 text-[11px] leading-relaxed text-text-tertiary">
                  <p className="font-medium text-text-secondary">Demo accounts (dev only)</p>
                  <p className="mt-1">student@demo.aarogya · student.nursing@demo.aarogya · student.pharmacy@demo.aarogya</p>
                  <p>Password for all: Scholar@123</p>
                </div>
              </Card>
            ) : (
              <Card className="rounded-[20px] bg-white/[0.03] border-white/10">
                <p className="text-[15px] font-semibold">Verified healthcare students only</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-text-tertiary">
                  MBBS, BDS, BAMS, BHMS, nursing, pharmacy, physiotherapy, diagnostics and other
                  healthcare programs. Verification uses institutional email, student ID, or manual
                  review — automated verification never guarantees legitimacy on its own; unusual
                  cases route to human review.
                </p>
                <button
                  onClick={() => setMode("signin")}
                  className="mt-5 w-full rounded-md bg-cyan py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110"
                >
                  Continue to sign in
                </button>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
