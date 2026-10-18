"use client";

import { useState } from "react";
import { Card, usePatientData } from "./ui";

interface PersonOverview {
  sharing: { uploadsWithTreatingHospitals: "GRANTED" | "DECLINED" | null; choiceNeeded: boolean };
}

/**
 * Phase 0: "Share my uploads with hospitals treating me?" Asked until the
 * person answers (sign-up, and the next login for accounts from before Phase
 * 0, whose old uploads stay visible to their hospital until they choose).
 * Nothing is pre-selected and both answers carry equal weight: the choice has
 * to be the person's own (DPDP). Changeable later.
 */
export function SharingChoice() {
  const { state, reload } = usePatientData<PersonOverview>("/api/patient/person");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.status !== "ok" || !state.data.sharing.choiceNeeded) return null;

  const choose = async (decision: "GRANTED" | "DECLINED") => {
    setSaving(true);
    setError(null);
    const r = await fetch("/api/patient/person/sharing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).catch(() => null);
    setSaving(false);
    if (!r?.ok) { setError("Couldn't save your choice. Please try again."); return; }
    reload();
  };

  const button = "rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-text-primary hover:border-cyan/40 disabled:opacity-50";
  return (
    <Card className="border-cyan/30 bg-cyan/5">
      <p className="text-[14px] font-medium">Share your uploads with hospitals treating you?</p>
      <p className="mt-1 text-[13px] text-text-secondary">
        If you say yes, a hospital where you are being treated (a current visit or admission, or a recent one) can see the reports you upload here. If you say no, only you can see them.
        Reports you uploaded before this choice stay visible to the hospital you uploaded them to until you answer. You can change this any time.
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={saving} onClick={() => choose("GRANTED")} className={button}>Yes, share with hospitals treating me</button>
        <button type="button" disabled={saving} onClick={() => choose("DECLINED")} className={button}>No, keep them to myself</button>
      </div>
      {error && <p className="mt-2 text-[12px] text-red">{error}</p>}
    </Card>
  );
}
