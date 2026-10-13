"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PillToggle } from "@/components/auth/PillToggle";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { Role as AccountRole } from "@prisma/client";
import { resolveLoginDestination } from "@/lib/auth/roleDestination";

type Role = "patient" | "doctor" | "lab" | "hospital";
type Mode = "signin" | "signup";

const inputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function buildRoleOptions(t: (key: string) => string): { id: Role; label: string }[] {
  return [
    { id: "patient", label: t("login.role.patient") },
    { id: "doctor", label: t("login.role.doctor") },
    { id: "lab", label: t("login.role.lab") },
    { id: "hospital", label: t("login.role.hospital") },
  ];
}
function buildModeOptions(t: (key: string) => string): { id: Mode; label: string }[] {
  return [
    { id: "signin", label: t("login.mode.signin") },
    { id: "signup", label: t("login.mode.signup") },
  ];
}

function buildEyebrow(t: (key: string) => string): Record<Role, string> {
  return {
    patient: t("login.eyebrow.patient"),
    doctor: t("login.eyebrow.doctor"),
    lab: t("login.eyebrow.lab"),
    hospital: t("login.eyebrow.hospital"),
  };
}

function buildSubtitle(t: (key: string) => string): Record<Role, string> {
  return {
    patient: t("login.subtitle.patient"),
    doctor: t("login.subtitle.doctor"),
    lab: t("login.subtitle.lab"),
    hospital: t("login.subtitle.hospital"),
  };
}

export default function LoginPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const push = useToastStore((s) => s.push);

  const [role, setRole] = useState<Role>("patient");
  const [mode, setMode] = useState<Mode>("signin");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [sex, setSex] = useState("female");
  const [confirmPassword, setConfirmPassword] = useState("");

  const ROLE_OPTIONS = buildRoleOptions(t);
  const MODE_OPTIONS = buildModeOptions(t);
  const EYEBROW = buildEyebrow(t);
  const SUBTITLE = buildSubtitle(t);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  function switchRole(next: Role) {
    setRole(next);
    setError(null);
  }

  // Every tab signs in against the real auth backend. The role tab only
  // changes copy: the destination comes from the role the SERVER returns,
  // and each destination re-verifies authorization on its own.
  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/scholar-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Sign-in failed.");
        return;
      }
      const accountRole = data.role as AccountRole;
      push(
        accountRole === "PATIENT" ? t("login.toast.welcomeBackPatient") : t("login.toast.welcomeBackHospital"),
        "emerald"
      );
      router.push(resolveLoginDestination(accountRole));
      router.refresh();
    } catch {
      setError("Sign-in failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Only patients self-register. Clinician, lab and hospital accounts are
  // issued (and credential-checked) by a facility administrator in Hospital
  // OS, so there is no self-service form for them to fake.
  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t("login.error.passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/patient/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: name, email, password, sex, phone: phone || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Registration failed.");
        return;
      }
      push(t("login.toast.accountCreated"), "emerald");
      router.push("/patient");
      router.refresh();
    } catch {
      setError("Registration failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const staffSignup = mode === "signup" && role !== "patient";

  return (
    <AuthLayout
      eyebrow={EYEBROW[role]}
      title={mode === "signin" ? t("login.title.signin") : t("login.title.signup")}
      subtitle={SUBTITLE[role]}
      footer={
        <p className="text-center text-[12px] text-text-tertiary">
          {t("login.footer.adminPrompt")}{" "}
          <Link href="/admin/login" className="text-cyan hover:underline">
            {t("login.footer.adminLink")}
          </Link>
        </p>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PillToggle groupId="role" options={ROLE_OPTIONS} value={role} onChange={switchRole} />
        <PillToggle groupId="mode" options={MODE_OPTIONS} value={mode} onChange={switchMode} />
      </div>

      {staffSignup ? (
        <div className="mt-6 rounded-xl border border-hairline bg-black/[0.02] p-4 text-[13px] leading-relaxed text-text-secondary">
          {t("login.signup.staffNotice")}{" "}
          <button type="button" onClick={() => switchMode("signin")} className="text-cyan hover:underline">
            {t("login.mode.signin")}
          </button>
        </div>
      ) : (
        <form onSubmit={mode === "signin" ? handleSignIn : handleSignUp} className="mt-6 space-y-4">
          {mode === "signup" && (
            <Field label={t("login.field.fullName")}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                className={inputClass}
                placeholder={t("login.placeholder.fullName")}
              />
            </Field>
          )}

          <Field label={t("login.field.email")}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
              placeholder={t("login.placeholder.email")}
            />
          </Field>

          {mode === "signup" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("login.field.phone")}>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClass}
                  placeholder={t("login.placeholder.phone")}
                />
              </Field>
              <Field label={t("login.field.sex")}>
                <select value={sex} onChange={(e) => setSex(e.target.value)} className={inputClass}>
                  <option value="female">{t("login.sex.female")}</option>
                  <option value="male">{t("login.sex.male")}</option>
                  <option value="other">{t("login.sex.other")}</option>
                </select>
              </Field>
            </div>
          )}

          <Field label={t("login.field.password")}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "signup" ? 8 : undefined}
              className={inputClass}
              placeholder={t("login.placeholder.password")}
            />
          </Field>

          {mode === "signup" && (
            <Field label={t("login.field.confirmPassword")}>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className={inputClass}
                placeholder={t("login.placeholder.password")}
              />
            </Field>
          )}

          {mode === "signin" && (
            <div className="flex justify-end">
              <Link href="/forgot-password" className="text-[11.5px] text-text-tertiary hover:text-cyan">
                {t("login.forgotPassword")}
              </Link>
            </div>
          )}

          {error && <p className="text-[12.5px] text-red">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
          >
            {mode === "signin" ? t("login.submit.signin") : t("login.submit.createAccount")}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
