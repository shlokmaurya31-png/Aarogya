"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, X } from "lucide-react";
import { patient } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { useRecordsStore } from "@/store/useRecordsStore";
import type { PrescriptionStatus } from "@/types";

const STATUS_TONE: Record<PrescriptionStatus, "emerald" | "amber" | "neutral"> = {
  active: "emerald",
  "refill-due": "amber",
  completed: "neutral",
};

const STATUS_LABEL: Record<PrescriptionStatus, string> = {
  active: "Active",
  "refill-due": "Refill due",
  completed: "Completed",
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function nextId() {
  return `rx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function PrescriptionsView() {
  const prescriptions = useRecordsStore((s) => s.prescriptions);
  const addPrescription = useRecordsStore((s) => s.addPrescription);
  const doctorSignature = useRecordsStore((s) => s.doctorSignature);
  const setDoctorSignature = useRecordsStore((s) => s.setDoctorSignature);
  const addNotification = useRecordsStore((s) => s.addNotification);
  const refillDue = prescriptions.filter((p) => p.status === "refill-due").length;
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const push = useToastStore((s) => s.push);

  const [formOpen, setFormOpen] = useState(false);
  const [doctorName, setDoctorName] = useState(doctorSignature.name);
  const [registrationId, setRegistrationId] = useState(doctorSignature.registrationId);
  const [facility, setFacility] = useState(doctorSignature.facility);
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [frequency, setFrequency] = useState("");
  const [startDate, setStartDate] = useState(todayIso());

  function requestRefill(id: string, drug: string) {
    setRequested((s) => new Set(s).add(id));
    push(`Refill requested for ${drug} — pharmacy notified`, "amber");
  }

  function openForm() {
    setDoctorName(doctorSignature.name);
    setRegistrationId(doctorSignature.registrationId);
    setFacility(doctorSignature.facility);
    setDrug("");
    setDose("");
    setFrequency("");
    setStartDate(todayIso());
    setFormOpen(true);
  }

  function submitPrescription() {
    if (!doctorName.trim() || !drug.trim() || !dose.trim() || !frequency.trim()) {
      push("Fill in the doctor details, drug, dose and frequency to issue this prescription", "amber");
      return;
    }
    setDoctorSignature({ name: doctorName.trim(), registrationId: registrationId.trim(), facility: facility.trim() });
    addPrescription({
      id: nextId(),
      drug: drug.trim(),
      dose: dose.trim(),
      frequency: frequency.trim(),
      prescribedBy: doctorName.trim(),
      startDate,
      status: "active",
      adherence: 100,
    });
    addNotification({
      id: `note-${nextId()}`,
      kind: "medicine",
      title: "New prescription issued",
      detail: `${drug.trim()} ${dose.trim()} prescribed by ${doctorName.trim()}`,
      time: "Just now",
      risk: "watch",
    });
    push(`Prescription for ${drug.trim()} sent to ${patient.name}`, "emerald");
    setFormOpen(false);
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Prescriptions"
        title="Current medications"
        subtitle={
          refillDue > 0
            ? `${refillDue} medication needs a refill soon`
            : "All medications are up to date"
        }
        action={
          <button
            onClick={openForm}
            className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <Plus size={14} /> New prescription
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {prescriptions.map((p, i) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
          >
            <Card className="h-full">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[14px] font-semibold">
                    {p.drug} <span className="font-normal text-text-tertiary">{p.dose}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-text-secondary">{p.frequency}</p>
                </div>
                <StatusPill label={STATUS_LABEL[p.status]} tone={STATUS_TONE[p.status]} />
              </div>

              <div className="mt-4 flex items-center justify-between text-[11.5px] text-text-tertiary">
                <span>Prescribed by {p.prescribedBy}</span>
                <span className="tabular-nums">since {formatDate(p.startDate)}</span>
              </div>

              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-tertiary">
                  <span>Adherence</span>
                  <span className="tabular-nums font-medium text-text-secondary">{p.adherence}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07]">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${p.adherence}%` }}
                    transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                    className="h-full rounded-full bg-emerald"
                  />
                </div>
              </div>

              {p.status === "refill-due" && (
                <button
                  onClick={() => requestRefill(p.id, p.drug)}
                  disabled={requested.has(p.id)}
                  className="mt-4 w-full rounded-full border border-amber/30 bg-amber/10 py-2 text-[12px] font-medium text-amber transition hover:bg-amber/15 disabled:cursor-default disabled:opacity-60"
                >
                  {requested.has(p.id) ? "Refill requested" : "Request refill"}
                </button>
              )}
            </Card>
          </motion.div>
        ))}
      </div>

      <AnimatePresence>
        {formOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/20 px-4 py-[8vh]"
            onClick={() => setFormOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="glass-strong card-shadow w-full max-w-md rounded-[20px]"
            >
              <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
                <p className="text-[14px] font-semibold text-text-primary">New prescription</p>
                <button
                  onClick={() => setFormOpen(false)}
                  aria-label="Close"
                  className="text-text-tertiary transition hover:text-text-secondary"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-4 px-5 py-4">
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    Prescribing doctor
                  </p>
                  <div className="space-y-2">
                    <input
                      value={doctorName}
                      onChange={(e) => setDoctorName(e.target.value)}
                      placeholder="Doctor name"
                      className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={registrationId}
                        onChange={(e) => setRegistrationId(e.target.value)}
                        placeholder="Registration ID"
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                      <input
                        value={facility}
                        onChange={(e) => setFacility(e.target.value)}
                        placeholder="Facility"
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    Prescribing for
                  </p>
                  <p className="text-[13px] text-text-secondary">{patient.name} · {patient.patientId}</p>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    Medication
                  </p>
                  <div className="space-y-2">
                    <input
                      value={drug}
                      onChange={(e) => setDrug(e.target.value)}
                      placeholder="Drug name"
                      className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={dose}
                        onChange={(e) => setDose(e.target.value)}
                        placeholder="Dose (e.g. 500mg)"
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                      <input
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                    </div>
                    <input
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value)}
                      placeholder="Frequency (e.g. Twice daily, after meals)"
                      className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-4">
                <button
                  onClick={() => setFormOpen(false)}
                  className="rounded-full border border-hairline px-4 py-2 text-[12.5px] font-medium text-text-secondary transition hover:border-hairline-strong"
                >
                  Cancel
                </button>
                <button
                  onClick={submitPrescription}
                  className="rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
                >
                  Issue prescription
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
