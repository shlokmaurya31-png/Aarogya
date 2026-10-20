"use client";

import { useState } from "react";

/**
 * Week 5b — take over your own health record: at 18, or as an adult a family
 * member helped. Use the code sent to your own phone or email, or handed over
 * in person at a hospital. Then sign in and choose, one by one, whether
 * anyone who helped you keeps access.
 */
export default function ClaimPage() {
  const [f, setF] = useState({ claimId: "", code: "", email: "", password: "" });
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await fetch("/api/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).catch(() => null);
    const b = await r?.json().catch(() => null);
    if (r?.ok) setDone(`Your record is yours now. Sign in with ${f.email}. ${b?.lapsedGrants?.length ? "Anyone who helped you no longer has access until you choose to give it back." : ""}`);
    else setError(b?.error ?? "That didn't work. Check the code and try again.");
  }
  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="text-[20px] font-semibold tracking-tight">Take over your health record</h1>
      {done ? <p role="status" className="text-[13px]">{done}</p> : (
        <form onSubmit={submit} className="space-y-2">
          <input aria-label="Reference" placeholder="Reference (from your message)" value={f.claimId} onChange={(e) => setF({ ...f, claimId: e.target.value })} className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]" />
          <input aria-label="Code" placeholder="Code" inputMode="numeric" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 font-mono text-[13px]" />
          <input aria-label="Email" type="email" placeholder="Your email (for signing in)" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]" />
          <input aria-label="Password" type="password" placeholder="A password (10+ characters)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]" />
          {error && <p className="text-[12px] text-amber">{error}</p>}
          <button type="submit" className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-ink">Take over</button>
        </form>
      )}
    </main>
  );
}
