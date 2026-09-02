"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";

const HOSPITAL_ROLES = ["HOSPITAL_ADMIN", "DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "AAROGYA_ADMIN"];

export default function HospitalOsLoginPage() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [email, setEmail] = useState("doctor1@amc-demo.aarogya");
  const [password, setPassword] = useState("Hospital@123");
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
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <ToastViewport />
      <Card className="w-full max-w-sm rounded-[20px]">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <Building2 size={18} className="text-cyan" /> Aarogya Hospital OS
        </div>
        <p className="mt-1 text-[12.5px] text-text-secondary">Aarogya Medical Centre</p>
        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Password</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40" />
          </div>
          <button type="submit" disabled={loading} className="w-full rounded-md bg-cyan py-2.5 text-[13px] font-medium text-ink hover:brightness-110 disabled:opacity-60">
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <div className="mt-5 rounded-md border border-hairline bg-black/[0.02] p-3 text-[11px] leading-relaxed text-text-tertiary">
          <p className="font-medium text-text-secondary">Demo accounts (dev only, password Hospital@123)</p>
          <p className="mt-1">admin@amc-demo.aarogya (Hospital Admin)</p>
          <p>doctor1@amc-demo.aarogya (Doctor)</p>
          <p>nurse1@amc-demo.aarogya (Nurse)</p>
          <p>labtech@amc-demo.aarogya · radtech@amc-demo.aarogya · billing@amc-demo.aarogya</p>
        </div>
      </Card>
    </div>
  );
}
