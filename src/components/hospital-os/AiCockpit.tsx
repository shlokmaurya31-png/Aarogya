"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Sparkles, Stethoscope, ClipboardCheck, Siren, BedDouble, Microscope, Wrench,
  Pill, Receipt, LayoutGrid, ArrowRight, Brain, ShieldCheck, FileText, Activity,
} from "lucide-react";
import { AiConversation, configForRole } from "@/components/ai/PortalAssistant";

/**
 * AiCockpit — the AI-first home of Hospital OS. AI leads; the rest of the OS
 * is reachable from here as quick actions. Purely additive: every existing
 * page/route is untouched and still linked.
 */

type Quick = { href: string; label: string; icon: typeof LayoutGrid };

const COMMON_QUICK: Quick[] = [
  { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
  { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
  { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
  { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  { href: "/hospital-os/operations", label: "Operations", icon: Wrench },
];

const ROLE_QUICK: Record<string, Quick[]> = {
  DOCTOR: [{ href: "/hospital-os/doctor", label: "My Patients", icon: Stethoscope }, ...COMMON_QUICK],
  NURSE: [{ href: "/hospital-os/nurse", label: "My Shift", icon: ClipboardCheck }, ...COMMON_QUICK],
  PHARMACIST: [
    { href: "/hospital-os/pharmacy", label: "Pharmacy", icon: Pill },
    { href: "/hospital-os/inventory", label: "Inventory", icon: LayoutGrid },
  ],
  BILLING_STAFF: [
    { href: "/hospital-os/billing", label: "Billing", icon: Receipt },
    { href: "/hospital-os/claims", label: "Claims", icon: ShieldCheck },
  ],
  LAB_TECHNICIAN: [
    { href: "/hospital-os/lab", label: "Lab Queue", icon: Microscope },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  RADIOLOGY_TECH: [
    { href: "/hospital-os/radiology", label: "Imaging Queue", icon: Microscope },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  FRONT_DESK: [
    { href: "/hospital-os/front-desk", label: "Front Desk", icon: ClipboardCheck },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
  ],
};

const CAPABILITIES = [
  { icon: Brain, title: "Understands context", body: "Knows the page you're on and the workspace you run." },
  { icon: FileText, title: "Drafts & summarises", body: "Histories, notes, handovers — drafted in seconds." },
  { icon: Activity, title: "Surfaces what matters", body: "Flags trends, interactions and risks before you ask." },
];

export function AiCockpit({
  role,
  displayName,
  facilityName,
}: {
  role: string;
  displayName: string;
  facilityName: string;
}) {
  const config = configForRole(role, displayName);
  const quick = ROLE_QUICK[role] ?? COMMON_QUICK;
  const firstName = displayName.trim().split(/\s+/)[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="relative overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.08] via-transparent to-brand/[0.06] p-6 sm:p-8"
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full bg-cyan/10 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-[11px] font-medium text-cyan">
            <Sparkles size={12} /> AI-Native Hospital OS
          </span>
          <h1 className="mt-4 text-[26px] font-semibold tracking-tight sm:text-[32px]">
            {greeting}, {firstName}.
          </h1>
          <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-text-secondary">
            This is <span className="font-medium text-text-primary">Aarogya AI</span> — the intelligence at
            the head of {facilityName}. Ask it anything, or jump straight into your work below.
          </p>
        </div>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* Primary: the AI itself */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-3xl border border-hairline bg-card p-5 sm:p-6"
        >
          <div className="mb-4 flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan/25 bg-cyan/10">
              <Sparkles size={16} className="text-cyan" />
            </div>
            <div>
              <p className="text-[14px] font-medium">{config.title}</p>
              <p className="text-[11.5px] text-text-tertiary">{config.subtitle}</p>
            </div>
          </div>
          <AiConversation config={config} pageLabel={`AI Cockpit · ${facilityName}`} minHeight={300} maxHeight={420} />
        </motion.div>

        {/* Secondary: quick actions + capabilities */}
        <div className="space-y-6">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-3xl border border-hairline bg-card p-5"
          >
            <p className="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">Jump to</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {quick.map((q) => (
                <Link
                  key={q.href + q.label}
                  href={q.href}
                  className="group flex items-center gap-2 rounded-xl border border-hairline px-3 py-2.5 text-[12.5px] text-text-secondary transition hover:border-cyan/40 hover:bg-cyan/[0.04] hover:text-text-primary"
                >
                  <q.icon size={15} className="shrink-0 text-cyan" />
                  <span className="min-w-0 flex-1 truncate">{q.label}</span>
                  <ArrowRight size={13} className="shrink-0 opacity-0 transition group-hover:opacity-100" />
                </Link>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-3xl border border-hairline bg-card p-5"
          >
            <p className="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">What Aarogya AI does</p>
            <div className="mt-3 space-y-3">
              {CAPABILITIES.map((c) => (
                <div key={c.title} className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-black/[0.03]">
                    <c.icon size={15} className="text-cyan" />
                  </div>
                  <div>
                    <p className="text-[13px] font-medium">{c.title}</p>
                    <p className="text-[12px] leading-relaxed text-text-tertiary">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
