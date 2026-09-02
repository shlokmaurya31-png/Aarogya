"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

const DIFFICULTIES = ["FOUNDATION", "INTERMEDIATE", "ADVANCED", "RESIDENT_LEVEL", "EXPERT"];
const ACUITIES = ["ROUTINE", "URGENT", "EMERGENCY"];

export default function CreateCasePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    title: "", specialty: "", difficulty: "FOUNDATION", acuity: "ROUTINE",
    chiefComplaint: "", presentation: "", patientAgeBand: "30-34", patientSex: "Female",
    referenceDx: "", learningObjectivesText: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/educator/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          learningObjectives: form.learningObjectivesText.split("\n").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setMessage(data.error ?? "Failed to create case.");
        return;
      }
      router.push("/educator/cases");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Create case</h1>
      <p className="mt-1 text-[13px] text-text-secondary">
        Minimal schema-driven authoring — creates a structurally valid draft case (unpublished). Full
        multi-step authoring (history tree, investigations, rubric editor) is a planned next phase.
      </p>

      <Card className="mt-5 rounded-[20px]">
        <form onSubmit={handleSubmit} className="space-y-3.5">
          <Row label="Title"><Input value={form.title} onChange={(v) => setForm((f) => ({ ...f, title: v }))} required /></Row>
          <Row label="Specialty"><Input value={form.specialty} onChange={(v) => setForm((f) => ({ ...f, specialty: v }))} required /></Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Difficulty">
              <select value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value }))} className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Row>
            <Row label="Acuity">
              <select value={form.acuity} onChange={(e) => setForm((f) => ({ ...f, acuity: e.target.value }))} className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40">
                {ACUITIES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Row>
          </div>
          <Row label="Chief complaint"><Input value={form.chiefComplaint} onChange={(v) => setForm((f) => ({ ...f, chiefComplaint: v }))} required /></Row>
          <Row label="Presentation">
            <textarea value={form.presentation} onChange={(e) => setForm((f) => ({ ...f, presentation: e.target.value }))} rows={3} required className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          </Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Patient age band"><Input value={form.patientAgeBand} onChange={(v) => setForm((f) => ({ ...f, patientAgeBand: v }))} /></Row>
            <Row label="Patient sex"><Input value={form.patientSex} onChange={(v) => setForm((f) => ({ ...f, patientSex: v }))} /></Row>
          </div>
          <Row label="Reference diagnosis"><Input value={form.referenceDx} onChange={(v) => setForm((f) => ({ ...f, referenceDx: v }))} required /></Row>
          <Row label="Learning objectives (one per line)">
            <textarea value={form.learningObjectivesText} onChange={(e) => setForm((f) => ({ ...f, learningObjectivesText: e.target.value }))} rows={3} required className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
          </Row>

          {message && <p className="text-[12.5px] text-red">{message}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-emerald px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-60">
            {submitting ? "Creating..." : "Create draft case"}
          </button>
        </form>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Input({ value, onChange, required }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} required={required} className="w-full rounded-md border border-hairline bg-black/[0.02] px-3 py-2 text-[13px] outline-none focus:border-cyan/40" />
  );
}
