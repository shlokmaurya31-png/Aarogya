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

type Role = "patient" | "doctor" | "lab";
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

const ROLE_OPTIONS: { id: Role; label: string }[] = [
  { id: "patient", label: "Patient" },
  { id: "doctor", label: "Doctor" },
  { id: "lab", label: "Lab" },
];
const MODE_OPTIONS: { id: Mode; label: string }[] = [
  { id: "signin", label: "Sign in" },
  { id: "signup", label: "Sign up" },
];

const EYEBROW: Record<Role, string> = {
  patient: "Patient access",
  doctor: "Clinician access",
  lab: "Lab / diagnostics access",
};

const SUBTITLE: Record<Role, string> = {
  patient: "Your health record, your AI assistant, one place.",
  doctor: "Verified clinical access to patient charts, labs, and prescriptions.",
  lab: "Register accredited test reports directly into a patient's record.",
};

export default function LoginPage() {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const setUiMode = useUiStore((s) => s.setMode);
  const signInPatient = useAuthStore((s) => s.signInPatient);
  const signInDoctor = useAuthStore((s) => s.signInDoctor);
  const signInLab = useAuthStore((s) => s.signInLab);
  const signUpPatient = useAuthStore((s) => s.signUpPatient);
  const signUpDoctor = useAuthStore((s) => s.signUpDoctor);
  const signUpLab = useAuthStore((s) => s.signUpLab);

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
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

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
      role === "patient" ? signInPatient(email, password) : role === "doctor" ? signInDoctor(email, password) : signInLab(email, password);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push(`Welcome back${role === "doctor" ? ", doctor" : role === "lab" ? " to the lab portal" : ""}.`, "emerald");
    enter(role);
  }

  function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProofError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    if (role === "patient") {
      const result = signUpPatient({ name, email, phone, password });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      push("Account created. Welcome to Aarogya.", "emerald");
      enter("patient");
      return;
    }

    if (!proofFile) {
      setProofError(
        role === "doctor" ? "Upload a proof of practice document to continue." : "Upload a proof of accreditation to continue."
      );
      return;
    }

    if (role === "doctor") {
      const result = signUpDoctor({ name, email, phone, specialty, registrationId, facility, password, proofFile });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      push("Application submitted. Verification pending.", "amber");
      enter("doctor");
      return;
    }

    const result = signUpLab({ name, email, phone, registrationId, facility, password, proofFile });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    push("Application submitted. Verification pending.", "amber");
    enter("lab");
  }

  return (
    <AuthLayout
      eyebrow={EYEBROW[role]}
      title={mode === "signin" ? "Welcome back" : "Create your account"}
      subtitle={SUBTITLE[role]}
      footer={
        <p className="text-center text-[12px] text-text-tertiary">
          Platform admin?{" "}
          <Link href="/admin/login" className="text-cyan hover:underline">
            Sign in here
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
          <Field label={role === "lab" ? "Lab / diagnostic centre name" : "Full name"}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className={inputClass}
              placeholder={role === "lab" ? "e.g. Dr Lal PathLabs, Pune Branch" : "e.g. Aditi Sharma"}
            />
          </Field>
        )}

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
            placeholder="you@example.com"
          />
        </Field>

        {mode === "signup" && (
          <Field label="Phone number">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              className={inputClass}
              placeholder="+91 98xxxxxxx"
            />
          </Field>
        )}

        {mode === "signup" && role === "doctor" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Specialty">
                <input
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  required
                  className={inputClass}
                  placeholder="Cardiology"
                />
              </Field>
              <Field label="Registration ID">
                <input
                  value={registrationId}
                  onChange={(e) => setRegistrationId(e.target.value)}
                  required
                  className={inputClass}
                  placeholder="MCI-XX-00000"
                />
              </Field>
            </div>
            <Field label="Hospital / facility">
              <input
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                required
                className={inputClass}
                placeholder="e.g. Fortis Hospital, Pune"
              />
            </Field>
            <FileDropField
              label="Proof of practice"
              hint="Medical registration certificate or license (PDF or image)."
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
            <Field label="Accreditation ID">
              <input
                value={registrationId}
                onChange={(e) => setRegistrationId(e.target.value)}
                required
                className={inputClass}
                placeholder="e.g. NABL-XX-00000 or CAP-00000"
              />
            </Field>
            <Field label="Branch address / facility">
              <input
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                required
                className={inputClass}
                placeholder="e.g. Dr Lal PathLabs, Camp Road, Pune"
              />
            </Field>
            <FileDropField
              label="Proof of accreditation"
              hint="NABL or CAP accreditation certificate, or lab registration license (PDF or image)."
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

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "signup" ? 6 : undefined}
            className={inputClass}
            placeholder="••••••••"
          />
        </Field>

        {mode === "signup" && (
          <Field label="Confirm password">
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className={inputClass}
              placeholder="••••••••"
            />
          </Field>
        )}

        {mode === "signin" && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => push("Password reset isn't wired up in this prototype yet.", "amber")}
              className="text-[11.5px] text-text-tertiary hover:text-cyan"
            >
              Forgot password?
            </button>
          </div>
        )}

        {error && <p className="text-[12.5px] text-red">{error}</p>}

        <button
          type="submit"
          className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99]"
        >
          {mode === "signin" ? "Sign in" : role === "patient" ? "Create account" : "Submit application"}
        </button>
      </form>
    </AuthLayout>
  );
}
