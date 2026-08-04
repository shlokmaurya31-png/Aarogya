"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, LogOut, Save } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useAuthStore } from "@/store/useAuthStore";
import { useLanguageStore } from "@/store/useLanguageStore";
import { useToastStore } from "@/store/useToastStore";
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

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) router.replace("/login");
  }, [hasHydrated, user, router]);

  if (!hasHydrated || !user) {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">Loading…</div>;
  }

  return <SettingsForm key={user.id} user={user} />;
}

function SettingsForm({ user }: { user: AuthUser }) {
  const router = useRouter();
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const logout = useAuthStore((s) => s.logout);
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const push = useToastStore((s) => s.push);

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone ?? "");
  const [specialty, setSpecialty] = useState(user.specialty ?? "");
  const [registrationId, setRegistrationId] = useState(user.registrationId ?? "");
  const [facility, setFacility] = useState(user.facility ?? "");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const backHref = user.role === "admin" ? "/admin" : user.role === "lab" ? "/lab" : "/dashboard";

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
    push("Profile updated", "emerald");
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      push("Fill in your current and new password.", "amber");
      return;
    }
    if (newPassword.length < 6) {
      push("New password needs at least 6 characters.", "amber");
      return;
    }
    if (newPassword !== confirmPassword) {
      push("New passwords don't match.", "amber");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    push("Password updated", "emerald");
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
            <ArrowLeft size={13} /> Back
          </Link>
          <p className="text-[13.5px] font-semibold">Account Settings</p>
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
              <p className="text-[12px] capitalize text-text-tertiary">{user.role} account</p>
            </div>
            {user.verificationStatus && (
              <StatusPill
                label={user.verificationStatus}
                tone={STATUS_TONE[user.verificationStatus]}
                className="ml-auto"
              />
            )}
          </div>
        </Card>

        <Card>
          <CardLabel>Personal information</CardLabel>
          <form onSubmit={handleSaveProfile} className="mt-4 space-y-4">
            <Field label={user.role === "lab" ? "Lab / diagnostic centre name" : "Full name"}>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                required
              />
            </Field>
            {user.role !== "admin" && (
              <Field label="Phone number">
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
                <Field label="Specialty">
                  <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Registration ID">
                  <input
                    value={registrationId}
                    onChange={(e) => setRegistrationId(e.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
            )}
            {user.role === "doctor" && (
              <Field label="Hospital / facility">
                <input value={facility} onChange={(e) => setFacility(e.target.value)} className={inputClass} />
              </Field>
            )}
            {user.role === "lab" && (
              <>
                <Field label="Accreditation ID">
                  <input
                    value={registrationId}
                    onChange={(e) => setRegistrationId(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Branch address / facility">
                  <input value={facility} onChange={(e) => setFacility(e.target.value)} className={inputClass} />
                </Field>
              </>
            )}
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110 active:scale-[0.98]"
            >
              <Save size={14} /> Save changes
            </button>
          </form>
        </Card>

        <Card>
          <CardLabel>Security</CardLabel>
          <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
            <Field label="Current password">
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className={inputClass}
                placeholder="••••••••"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="New password">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputClass}
                  placeholder="••••••••"
                />
              </Field>
              <Field label="Confirm new password">
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
              Update password
            </button>
          </form>
        </Card>

        <Card>
          <CardLabel>Language</CardLabel>
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
            <p className="text-[13.5px] font-medium text-text-primary">Log out</p>
            <p className="mt-0.5 text-[12px] text-text-tertiary">
              You&rsquo;ll need to sign in again to access your account.
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-red/30 px-4 py-2 text-[12.5px] font-medium text-red transition hover:bg-red/10"
          >
            <LogOut size={13} /> Log out
          </button>
        </Card>
      </main>
      <ToastViewport />
    </div>
  );
}
