"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Role } from "@prisma/client";
import { Card } from "@/components/ui/Card";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";
import { resolveLoginDestination } from "@/lib/auth/roleDestination";

/**
 * The one real front door into Aarogya. Authenticates against the same
 * backend every other real surface (Patient Portal, Scholar, Hospital OS)
 * already uses (`/api/scholar-auth/login`) and routes by the role the
 * server returned — not a role the visitor picks. Doctor/nurse/hospital
 * staff accounts are provisioned by an organization administrator, not
 * self-service, so there is no privileged-role signup here.
 */
export default function LoginPage() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [sex, setSex] = useState("female");
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
      push("Welcome back.", "emerald");
      router.push(resolveLoginDestination(data.role as Role));
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/patient/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, password, sex }),
      });
      const data = await res.json();
      if (!res.ok) {
        push(data.error ?? "Registration failed.", "red");
        return;
      }
      push("Account created.", "emerald");
      router.push(resolveLoginDestination("PATIENT"));
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <ToastViewport />
      <Card className="w-full max-w-sm rounded-[20px]">
        <div className="flex items-center gap-2 text-[15px] font-semibold">Aarogya</div>
        <p className="mt-1 text-[12.5px] text-text-secondary">Sign in to continue — patients, students, and hospital staff all use the same account.</p>

        <div className="mt-4 inline-flex rounded-md border border-hairline bg-black/[0.02] p-1">
          <button onClick={() => setMode("signin")} className={`rounded-md px-3 py-1 text-[11.5px] ${mode === "signin" ? "bg-cyan text-ink" : "text-text-secondary"}`}>
            Sign in
          </button>
          <button onClick={() => setMode("register")} className={`rounded-md px-3 py-1 text-[11.5px] ${mode === "register" ? "bg-cyan text-ink" : "text-text-secondary"}`}>
            New patient
          </button>
        </div>

        {mode === "signin" ? (
          <form onSubmit={handleSignIn} className="mt-4 space-y-3">
            <Field label="Email" value={email} onChange={setEmail} type="email" />
            <Field label="Password" value={password} onChange={setPassword} type="password" />
            <button type="submit" disabled={loading} className="w-full rounded-md bg-cyan py-2.5 text-[13px] font-medium text-ink hover:brightness-110 disabled:opacity-60">
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="mt-4 space-y-3">
            <Field label="Full name" value={fullName} onChange={setFullName} />
            <Field label="Email" value={email} onChange={setEmail} type="email" />
            <Field label="Password (min 8 characters)" value={password} onChange={setPassword} type="password" />
            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Sex</label>
              <select value={sex} onChange={(e) => setSex(e.target.value)} className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40">
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
            </div>
            <button type="submit" disabled={loading} className="w-full rounded-md bg-emerald py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60">
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        )}

        <p className="mt-5 text-[11px] leading-relaxed text-text-tertiary">
          Doctor, nurse, pharmacist, billing, or other hospital staff account? These are provisioned by your
          organization administrator — contact them for access, or reach out to Aarogya if your hospital is
          onboarding.{" "}
          <Link href="/student" className="text-cyan hover:underline">
            Student or educator?
          </Link>
        </p>
      </Card>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        required
        className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2.5 text-[13px] outline-none focus:border-cyan/40"
      />
    </div>
  );
}
