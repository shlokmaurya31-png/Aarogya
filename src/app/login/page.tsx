"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { PillToggle } from "@/components/auth/PillToggle";
import { FileDropField } from "@/components/auth/FileDropField";
import { useAuthStore } from "@/store/useAuthStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useUiStore } from "@/store/useUiStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";

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
  const setUiMode = useUiStore((s) => s.setMode);
  const signInPatient = useAuthStore((s) => s.signInPatient);
  const signInDoctor = useAuthStore((s) => s.signInDoctor);
  const signInLab = useAuthStore((s) => s.signInLab);
  const signInHospital = useAuthStore((s) => s.signInHospital);
  const signUpPatient = useAuthStore((s) => s.signUpPatient);
  const signUpDoctor = useAuthStore((s) => s.signUpDoctor);
  const signUpLab = useAuthStore((s) => s.signUpLab);
  const signUpHospital = useAuthStore((s) => s.signUpHospital);

  const [role, setRole] = useState<Role>("patient");
  const [mode, setMode] = useState<Mode>("signin");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [facility, setFacility] = useState("");
  const [city, setCity] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

  const ROLE_OPTIONS = buildRoleOptions(t);
  const MODE_OPTIONS = buildModeOptions(t);
  const EYEBROW = buildEyebrow(t);
  const SUBTITLE = buildSubtitle(t);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setProofError(null);
  }

  function switchRole(next: Role) {
    setRole(next);
    setError(null);
    setProofError(null);
  }

  function enter(nextRole: Role) {
    if (nextRole === "lab") {
      router.push("/lab");
      return;
    }
    if (nextRole === "hospital") {
      router.push("/hospital");
      return;
    }
    setUiMode(nextRole);
    if (nextRole === "patient" && !usePatientStore.getState().profile) {
      router.push("/onboarding");
      return;
    }
    router.push("/dashboard");
  }

  function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result =
      role === "patient"
        ? signInPatient(email, password)
        : role === "doctor"
          ? signInDoctor(email, password)
          : role === "lab"
            ? signInLab(email, password)
            : signInHospital(email, password);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push(
      role === "doctor"
        ? t("login.toast.welcomeBackDoctor")
        : role === "lab"
          ? t("login.toast.welcomeBackLab")
          : role === "hospital"
            ? t("login.toast.welcomeBackHospital")
            : t("login.toast.welcomeBackPatient"),
      "emerald"
    );
    enter(role);
  }

  function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProofError(null);

    if (password !== confirmPassword) {
      setError(t("login.error.passwordMismatch"));
      return;
    }

    if (role === "patient") {
      const result = signUpPatient({ name, email, phone, password });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      push(t("login.toast.accountCreated"), "emerald");
      enter("patient");
      return;
    }

    if (!proofFile) {
      setProofError(
        role === "doctor"
          ? t("login.error.proofPractice")
          : role === "hospital"
            ? t("login.error.proofRegistration")
            : t("login.error.proofAccreditation")
      );
      return;
    }

    if (role === "doctor") {
      const result = signUpDoctor({ name, email, phone, specialty, registrationId, facility, password, proofFile });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      push(t("login.toast.applicationSubmitted"), "amber");
      enter("doctor");
      return;
    }

    if (role === "hospital") {
      const result = signUpHospital({ name, email, phone, city, registrationId, password, proofFile });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      push(t("login.toast.applicationSubmitted"), "amber");
      enter("hospital");
      return;
    }

    const result = signUpLab({ name, email, phone, registrationId, facility, password, proofFile });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push(t("login.toast.applicationSubmitted"), "amber");
    enter("lab");
  }

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

      <form onSubmit={mode === "signin" ? handleSignIn : handleSignUp} className="mt-6 space-y-4">
        {mode === "signup" && (
          <Field
            label={
              role === "lab"
                ? t("login.field.labName")
                : role === "hospital"
                  ? t("login.field.hospitalName")
                  : t("login.field.fullName")
            }
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className={inputClass}
              placeholder={
                role === "lab"
                  ? t("login.placeholder.labName")
                  : role === "hospital"
                    ? t("login.placeholder.hospitalName")
                    : t("login.placeholder.fullName")
              }
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
          <Field label={t("login.field.phone")}>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              className={inputClass}
              placeholder={t("login.placeholder.phone")}
            />
          </Field>
        )}

        {mode === "signup" && role === "doctor" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("login.field.specialty")}>
                <input
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  required
                  className={inputClass}
                  placeholder={t("login.placeholder.specialty")}
                />
              </Field>
              <Field label={t("login.field.registrationId")}>
                <input
                  value={registrationId}
                  onChange={(e) => setRegistrationId(e.target.value)}
                  required
                  className={inputClass}
                  placeholder={t("login.placeholder.registrationIdDoctor")}
                />
              </Field>
            </div>
            <Field label={t("login.field.hospitalFacility")}>
              <input
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                required
                className={inputClass}
                placeholder={t("login.placeholder.hospitalName")}
              />
            </Field>
            <FileDropField
              label={t("login.proof.practiceLabel")}
              hint={t("login.proof.practiceHint")}
              accept="image/*,.pdf"
              file={proofFile}
              onChange={(f) => {
                setProofFile(f);
                setProofError(null);
              }}
              error={proofError ?? undefined}
            />
          </>
        )}

        {mode === "signup" && role === "lab" && (
          <>
            <Field label={t("login.field.accreditationId")}>
              <input
                value={registrationId}
                onChange={(e) => setRegistrationId(e.target.value)}
                required
                className={inputClass}
                placeholder={t("login.placeholder.accreditationId")}
              />
            </Field>
            <Field label={t("login.field.branchAddress")}>
              <input
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                required
                className={inputClass}
                placeholder={t("login.placeholder.branchAddress")}
              />
            </Field>
            <FileDropField
              label={t("login.proof.accreditationLabel")}
              hint={t("login.proof.accreditationHint")}
              accept="image/*,.pdf"
              file={proofFile}
              onChange={(f) => {
                setProofFile(f);
                setProofError(null);
              }}
              error={proofError ?? undefined}
            />
          </>
        )}

        {mode === "signup" && role === "hospital" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("login.field.registrationId")}>
                <input
                  value={registrationId}
                  onChange={(e) => setRegistrationId(e.target.value)}
                  required
                  className={inputClass}
                  placeholder={t("login.placeholder.registrationIdHospital")}
                />
              </Field>
              <Field label={t("login.field.city")}>
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  required
                  className={inputClass}
                  placeholder={t("login.placeholder.city")}
                />
              </Field>
            </div>
            <FileDropField
              label={t("login.proof.registrationLabel")}
              hint={t("login.proof.registrationHint")}
              accept="image/*,.pdf"
              file={proofFile}
              onChange={(f) => {
                setProofFile(f);
                setProofError(null);
              }}
              error={proofError ?? undefined}
            />
          </>
        )}

        <Field label={t("login.field.password")}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "signup" ? 6 : undefined}
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
            <button
              type="button"
              onClick={() => push(t("login.toast.forgotPasswordUnavailable"), "amber")}
              className="text-[11.5px] text-text-tertiary hover:text-cyan"
            >
              {t("login.forgotPassword")}
            </button>
          </div>
        )}

        {error && <p className="text-[12.5px] text-red">{error}</p>}

        <button
          type="submit"
          className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99]"
        >
          {mode === "signin"
            ? t("login.submit.signin")
            : role === "patient"
              ? t("login.submit.createAccount")
              : t("login.submit.submitApplication")}
        </button>
      </form>
    </AuthLayout>
  );
}
