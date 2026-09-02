"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

export function AdminScholarSignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.aarogya");
  const [password, setPassword] = useState("Scholar@123");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scholar-auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Sign-in failed."); return; }
      if (data.role !== "AAROGYA_ADMIN") { setError("This account is not a Scholar admin account."); return; }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="rounded-[20px]">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="mt-1.5 w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
        </div>
        {error && <p className="text-[12px] text-red">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-md bg-cyan py-2 text-[13px] font-medium text-ink hover:brightness-110 disabled:opacity-60">
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
