"use client";

import { useEffect, useState } from "react";
import { Card, CardLabel } from "@/components/ui/Card";

/**
 * Week 5c — the facility's own payment-gateway account: patients pay their
 * share to the hospital, never to Aarogya. Test mode only for now. Only the
 * public key id is entered here; the secrets go in the environment under the
 * secret reference, and are never shown.
 */
interface View { configured: boolean; mode?: string; keyId?: string; secretRef?: string; enabled?: boolean; secretsPresent?: boolean }

export function PaymentGatewaySettings() {
  const [v, setV] = useState<View | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/hospital/payment-gateway").then((r) => (r.ok ? r.json() : null)).then((d: View | null) => {
      setV(d);
      if (d?.configured) { setKeyId(d.keyId ?? ""); setSecretRef(d.secretRef ?? ""); setEnabled(!!d.enabled); }
    }).catch(() => setV(null));
  }, []);
  async function save() {
    const r = await fetch("/api/hospital/payment-gateway", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyId, secretRef, mode: "TEST", enabled }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setV(d); setMsg("Saved."); } else setMsg(d.error ?? "That didn't go through.");
  }
  if (v === null) return null;
  return (
    <Card>
      <CardLabel>Patient payments (your gateway account)</CardLabel>
      <p className="mt-2 text-[11px] text-text-tertiary">Patients pay their share into this hospital&apos;s own Razorpay account (test mode for now). Put the key secret and webhook secret in the environment as RAZORPAY_KEY_SECRET__&lt;REF&gt; and RAZORPAY_WEBHOOK_SECRET__&lt;REF&gt;.</p>
      <div className="mt-2 grid gap-2 text-[12px] sm:grid-cols-2">
        <input aria-label="Key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_test_…" className="rounded-md border border-hairline bg-transparent px-2 py-1.5" />
        <input aria-label="Secret reference" value={secretRef} onChange={(e) => setSecretRef(e.target.value.toUpperCase())} placeholder="Secret reference, e.g. PUNE_MAIN" className="rounded-md border border-hairline bg-transparent px-2 py-1.5" />
      </div>
      <label className="mt-2 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Take payments in the app</label>
      {v.configured && <p className="mt-1 text-[11px] text-text-secondary">Secrets in the environment: {v.secretsPresent ? "yes" : "not yet"}</p>}
      <button onClick={save} className="mt-2 rounded-md border border-hairline px-3 py-1.5 text-[12px]">Save</button>
      {msg && <p className="mt-1 text-[11px] text-text-secondary">{msg}</p>}
    </Card>
  );
}
