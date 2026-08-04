"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { useAuthStore } from "@/store/useAuthStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useUiStore } from "@/store/useUiStore";
import { useToastStore } from "@/store/useToastStore";

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

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "I don't know"];
const GENDERS = ["Female", "Male", "Other", "Prefer not to say"];

export default function OnboardingPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const profile = usePatientStore((s) => s.profile);
  const completeOnboarding = usePatientStore((s) => s.completeOnboarding);
  const setUiMode = useUiStore((s) => s.setMode);
  const push = useToastStore((s) => s.push);

  const [age, setAge] = useState("");
  const [gender, setGender] = useState(GENDERS[0]);
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [bloodGroup, setBloodGroup] = useState(BLOOD_GROUPS[0]);
  const [allergies, setAllergies] = useState("");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const [insuranceProvider, setInsuranceProvider] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.role !== "patient") {
      router.replace(user.role === "admin" ? "/admin" : user.role === "lab" ? "/lab" : "/dashboard");
      return;
    }
    if (profile) {
      router.replace("/dashboard");
    }
  }, [hasHydrated, user, profile, router]);

  if (!hasHydrated || !user || user.role !== "patient" || profile) {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">Loading…</div>;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const ageNum = Number(age);
    if (!age.trim() || Number.isNaN(ageNum) || ageNum <= 0 || ageNum > 120) {
      setError("Enter a valid age.");
      return;
    }
    if (!height.trim() || !weight.trim()) {
      setError("Fill in your height and weight.");
      return;
    }
    if (!emergencyContactName.trim() || !emergencyContactPhone.trim()) {
      setError("Add at least one emergency contact.");
      return;
    }

    completeOnboarding(user!.name, {
      age: ageNum,
      gender,
      height: height.trim(),
      weight: weight.trim(),
      bloodGroup,
      allergies: allergies
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      emergencyContactName: emergencyContactName.trim(),
      emergencyContactPhone: emergencyContactPhone.trim(),
      insuranceProvider: insuranceProvider.trim() || undefined,
    });

    setUiMode("patient");
    push("Profile complete, welcome to Aarogya", "emerald");
    router.push("/dashboard");
  }

  return (
    <AuthLayout
      eyebrow="One more step"
      title="Tell us about yourself"
      subtitle="This is what makes your dashboard actually yours, not a demo record."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age">
            <input
              type="number"
              min={1}
              max={120}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className={inputClass}
              placeholder="e.g. 34"
              required
            />
          </Field>
          <Field label="Gender">
            <select value={gender} onChange={(e) => setGender(e.target.value)} className={inputClass}>
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Height">
            <input
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              className={inputClass}
              placeholder="e.g. 170 cm"
              required
            />
          </Field>
          <Field label="Weight">
            <input
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className={inputClass}
              placeholder="e.g. 65 kg"
              required
            />
          </Field>
        </div>

        <Field label="Blood group">
          <select value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)} className={inputClass}>
            {BLOOD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Allergies (optional)">
          <input
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            className={inputClass}
            placeholder="e.g. Penicillin, Peanuts (leave blank if none)"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Emergency contact name">
            <input
              value={emergencyContactName}
              onChange={(e) => setEmergencyContactName(e.target.value)}
              className={inputClass}
              placeholder="e.g. Arjun Kulkarni"
              required
            />
          </Field>
          <Field label="Emergency contact phone">
            <input
              value={emergencyContactPhone}
              onChange={(e) => setEmergencyContactPhone(e.target.value)}
              className={inputClass}
              placeholder="+91 98xxxxxxx"
              required
            />
          </Field>
        </div>

        <Field label="Health insurance provider (optional)">
          <input
            value={insuranceProvider}
            onChange={(e) => setInsuranceProvider(e.target.value)}
            className={inputClass}
            placeholder="e.g. Star Health"
          />
        </Field>

        {error && <p className="text-[12.5px] text-red">{error}</p>}

        <button
          type="submit"
          className="w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99]"
        >
          Complete my profile
        </button>
      </form>
    </AuthLayout>
  );
}
