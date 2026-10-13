"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";

const inputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.02] px-3.5 py-2.5 text-[13.5px] outline-none transition placeholder:text-text-tertiary focus:border-cyan/40 focus:bg-cyan/[0.03]";
const buttonClass =
  "w-full rounded-full bg-cyan py-3 text-[13.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

const backToSignIn = (
  <p className="text-center text-[12px] text-text-tertiary">
    <Link href="/login" className="text-cyan hover:underline">Back to sign in</Link>
  </p>
);

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    return res.ok ? { ok: true, message: data.message } : { ok: false, error: data.error ?? "Something went wrong." };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Please try again." };
  }
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post("/api/scholar-auth/password/forgot", { email });
    setBusy(false);
    if (r.ok) setSent(r.message ?? "Check your email.");
    else setError(r.error ?? null);
  }

  return (
    <AuthLayout eyebrow="Account recovery" title="Forgot your password?" subtitle="Enter your account email and we'll send a one-time reset link." footer={backToSignIn}>
      {sent ? (
        <p className="rounded-xl border border-emerald/20 bg-emerald/[0.06] px-3.5 py-3 text-[13px] text-emerald">{sent}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="you@example.com" />
          </Field>
          {error && <p className="text-[12.5px] text-red">{error}</p>}
          <button type="submit" disabled={busy} className={buttonClass}>{busy ? "Sending…" : "Send reset link"}</button>
        </form>
      )}
    </AuthLayout>
  );
}

function NewPasswordFields({ password, setPassword, confirm, setConfirm }: {
  password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void;
}) {
  return (
    <>
      <Field label="New password">
        <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="At least 8 characters" autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password">
        <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} autoComplete="new-password" />
      </Field>
    </>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "This reset link is incomplete. Request a new one.");
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError(null);
    const r = await post("/api/scholar-auth/password/reset", { token, password });
    setBusy(false);
    if (r.ok) setDone(true);
    else setError(r.error ?? null);
  }

  return (
    <AuthLayout eyebrow="Account recovery" title="Set a new password" subtitle="Every device signed in to this account will be signed out." footer={backToSignIn}>
      {done ? (
        <div className="space-y-4">
          <p className="rounded-xl border border-emerald/20 bg-emerald/[0.06] px-3.5 py-3 text-[13px] text-emerald">Password updated. Sign in with your new password.</p>
          <button type="button" onClick={() => router.push("/login")} className={buttonClass}>Go to sign in</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
          {error && (
            <p className="text-[12.5px] text-red">
              {error} <Link href="/forgot-password" className="text-cyan hover:underline">Request a new link</Link>
            </p>
          )}
          <button type="submit" disabled={busy || !token} className={buttonClass}>{busy ? "Saving…" : "Set new password"}</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ChangePasswordForm({ displayName, backHref }: { displayName: string; backHref: string }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("New passwords don't match.");
    setBusy(true);
    setError(null);
    const r = await post("/api/scholar-auth/password/change", { currentPassword: current, newPassword: password });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      setCurrent("");
      setPassword("");
      setConfirm("");
    } else setError(r.error ?? null);
  }

  return (
    <AuthLayout
      eyebrow="Account security"
      title="Change password"
      subtitle={`Signed in as ${displayName}. Other devices will be signed out.`}
      footer={<p className="text-center text-[12px] text-text-tertiary"><Link href={backHref} className="text-cyan hover:underline">Back</Link></p>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password">
          <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} autoComplete="current-password" />
        </Field>
        <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        {error && <p className="text-[12.5px] text-red">{error}</p>}
        {done && <p className="text-[12.5px] text-emerald">Password changed. Other devices have been signed out.</p>}
        <button type="submit" disabled={busy} className={buttonClass}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </AuthLayout>
  );
}
