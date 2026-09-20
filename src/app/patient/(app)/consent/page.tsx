"use client";

import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill } from "@/components/patient-portal/ui";

interface Consent { id: string; purpose: string; statusLabel: string; recipientType: string; recipientName: string | null; scopes: string[]; grantedAt: string | null; expiresAt: string | null; canGrant: boolean; canRevoke: boolean; }

export default function ConsentPage() {
  const { state, reload } = usePatientData<{ consents: Consent[] }>("/api/patient/consent");

  async function act(id: string, action: "grant" | "revoke") {
    const r = await fetch(`/api/patient/consent/${id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    if (r.ok) reload();
  }

  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Consent & sharing</h1>
      <p className="text-[13px] text-text-secondary">Control who may access your health information, for what purpose, and until when.</p>
      <Card>
        <SectionTitle>Your consents</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Consent" /> : state.data.consents.length === 0 ? (
          <Empty>You have no health-information sharing consents on record.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.data.consents.map((c) => (
              <li key={c.id} className="border-b border-hairline pb-3 last:border-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium">{c.purpose}</span>
                  <StatusPill label={c.statusLabel} tone={c.statusLabel === "Active" || c.statusLabel === "Granted" ? "good" : "neutral"} />
                </div>
                <div className="text-[12px] text-text-secondary">
                  Shares: {c.scopes.join(", ") || "—"} · with {c.recipientName ?? c.recipientType}
                  {c.expiresAt ? ` · until ${formatDate(c.expiresAt)}` : ""}
                </div>
                <div className="mt-2 flex gap-2">
                  {c.canGrant && <button onClick={() => act(c.id, "grant")} className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-white">Approve</button>}
                  {c.canRevoke && <button onClick={() => act(c.id, "revoke")} className="rounded-md border border-hairline px-3 py-1 text-[12px] text-text-secondary hover:border-red/30 hover:text-red">Revoke</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
