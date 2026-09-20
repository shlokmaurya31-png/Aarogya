"use client";

import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDate, StatusPill } from "@/components/patient-portal/ui";

interface Coverage { id: string; payer: string; plan: string | null; memberIdMasked: string; statusLabel: string; validFrom: string; validTo: string | null; isPrimary: boolean; preAuths: { statusLabel: string; requestedAt: string; decidedAt: string | null }[]; }
interface Claim { claimNumber: string | null; statusLabel: string; submittedAt: string | null; decidedAt: string | null; }

export default function InsurancePage() {
  const { state } = usePatientData<{ coverages: Coverage[]; claims: Claim[] }>("/api/patient/insurance");
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Insurance</h1>
      {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Insurance" /> : (
        <>
          <Card>
            <SectionTitle>Coverage</SectionTitle>
            {state.data.coverages.length ? (
              <ul className="space-y-3">{state.data.coverages.map((c) => (
                <li key={c.id} className="border-b border-hairline pb-3 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-medium">{c.payer}{c.plan ? ` · ${c.plan}` : ""}{c.isPrimary ? " (Primary)" : ""}</span>
                    <StatusPill label={c.statusLabel} tone="info" />
                  </div>
                  <div className="text-[12px] text-text-secondary">Member {c.memberIdMasked} · valid from {formatDate(c.validFrom)}{c.validTo ? ` to ${formatDate(c.validTo)}` : ""}</div>
                  {c.preAuths.length > 0 && (
                    <div className="mt-1 text-[12px] text-text-tertiary">Approvals: {c.preAuths.map((p, i) => <span key={i}>{p.statusLabel}{i < c.preAuths.length - 1 ? ", " : ""}</span>)}</div>
                  )}
                </li>
              ))}</ul>
            ) : <Empty>No insurance coverage on record.</Empty>}
          </Card>
          <Card>
            <SectionTitle>Claims</SectionTitle>
            {state.data.claims.length ? (
              <ul className="space-y-2">{state.data.claims.map((c, i) => (
                <li key={i} className="flex items-center justify-between text-[13px]">
                  <span>{c.claimNumber ?? "Claim"}{c.submittedAt ? ` · ${formatDate(c.submittedAt)}` : ""}</span>
                  <StatusPill label={c.statusLabel} />
                </li>
              ))}</ul>
            ) : <Empty>No claims on record.</Empty>}
          </Card>
        </>
      )}
    </div>
  );
}
