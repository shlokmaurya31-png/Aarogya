"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";

const inputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";

export default function AdminLoginPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const signInAdmin = useAuthStore((s) => s.signInAdmin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await signInAdmin(email, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push(t("admin.login.welcomeBack"), "emerald");
    router.push("/admin");
  }

  return (
    <AuthLayout
      eyebrow={t("admin.login.eyebrow")}
      title={t("admin.login.title")}
      subtitle={t("admin.login.subtitle")}
      footer={
        <p className="text-center text-[12px] text-text-tertiary">
          {t("admin.login.notAdmin")}{" "}
          <Link href="/login" className="text-cyan hover:underline">
            {t("admin.login.goToPatientSignIn")}
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">{t("admin.login.emailLabel")}</span>
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
          <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">{t("admin.login.passwordLabel")}</span>
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
          disabled={submitting}
          className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
        >
          {submitting ? t("admin.login.checking") : t("admin.login.signIn")}
        </button>

        <p className="rounded-xl border border-amber/20 bg-amber/[0.06] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-amber">
          {t("admin.login.demoCredentials")}
        </p>
      </form>
    </AuthLayout>
  );
}
