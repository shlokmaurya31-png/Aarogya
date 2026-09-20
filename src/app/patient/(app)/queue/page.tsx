"use client";

import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDateTime, StatusPill } from "@/components/patient-portal/ui";

interface Q { queueLabel: string; statusLabel: string; positionEstimate: number | null; enteredAt: string; }

export default function QueuePage() {
  const { state } = usePatientData<{ positions: Q[] }>("/api/patient/queue");
  return (
    <div className="space-y-5">
      <h1 className="text-[18px] font-semibold">Queue status</h1>
      <Card>
        <SectionTitle>Where you are right now</SectionTitle>
        {state.status === "loading" ? <Empty>Loading…</Empty> : state.status === "error" ? <Unavailable label="Queue status" /> : state.data.positions.length === 0 ? (
          <Empty>You are not in any queue at the moment.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.data.positions.map((q, i) => (
              <li key={i} className="flex items-center justify-between border-b border-hairline pb-3 last:border-0 last:pb-0">
                <div>
                  <div className="text-[14px] font-medium">{q.queueLabel}</div>
                  <div className="text-[12px] text-text-secondary">In line since {formatDateTime(q.enteredAt)}</div>
                  {q.positionEstimate != null && (
                    <div className="text-[12px] text-cyan">Roughly #{q.positionEstimate} in line (estimate — actual wait may vary)</div>
                  )}
                </div>
                <StatusPill label={q.statusLabel} tone="info" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
