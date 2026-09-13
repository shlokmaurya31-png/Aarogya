"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";

const HOSPITAL_ROLES = ["HOSPITAL_ADMIN", "DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK", "AAROGYA_ADMIN"];
const isDev = process.env.NODE_ENV !== "production";

export default function HospitalOsLoginPage() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/scholar-auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { push(data.error ?? "Sign-in failed.", "red"); return; }
      if (!HOSPITAL_ROLES.includes(data.role)) { push("This account isn't a Hospital OS account.", "amber"); return; }
      router.push("/hospital-os");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-surface lg:grid-cols-2">
      <ToastViewport />

      {/* Brand panel (desktop) */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-brand-strong p-10 text-on-brand lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-white/15">
            <Building2 size={20} />
          </span>
          <span className="text-[16px] font-semibold tracking-tight">Aarogya Hospital OS</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-balance">
            The operating system for modern Indian healthcare.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-on-brand/80">
            One platform for admissions, wards, diagnostics, pharmacy, billing and
            interoperability — built for clinical speed and patient safety.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[12.5px] text-on-brand/80">
          <ShieldCheck size={15} /> ABDM-ready · consent-driven · audited
        </div>
      </div>

      {/* Form */}
      <div className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand-strong text-on-brand">
              <Building2 size={18} />
            </span>
            <span className="type-heading">Aarogya Hospital OS</span>
          </div>

          <h2 className="type-title">Sign in</h2>
          <p className="mt-1 type-secondary">Aarogya Medical Centre</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <Field label="Email" htmlFor="email">
              <Input id="email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" required placeholder="you@facility.org" />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required placeholder="••••••••" />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {isDev && (
            <div className="mt-6 rounded-surface border border-hairline bg-fill-subtle p-3.5 text-[11px] leading-relaxed text-text-tertiary">
              <p className="font-medium text-text-secondary">Demo accounts (dev only · password Hospital@123)</p>
              <p className="mt-1.5">admin@amc-demo.aarogya <span className="text-text-tertiary/70">Hospital Admin</span></p>
              <p>doctor1@amc-demo.aarogya <span className="text-text-tertiary/70">Doctor</span></p>
              <p>nurse1@amc-demo.aarogya <span className="text-text-tertiary/70">Nurse</span></p>
              <p className="mt-1">labtech@ · radtech@ · billing@amc-demo.aarogya</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
