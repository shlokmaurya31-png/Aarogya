"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";

const inputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";

export default function AdminLoginPage() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const signInAdmin = useAuthStore((s) => s.signInAdmin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = signInAdmin(email, password);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push("Welcome back, admin.", "emerald");
    router.push("/admin");
  }

  return (
    <AuthLayout
      eyebrow="Restricted access"
      title="Admin sign in"
      subtitle="Platform oversight — doctor verification, patients, and system health."
      footer={
        <p className="text-center text-[12px] text-text-tertiary">
          Not an admin?{" "}
          <Link href="/login" className="text-cyan hover:underline">
            Go to patient / doctor sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">Admin email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
            placeholder="admin@aarogya.ai"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={inputClass}
            placeholder="••••••••"
          />
        </label>

        {error && <p className="text-[12.5px] text-red">{error}</p>}

        <button
          type="submit"
          className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99]"
        >
          Sign in
        </button>

        <p className="rounded-xl border border-amber/20 bg-amber/[0.06] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-amber">
          Demo credentials — admin@aarogya.ai / admin123
        </p>
      </form>
    </AuthLayout>
  );
}
