"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { FileText, Plus, Trash2, User, X } from "lucide-react";
import { patient } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { Autocomplete } from "@/components/ui/Autocomplete";
import { useToastStore } from "@/store/useToastStore";
import { useRecordsStore } from "@/store/useRecordsStore";
import { useTranslation } from "@/hooks/useTranslation";
import { ESSENTIAL_MEDICINES } from "@/lib/essential-medicines";
import type { PrescriptionStatus } from "@/types";

const STATUS_TONE: Record<PrescriptionStatus, "emerald" | "amber" | "neutral"> = {
  active: "emerald",
  "refill-due": "amber",
  completed: "neutral",
};

const STATUS_LABEL_KEY: Record<PrescriptionStatus, string> = {
  active: "prescriptionsView.statusActive",
  "refill-due": "prescriptionsView.statusRefillDue",
  completed: "prescriptionsView.statusCompleted",
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

type MedLine = { drug: string; dose: string; frequency: string };

const emptyMedLine: MedLine = { drug: "", dose: "", frequency: "" };

export function PrescriptionsView() {
  const prescriptions = useRecordsStore((s) => s.prescriptions);
  const addPrescription = useRecordsStore((s) => s.addPrescription);
  const doctorSignature = useRecordsStore((s) => s.doctorSignature);
  const setDoctorSignature = useRecordsStore((s) => s.setDoctorSignature);
  const addNotification = useRecordsStore((s) => s.addNotification);
  const refillDue = prescriptions.filter((p) => p.status === "refill-due").length;
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  const [formOpen, setFormOpen] = useState(false);
  const [doctorName, setDoctorName] = useState(doctorSignature.name);
  const [qualification, setQualification] = useState(doctorSignature.qualification);
  const [registrationId, setRegistrationId] = useState(doctorSignature.registrationId);
  const [facility, setFacility] = useState(doctorSignature.facility);
  const [meds, setMeds] = useState<MedLine[]>([emptyMedLine]);
  const [startDate, setStartDate] = useState(todayIso());

  function updateMed(index: number, field: keyof MedLine, value: string) {
    setMeds((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addMedLine() {
    setMeds((rows) => [...rows, { ...emptyMedLine }]);
  }

  function removeMedLine(index: number) {
    setMeds((rows) => rows.filter((_, i) => i !== index));
  }

  function requestRefill(id: string, drug: string) {
    setRequested((s) => new Set(s).add(id));
    push(`${t("prescriptionsView.toast.refillRequestedPrefix")} ${drug}${t("prescriptionsView.toast.refillRequestedSuffix")}`, "amber");
  }

  function openForm() {
    setDoctorName(doctorSignature.name);
    setQualification(doctorSignature.qualification);
    setRegistrationId(doctorSignature.registrationId);
    setFacility(doctorSignature.facility);
    setMeds([{ ...emptyMedLine }]);
    setStartDate(todayIso());
    setFormOpen(true);
  }

  function submitPrescription() {
    const validMeds = meds.filter((m) => m.drug.trim() && m.dose.trim() && m.frequency.trim());
    if (!doctorName.trim() || validMeds.length === 0) {
      push(t("prescriptionsView.toast.fillRequiredFields"), "amber");
      return;
    }
    setDoctorSignature({
      name: doctorName.trim(),
      qualification: qualification.trim(),
      registrationId: registrationId.trim(),
      facility: facility.trim(),
    });
    for (const m of validMeds) {
      addPrescription({
        id: nextId(),
        drug: m.drug.trim(),
        dose: m.dose.trim(),
        frequency: m.frequency.trim(),
        prescribedBy: doctorName.trim(),
        qualification: qualification.trim(),
        registrationId: registrationId.trim(),
        facility: facility.trim(),
        startDate,
        status: "active",
        adherence: 100,
      });
      addNotification({
        id: `note-${nextId()}`,
        kind: "medicine",
        title: t("prescriptionsView.notification.title"),
        detail: `${m.drug.trim()} ${m.dose.trim()} ${t("prescriptionsView.notification.prescribedBySuffix")} ${doctorName.trim()}`,
        time: t("lab.time.justNow"),
        risk: "watch",
      });
    }
    const summary =
      validMeds.length === 1
        ? validMeds[0].drug.trim()
        : `${validMeds.length} ${t("prescriptionsView.toast.medicinesSuffix")}`;
    push(`${t("prescriptionsView.toast.prescriptionSentPrefix")} ${summary} ${t("prescriptionsView.toast.prescriptionSentMiddle")} ${patient.name}`, "emerald");
    setFormOpen(false);
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("prescriptionsView.eyebrow")}
        title={t("prescriptions.title")}
        subtitle={
          refillDue > 0
            ? `${refillDue} ${t("prescriptionsView.refillNeededSuffix")}`
            : t("prescriptionsView.allUpToDate")
        }
        action={
          <button
            onClick={openForm}
            className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <Plus size={14} /> {t("btn.newPrescription")}
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
                <StatusPill label={t(STATUS_LABEL_KEY[p.status])} tone={STATUS_TONE[p.status]} />
              </div>

              <div className="mt-4 flex items-center justify-between text-[11.5px] text-text-tertiary">
                <span>{t("prescriptionsView.prescribedByLabel")} {p.prescribedBy}</span>
                <span className="tabular-nums">{t("prescriptionsView.since")} {formatDate(p.startDate)}</span>
              </div>

              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-tertiary">
                  <span>{t("prescriptionsView.adherence")}</span>
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

              <div className="mt-4 flex items-center gap-2">
                <Link
                  href={`/prescriptions/${p.id}`}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-hairline py-2 text-[12px] font-medium text-text-secondary transition hover:border-hairline-strong hover:text-text-primary"
                >
                  <FileText size={13} /> {t("prescriptionsView.viewDocument")}
                </Link>
                {p.status === "refill-due" && (
                  <button
                    onClick={() => requestRefill(p.id, p.drug)}
                    disabled={requested.has(p.id)}
                    className="flex-1 rounded-full border border-amber/30 bg-amber/10 py-2 text-[12px] font-medium text-amber transition hover:bg-amber/15 disabled:cursor-default disabled:opacity-60"
                  >
                    {requested.has(p.id) ? t("btn.refillRequested") : t("btn.requestRefill")}
                  </button>
                )}
              </div>
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
                <p className="text-[14px] font-semibold text-text-primary">{t("btn.newPrescription")}</p>
                <button
                  onClick={() => setFormOpen(false)}
                  aria-label={t("prescriptionsView.closeAria")}
                  className="text-text-tertiary transition hover:text-text-secondary"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-4 px-5 py-4">
                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    {t("prescriptionsView.sectionPrescribingDoctor")}
                  </p>
                  <div className="space-y-2">
                    <input
                      value={doctorName}
                      onChange={(e) => setDoctorName(e.target.value)}
                      placeholder={t("hospital.doctors.placeholderName")}
                      className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                    />
                    <input
                      value={qualification}
                      onChange={(e) => setQualification(e.target.value)}
                      placeholder={t("hospital.doctors.placeholderQualification")}
                      className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={registrationId}
                        onChange={(e) => setRegistrationId(e.target.value)}
                        placeholder={t("login.field.registrationId")}
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                      <input
                        value={facility}
                        onChange={(e) => setFacility(e.target.value)}
                        placeholder={t("prescriptionsView.placeholderFacility")}
                        className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    {t("prescriptionsView.sectionPrescribingFor")}
                  </p>
                  <div className="flex items-center gap-2.5 rounded-2xl bg-black/[0.035] px-3.5 py-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan/10 text-cyan">
                      <User size={13} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-text-primary">{patient.name}</p>
                      <p className="truncate text-[11px] text-text-tertiary">{patient.patientId}</p>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                      {t("prescriptionsView.sectionMedication")}
                    </p>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="rounded-lg border border-hairline bg-black/[0.025] px-2.5 py-1 text-[11.5px] outline-none focus:border-cyan/40"
                    />
                  </div>
                  <p className="mb-2 text-[10.5px] text-text-tertiary">{t("prescriptionsView.nlemHint")}</p>
                  <div className="space-y-3">
                    {meds.map((m, i) => (
                      <div key={i} className="rounded-2xl border border-hairline p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                            {t("prescriptionsView.medicineNumber")} {i + 1}
                          </span>
                          {meds.length > 1 && (
                            <button
                              onClick={() => removeMedLine(i)}
                              aria-label={t("prescriptionsView.removeMedicineAria")}
                              className="text-text-tertiary transition hover:text-red"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Autocomplete
                            value={m.drug}
                            onChange={(v) => updateMed(i, "drug", v)}
                            options={ESSENTIAL_MEDICINES}
                            placeholder={t("prescriptionsView.placeholderDrugName")}
                            className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              value={m.dose}
                              onChange={(e) => updateMed(i, "dose", e.target.value)}
                              placeholder={t("prescriptionsView.placeholderDose")}
                              className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                            />
                            <input
                              value={m.frequency}
                              onChange={(e) => updateMed(i, "frequency", e.target.value)}
                              placeholder={t("prescriptionsView.placeholderFrequency")}
                              className="w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={addMedLine}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-hairline-strong py-2.5 text-[12px] font-medium text-text-secondary transition hover:border-cyan/40 hover:text-cyan"
                    >
                      <Plus size={13} /> {t("prescriptionsView.addAnotherMedicine")}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-4">
                <button
                  onClick={() => setFormOpen(false)}
                  className="rounded-full border border-hairline px-4 py-2 text-[12.5px] font-medium text-text-secondary transition hover:border-hairline-strong"
                >
                  {t("btn.cancel")}
                </button>
                <button
                  onClick={submitPrescription}
                  className="rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
                >
                  {t("btn.issuePrescription")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
