"use client";

import { useState } from "react";
import { Plus, Trash2, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

export interface RxEntry {
  drug: string; genericName: string; formulation: string; strength: string;
  dose: string; route: string; frequency: string; duration: string; indication: string; instructions?: string;
}

interface RxWarning { drugName: string; severity: "info" | "warning" | "danger"; code: string; message: string }

const EMPTY_ENTRY: RxEntry = {
  drug: "", genericName: "", formulation: "tablet", strength: "", dose: "", route: "oral",
  frequency: "", duration: "", indication: "", instructions: "",
};

export function PrescriptionForm({
  caseId, context, onSubmit,
}: {
  caseId?: string;
  context?: { allergies: string[]; renalFunction: string; hepaticFunction: string; pregnancyStatus?: string; currentMedications: string[] };
  onSubmit?: (drugs: RxEntry[]) => void;
}) {
  const [entries, setEntries] = useState<RxEntry[]>([{ ...EMPTY_ENTRY }]);
  const [warnings, setWarnings] = useState<RxWarning[] | null>(null);
  const [checking, setChecking] = useState(false);

  function updateEntry(i: number, patch: Partial<RxEntry>) {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  async function handleCheck() {
    setChecking(true);
    try {
      const res = await fetch("/api/student/rxlab/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drugs: entries.filter((e) => e.genericName.trim()), caseId }),
      });
      const data = await res.json();
      setWarnings(data.warnings ?? []);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="rounded-[20px]">
      <div className="flex items-center justify-between">
        <CardLabel>RxLab — Prescription Simulator</CardLabel>
        <span className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.06em] text-amber">
          Educational simulation — not a valid prescription
        </span>
      </div>

      {context && (
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          {context.allergies.length > 0 && (
            <span className="rounded-md bg-red/10 px-2 py-1 text-red">Allergies: {context.allergies.join(", ")}</span>
          )}
          {context.renalFunction !== "normal" && <span className="rounded-md bg-amber/10 px-2 py-1 text-amber">Renal: {context.renalFunction}</span>}
          {context.hepaticFunction !== "normal" && <span className="rounded-md bg-amber/10 px-2 py-1 text-amber">Hepatic: {context.hepaticFunction}</span>}
          {context.pregnancyStatus === "pregnant" && <span className="rounded-md bg-red/10 px-2 py-1 text-red">Pregnant</span>}
          {context.currentMedications.length > 0 && (
            <span className="rounded-md bg-black/[0.04] px-2 py-1 text-text-secondary">On: {context.currentMedications.join(", ")}</span>
          )}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {entries.map((entry, i) => (
          <div key={i} className="rounded-lg border border-hairline p-3.5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <LabeledInput label="Drug name" value={entry.drug} onChange={(v) => updateEntry(i, { drug: v, genericName: entry.genericName || v })} />
              <LabeledInput label="Generic name" value={entry.genericName} onChange={(v) => updateEntry(i, { genericName: v })} />
              <LabeledInput label="Strength" value={entry.strength} onChange={(v) => updateEntry(i, { strength: v })} placeholder="500 mg" />
              <LabeledInput label="Formulation" value={entry.formulation} onChange={(v) => updateEntry(i, { formulation: v })} />
              <LabeledInput label="Dose" value={entry.dose} onChange={(v) => updateEntry(i, { dose: v })} placeholder="1 tablet" />
              <LabeledInput label="Route" value={entry.route} onChange={(v) => updateEntry(i, { route: v })} />
              <LabeledInput label="Frequency" value={entry.frequency} onChange={(v) => updateEntry(i, { frequency: v })} placeholder="BD" />
              <LabeledInput label="Duration" value={entry.duration} onChange={(v) => updateEntry(i, { duration: v })} placeholder="5 days" />
            </div>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <LabeledInput label="Indication" value={entry.indication} onChange={(v) => updateEntry(i, { indication: v })} />
              <LabeledInput label="Instructions" value={entry.instructions ?? ""} onChange={(v) => updateEntry(i, { instructions: v })} />
            </div>
            {entries.length > 1 && (
              <button onClick={() => setEntries((prev) => prev.filter((_, idx) => idx !== i))} className="mt-2 flex items-center gap-1 text-[11px] text-red hover:underline">
                <Trash2 size={11} /> Remove
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setEntries((prev) => [...prev, { ...EMPTY_ENTRY }])}
          className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-cyan/30"
        >
          <Plus size={12} /> Add drug
        </button>
        <button
          onClick={handleCheck}
          disabled={checking}
          className="rounded-md border border-cyan/30 px-3 py-1.5 text-[12px] font-medium text-cyan hover:bg-cyan/5 disabled:opacity-60"
        >
          {checking ? "Checking..." : "Check for interactions"}
        </button>
        {onSubmit && (
          <button
            onClick={() => onSubmit(entries.filter((e) => e.genericName.trim()))}
            className="ml-auto rounded-md bg-emerald px-4 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
          >
            Submit prescription
          </button>
        )}
      </div>

      {warnings && (
        <div className="mt-4 space-y-2">
          {warnings.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[12.5px] text-emerald"><ShieldCheck size={13} /> No issues flagged.</p>
          ) : (
            warnings.map((w, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded-md px-3 py-2 text-[12px]",
                  w.severity === "danger" ? "bg-red/10 text-red" : w.severity === "warning" ? "bg-amber/10 text-amber" : "bg-black/[0.04] text-text-secondary"
                )}
              >
                {w.severity === "danger" ? <ShieldAlert size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
                <span>{w.message}</span>
              </div>
            ))
          )}
          <p className="text-[10.5px] text-text-tertiary">Rule-based educational checks only — not a validated clinical decision-support system.</p>
        </div>
      )}
    </Card>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-hairline bg-black/[0.02] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-cyan/40"
      />
    </div>
  );
}
