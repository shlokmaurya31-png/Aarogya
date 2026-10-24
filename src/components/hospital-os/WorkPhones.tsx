"use client";

import { useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";

/**
 * 5b follow-up — the verified phones of a work login. Used only to keep a
 * doctor out of their own record through doctor tools, and to record a read
 * of their own chart here as self-access. Never shown to anyone else.
 */
export function WorkPhones() {
  const [phones, setPhones] = useState<{ phoneId: string; phone: string }[]>([]);
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState<{ phoneId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/account/phones").then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setPhones(d.phones); }).catch(() => null);
    return () => { alive = false; };
  }, [tick]);
  async function post(url: string, body: unknown) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = await r?.json().catch(() => null);
    return r?.ok ? { ok: true as const, d } : { ok: false as const, error: (d?.error as string) ?? "That didn't go through." };
  }
  async function start() {
    const r = await post("/api/account/phones", { phone });
    if (r.ok) { setPending(r.d); setMsg(null); } else setMsg(r.error);
  }
  async function confirm() {
    if (!pending) return;
    const r = await post("/api/account/phones/confirm", { phoneId: pending.phoneId, code });
    if (r.ok) { setPending(null); setPhone(""); setCode(""); setMsg("Verified."); setTick((t) => t + 1); } else setMsg(r.error);
  }
  return (
    <Card>
      <CardLabel>Your verified work phones</CardLabel>
      <p className="mt-2 text-[11px] text-text-tertiary">Doctor tools never open your own record. Add the phone numbers you use as a patient so we can tell.</p>
      <ul className="mt-2 text-[12px]" aria-label="Verified phones">{phones.map((p) => <li key={p.phoneId}>{p.phone}</li>)}</ul>
      {!pending ? (
        <div className="mt-2 flex gap-2">
          <input aria-label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" className="rounded-md border border-hairline bg-transparent px-2 py-1 text-[12px]" />
          <button onClick={start} disabled={!phone} className="rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">Send code</button>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <span className="text-[12px]">Code sent to {pending.sentTo}</span>
          <input aria-label="Phone code" value={code} onChange={(e) => setCode(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1 font-mono text-[12px]" />
          <button onClick={confirm} className="rounded-md border border-hairline px-2 py-1 text-[12px]">Verify</button>
        </div>
      )}
      {msg && <p className="mt-1 text-[11px] text-text-secondary" role="status">{msg}</p>}
    </Card>
  );
}
