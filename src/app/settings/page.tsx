"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, LogOut, Save } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useAuthStore } from "@/store/useAuthStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useLanguageStore } from "@/store/useLanguageStore";
import { useThemeStore } from "@/store/useThemeStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { LANGUAGES } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/types";

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

const STATUS_TONE = {
  pending: "amber",
  verified: "emerald",
  rejected: "red",
} as const;

export default function SettingsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const { t } = useTranslation();

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) router.replace("/login");
  }, [hasHydrated, user, router]);

  if (!hasHydrated || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">
        {t("settings.loading")}
      </div>
    );
  }

  return <SettingsForm key={user.id} user={user} />;
}

function SettingsForm({ user }: { user: AuthUser }) {
  const router = useRouter();
  const { t } = useTranslation();
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const logout = useAuthStore((s) => s.logout);
  const patientProfile = usePatientStore((s) => s.profile);
  const updateInsuranceProvider = usePatientStore((s) => s.updateInsuranceProvider);
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const push = useToastStore((s) => s.push);

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [specialty, setSpecialty] = useState(user.specialty ?? "");
  const [registrationId, setRegistrationId] = useState(user.registrationId ?? "");
  const [facility, setFacility] = useState(user.facility ?? "");
  const [insuranceProvider, setInsuranceProvider] = useState(
    patientProfile && patientProfile.insurance !== "Not added yet" ? patientProfile.insurance : ""
  );

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const backHref = user.role === "admin" || user.role === "staff" ? "/admin" : user.role === "lab" ? "/lab" : "/dashboard";

  function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    const result = updateProfile({
      name,
      email,
      phone: phone || undefined,
      specialty: specialty || undefined,
      registrationId: registrationId || undefined,
      facility: facility || undefined,
    });
    if (!result.ok) {
      push(result.error, "amber");
      return;
    }
    if (user.role === "patient" && patientProfile) {
      updateInsuranceProvider(insuranceProvider);
    }
    push(t("settings.toast.profileUpdated"), "emerald");
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      push(t("settings.toast.fillPasswords"), "amber");
      return;
    }
    if (newPassword.length < 6) {
      push(t("settings.toast.passwordTooShort"), "amber");
      return;
    }
    if (newPassword !== confirmPassword) {
      push(t("settings.toast.passwordMismatch"), "amber");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    push(t("settings.toast.passwordUpdated"), "emerald");
  }

  function handleLogout() {
    logout();
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <header className="sticky top-0 z-40 border-b border-hairline bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[720px] items-center gap-3 px-5 py-3.5">
          <Link
            href={backHref}
            className="flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <ArrowLeft size={13} /> {t("settings.back")}
          </Link>
          <p className="text-[13.5px] font-semibold">{t("settings.title")}</p>
        </div>
      </header>

      <main className="mx-auto max-w-[720px] space-y-5 px-5 py-8">
        <Card>
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-cyan/12 text-[18px] font-semibold text-cyan">
              {user.avatarInitials}
            </div>
            <div>
              <p className="text-[15px] font-semibold text-text-primary">{user.name}</p>
              <p className="text-[12px] capitalize text-text-tertiary">
                {user.role} {t("settings.label.account")}
              </p>
            </div>
            {user.verificationStatus && (
              <StatusPill
                label={t(`settings.status.${user.verificationStatus}`)}
                tone={STATUS_TONE[user.verificationStatus]}
                className="ml-auto"
              />
            )}
          </div>
        </Card>

        <Card>
          <CardLabel>{t("settings.section.personalInfo")}</CardLabel>
          <form onSubmit={handleSaveProfile} className="mt-4 space-y-4">
            <Field label={user.role === "lab" ? t("settings.field.labName") : t("settings.field.fullName")}>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required />
            </Field>
            <Field label={t("settings.field.email")}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                required
              />
            </Field>
            {user.role !== "admin" && user.role !== "staff" && (
              <Field label={t("settings.field.phone")}>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClass}
                  placeholder="+91 98xxxxxxx"
                />
              </Field>
            )}
            {user.role === "doctor" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("settings.field.specialty")}>
                  <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} className={inputClass} />
                </Field>
                <Field label={t("settings.field.registrationId")}>
                  <input
                    value={registrationId}
                    onChange={(e) => setRegistrationId(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
            )}
            {user.role === "doctor" && (
              <Field label={t("settings.field.facility")}>
                <input value={facility} onChange={(e) => setFacility(e.target.value)} className={inputClass} />
              </Field>
            )}
            {user.role === "lab" && (
              <>
                <Field label={t("settings.field.accreditationId")}>
                  <input
                    value={registrationId}
                    onChange={(e) => setRegistrationId(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label={t("settings.field.branchAddress")}>
                  <input value={facility} onChange={(e) => setFacility(e.target.value)} className={inputClass} />
                </Field>
              </>
            )}
            {user.role === "patient" && (
              <Field label={t("settings.field.insuranceProvider")}>
                <input
                  value={insuranceProvider}
                  onChange={(e) => setInsuranceProvider(e.target.value)}
                  className={inputClass}
                  placeholder={t("settings.field.insurancePlaceholder")}
                />
              </Field>
            )}
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110 active:scale-[0.98]"
            >
              <Save size={14} /> {t("settings.btn.saveChanges")}
            </button>
          </form>
        </Card>

        <Card>
          <CardLabel>{t("settings.section.security")}</CardLabel>
          <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
            <Field label={t("settings.field.currentPassword")}>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={inputClass}
                placeholder="••••••••"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("settings.field.newPassword")}>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputClass}
                  placeholder="••••••••"
                />
              </Field>
              <Field label={t("settings.field.confirmPassword")}>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClass}
                  placeholder="••••••••"
                />
              </Field>
            </div>
            <button
              type="submit"
              className="rounded-full border border-hairline px-4 py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
            >
              {t("settings.btn.updatePassword")}
            </button>
          </form>
        </Card>

        <Card>
          <CardLabel>{t("settings.section.appearance")}</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["light", "dark"] as const).map((themeOption) => (
              <button
                key={themeOption}
                onClick={() => setTheme(themeOption)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[12.5px] capitalize transition",
                  theme === themeOption
                    ? "border-cyan/40 bg-cyan/10 text-cyan"
                    : "border-hairline text-text-secondary hover:border-hairline-strong"
                )}
              >
                {theme === themeOption && <Check size={12} />}
                {t(`settings.theme.${themeOption}`)}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <CardLabel>{t("settings.section.language")}</CardLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                onClick={() => setLanguage(l.code)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[12.5px] transition",
                  language === l.code
                    ? "border-cyan/40 bg-cyan/10 text-cyan"
                    : "border-hairline text-text-secondary hover:border-hairline-strong"
                )}
              >
                {language === l.code && <Check size={12} />}
                {l.nativeLabel}
              </button>
            ))}
          </div>
        </Card>

        <Card className="flex items-center justify-between">
          <div>
            <p className="text-[13.5px] font-medium text-text-primary">{t("settings.section.logout")}</p>
            <p className="mt-0.5 text-[12px] text-text-tertiary">{t("settings.logout.description")}</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-red/30 px-4 py-2 text-[12.5px] font-medium text-red transition hover:bg-red/10"
          >
            <LogOut size={13} /> {t("settings.section.logout")}
          </button>
        </Card>
      </main>
      <ToastViewport />
    </div>
  );
}
