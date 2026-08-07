"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BedSingle,
  ChevronDown,
  ClipboardList,
  FileText,
  Heart,
  LogOut as DischargeIcon,
  MessageSquarePlus,
  Phone,
  Plus,
  ShieldCheck,
  Thermometer,
  UserRound,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { FormModal, hospitalInputClass } from "@/components/hospital/FormModal";
import { useHospitalOpsStore } from "@/store/useHospitalOpsStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { AdmissionStatus, BedCategory, HospitalAdmission, HospitalBedAvailability, HospitalDoctorEntry } from "@/types";

const STATUS_TONE: Record<AdmissionStatus, "emerald" | "red" | "neutral"> = {
  admitted: "emerald",
  critical: "red",
  discharged: "neutral",
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(d: string) {
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const emptyForm = {
  patientName: "",
  age: "",
  gender: "Female",
  ward: "general" as BedCategory,
  doctorId: "",
  diagnosis: "",
  diagnosisCode: "",
  insuranceProvider: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
};

const emptyVitals = { bp: "", heartRate: "", temperatureF: "", spo2: "" };
const emptyNote = { authorName: "", authorRole: "doctor" as "doctor" | "nurse", text: "" };

export function PatientsTab({
  hospitalId,
  hospital,
  admissions,
  doctors,
  quickAdmit,
}: {
  hospitalId: string;
  hospital: HospitalBedAvailability;
  admissions: HospitalAdmission[];
  doctors: HospitalDoctorEntry[];
  quickAdmit?: { ward: BedCategory; token: number } | null;
}) {
  const admitPatient = useHospitalOpsStore((s) => s.admitPatient);
  const dischargePatient = useHospitalOpsStore((s) => s.dischargePatient);
  const transferPatient = useHospitalOpsStore((s) => s.transferPatient);
  const setAdmissionCritical = useHospitalOpsStore((s) => s.setAdmissionCritical);
  const addClinicalNote = useHospitalOpsStore((s) => s.addClinicalNote);
  const updateVitals = useHospitalOpsStore((s) => s.updateVitals);
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  const WARD_LABEL: Record<BedCategory, string> = {
    emergency: t("hospital.ward.emergency"),
    icu: t("hospital.ward.icu"),
    general: t("hospital.ward.general"),
  };
  const STATUS_LABEL: Record<AdmissionStatus, string> = {
    admitted: t("hospital.patients.admitted"),
    critical: t("hospital.patients.critical"),
    discharged: t("hospital.patients.discharged"),
  };

  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"active" | "discharged">("active");
  const [wardFilter, setWardFilter] = useState<"all" | BedCategory>("all");
  const [form, setForm] = useState(emptyForm);
  const [transferring, setTransferring] = useState<HospitalAdmission | null>(null);
  const [transferWard, setTransferWard] = useState<BedCategory>("general");
  const [seenQuickAdmitToken, setSeenQuickAdmitToken] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [vitalsFor, setVitalsFor] = useState<HospitalAdmission | null>(null);
  const [vitalsForm, setVitalsForm] = useState(emptyVitals);
  const [noteFor, setNoteFor] = useState<HospitalAdmission | null>(null);
  const [noteForm, setNoteForm] = useState(emptyNote);

  const visible = useMemo(
    () =>
      admissions
        .filter((a) => (statusFilter === "active" ? a.status !== "discharged" : a.status === "discharged"))
        .filter((a) => wardFilter === "all" || a.ward === wardFilter),
    [admissions, statusFilter, wardFilter]
  );

  const freeFor = (ward: BedCategory) =>
    ward === "emergency" ? hospital.emergencyBeds : ward === "icu" ? hospital.icuBeds : hospital.generalBeds;

  function phoneFor(doctorId: string) {
    return doctors.find((d) => d.id === doctorId)?.phone ?? null;
  }

  function openForm(presetWard?: BedCategory) {
    setForm({ ...emptyForm, ward: presetWard ?? "general", doctorId: doctors[0]?.id ?? "" });
    setOpen(true);
  }

  if (quickAdmit && quickAdmit.token !== seenQuickAdmitToken) {
    setSeenQuickAdmitToken(quickAdmit.token);
    setForm({ ...emptyForm, ward: quickAdmit.ward, doctorId: doctors[0]?.id ?? "" });
    setOpen(true);
  }

  function submit() {
    const age = Number(form.age);
    const doctor = doctors.find((d) => d.id === form.doctorId);
    if (!form.patientName.trim() || !age || age <= 0 || !doctor || !form.diagnosis.trim()) {
      push(t("hospital.patients.fillRequiredFields"), "amber");
      return;
    }
    const result = admitPatient(hospitalId, {
      patientName: form.patientName.trim(),
      age,
      gender: form.gender,
      ward: form.ward,
      doctorId: doctor.id,
      doctorName: doctor.name,
      diagnosis: form.diagnosis.trim(),
      diagnosisCode: form.diagnosisCode.trim() || t("hospital.patients.codePending"),
      insuranceProvider: form.insuranceProvider.trim() || t("hospital.patients.notInsured"),
      emergencyContactName: form.emergencyContactName.trim() || t("hospital.patients.notProvided"),
      emergencyContactPhone: form.emergencyContactPhone.trim() || t("hospital.patients.notProvided"),
    });
    if (!result.ok) {
      push(result.error, "amber");
      return;
    }
    push(`${form.patientName.trim()} ${t("hospital.patients.admittedToWard")} ${WARD_LABEL[form.ward]}.`, "emerald");
    setOpen(false);
  }

  function openVitals(a: HospitalAdmission) {
    setVitalsFor(a);
    setVitalsForm({
      bp: a.vitals.bp === "—" ? "" : a.vitals.bp,
      heartRate: a.vitals.heartRate ? String(a.vitals.heartRate) : "",
      temperatureF: a.vitals.temperatureF ? String(a.vitals.temperatureF) : "",
      spo2: a.vitals.spo2 ? String(a.vitals.spo2) : "",
    });
  }

  function submitVitals() {
    if (!vitalsFor) return;
    if (!vitalsForm.bp.trim() || !vitalsForm.heartRate || !vitalsForm.temperatureF || !vitalsForm.spo2) {
      push(t("hospital.patients.fillRequiredFields"), "amber");
      return;
    }
    updateVitals(hospitalId, vitalsFor.id, {
      bp: vitalsForm.bp.trim(),
      heartRate: Number(vitalsForm.heartRate),
      temperatureF: Number(vitalsForm.temperatureF),
      spo2: Number(vitalsForm.spo2),
    });
    push(`${t("hospital.patients.vitalsUpdatedFor")} ${vitalsFor.patientName}.`, "cyan");
    setVitalsFor(null);
  }

  function openNote(a: HospitalAdmission) {
    setNoteFor(a);
    setNoteForm(emptyNote);
  }

  function submitNote() {
    if (!noteFor) return;
    if (!noteForm.authorName.trim() || !noteForm.text.trim()) {
      push(t("hospital.patients.fillRequiredFields"), "amber");
      return;
    }
    addClinicalNote(hospitalId, noteFor.id, {
      authorName: noteForm.authorName.trim(),
      authorRole: noteForm.authorRole,
      text: noteForm.text.trim(),
    });
    push(`${t("hospital.patients.noteAddedFor")} ${noteFor.patientName}.`, "emerald");
    setNoteFor(null);
  }

  function openTransfer(a: HospitalAdmission) {
    setTransferring(a);
    setTransferWard((["emergency", "icu", "general"] as BedCategory[]).find((w) => w !== a.ward) ?? "general");
  }

  function submitTransfer() {
    if (!transferring) return;
    const result = transferPatient(hospitalId, transferring.id, transferWard);
    if (!result.ok) {
      push(result.error, "amber");
      return;
    }
    push(`${transferring.patientName} ${t("hospital.patients.transferredToWard")} ${WARD_LABEL[transferWard]}.`, "cyan");
    setTransferring(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-text-primary">{t("hospital.patients.title")}</p>
          <p className="text-[12px] text-text-secondary">
            {admissions.filter((a) => a.status !== "discharged").length} {t("hospital.patients.currentlyAdmitted")} ·{" "}
            {admissions.filter((a) => a.status === "critical").length} {t("hospital.patients.critical")}
          </p>
        </div>
        <button
          onClick={() => openForm()}
          disabled={doctors.length === 0}
          className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} /> {t("hospital.patients.admitPatient")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
          {(["active", "discharged"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-[11.5px] capitalize transition",
                statusFilter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
              )}
            >
              {f === "active" ? t("hospital.patients.filterActive") : t("hospital.patients.discharged")}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
          {(["all", "emergency", "icu", "general"] as const).map((w) => (
            <button
              key={w}
              onClick={() => setWardFilter(w)}
              className={cn(
                "rounded-full px-3 py-1 text-[11.5px] transition",
                wardFilter === w ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
              )}
            >
              {w === "all" ? t("hospital.patients.allWards") : WARD_LABEL[w]}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {visible.map((a, i) => {
          const phone = phoneFor(a.doctorId);
          return (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.03 }}
            >
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
                      <BedSingle size={17} />
                    </span>
                    <div>
                      <p className="text-[13.5px] font-medium text-text-primary">
                        {a.patientName} <span className="font-normal text-text-tertiary">· {a.age}y, {a.gender}</span>
                      </p>
                      <p className="mt-0.5 text-[12px] text-text-secondary">
                        {a.diagnosis} <span className="text-text-tertiary">· {a.diagnosisCode}</span>
                      </p>
                      <p className="mt-1 text-[11px] text-text-tertiary">
                        {WARD_LABEL[a.ward]} · {t("hospital.patients.bedLabel")} {a.bedLabel} · {t("hospital.patients.underDoctor")} {a.doctorName} · {t("hospital.patients.admittedLabel")} {formatDate(a.admittedAt)}
                        {a.dischargedAt ? ` · ${t("hospital.patients.discharged")} ${formatDate(a.dischargedAt)}` : ""}
                      </p>
                      {phone && (
                        <a
                          href={`tel:${phone.replace(/\s/g, "")}`}
                          className="mt-1 flex items-center gap-1 text-[11px] text-cyan transition hover:underline"
                        >
                          <Phone size={10} /> {t("hospital.patients.call")} {a.doctorName}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <StatusPill label={STATUS_LABEL[a.status]} tone={STATUS_TONE[a.status]} />
                    <button
                      onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                      className="flex items-center gap-1 text-[11px] text-text-tertiary transition hover:text-cyan"
                    >
                      {expandedId === a.id ? t("hospital.patients.hideDetails") : t("hospital.patients.viewDetails")}
                      <ChevronDown size={12} className={cn("transition-transform", expandedId === a.id && "rotate-180")} />
                    </button>
                  </div>
                </div>

                {expandedId === a.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    transition={{ duration: 0.2 }}
                    className="mt-3 space-y-3 overflow-hidden border-t border-hairline pt-3"
                  >
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded-xl border border-hairline px-3 py-2">
                        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                          <Heart size={10} /> {t("hospital.patients.vitalsBp")}
                        </p>
                        <p className="mt-0.5 text-[13px] font-medium tabular-nums text-text-primary">{a.vitals.bp}</p>
                      </div>
                      <div className="rounded-xl border border-hairline px-3 py-2">
                        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                          <Activity size={10} /> {t("hospital.patients.vitalsHr")}
                        </p>
                        <p className="mt-0.5 text-[13px] font-medium tabular-nums text-text-primary">
                          {a.vitals.heartRate || "—"}
                        </p>
                      </div>
                      <div className="rounded-xl border border-hairline px-3 py-2">
                        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                          <Thermometer size={10} /> {t("hospital.patients.vitalsTemp")}
                        </p>
                        <p className="mt-0.5 text-[13px] font-medium tabular-nums text-text-primary">
                          {a.vitals.temperatureF || "—"}
                        </p>
                      </div>
                      <div className="rounded-xl border border-hairline px-3 py-2">
                        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                          <Activity size={10} /> {t("hospital.patients.vitalsSpo2")}
                        </p>
                        <p className="mt-0.5 text-[13px] font-medium tabular-nums text-text-primary">
                          {a.vitals.spo2 || "—"}
                        </p>
                      </div>
                    </div>
                    <p className="text-[10.5px] text-text-tertiary">
                      {t("hospital.patients.vitalsLastRecorded")} {formatDateTime(a.vitals.recordedAt)}
                    </p>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2">
                        <ShieldCheck size={13} className="shrink-0 text-cyan" />
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary">{t("hospital.patients.insuranceLabel")}</p>
                          <p className="truncate text-[12px] text-text-primary">{a.insuranceProvider}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2">
                        <UserRound size={13} className="shrink-0 text-cyan" />
                        <div className="min-w-0">
                          <p className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary">{t("hospital.patients.emergencyContactLabel")}</p>
                          <p className="truncate text-[12px] text-text-primary">
                            {a.emergencyContactName} · {a.emergencyContactPhone}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                          <FileText size={10} /> {t("hospital.patients.clinicalNotesLabel")}
                        </p>
                        {a.status !== "discharged" && (
                          <button
                            onClick={() => openNote(a)}
                            className="flex items-center gap-1 text-[11px] text-cyan transition hover:underline"
                          >
                            <MessageSquarePlus size={11} /> {t("hospital.patients.addNote")}
                          </button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {a.notes.length === 0 && (
                          <p className="text-[11.5px] text-text-tertiary">{t("hospital.patients.noNotesYet")}</p>
                        )}
                        {a.notes.map((n) => (
                          <div key={n.id} className="rounded-xl bg-black/[0.025] px-3 py-2">
                            <p className="text-[11.5px] text-text-primary">{n.text}</p>
                            <p className="mt-1 text-[10px] text-text-tertiary">
                              {n.authorName} · {n.authorRole === "doctor" ? t("hospital.patients.roleDoctor") : t("hospital.patients.roleNurse")} · {formatDateTime(n.timestamp)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {a.status !== "discharged" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => openVitals(a)}
                      className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
                    >
                      <Activity size={12} /> {t("hospital.patients.updateVitals")}
                    </button>
                    <button
                      onClick={() => setAdmissionCritical(hospitalId, a.id, a.status !== "critical")}
                      className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition hover:border-red/30 hover:text-red"
                    >
                      <AlertTriangle size={12} /> {a.status === "critical" ? t("hospital.patients.markStable") : t("hospital.patients.markCritical")}
                    </button>
                    <button
                      onClick={() => openTransfer(a)}
                      className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
                    >
                      <ArrowLeftRight size={12} /> {t("hospital.patients.transferWard")}
                    </button>
                    <button
                      onClick={() => {
                        dischargePatient(hospitalId, a.id);
                        push(`${a.patientName} ${t("hospital.patients.dischargedBedFreedIn")} ${WARD_LABEL[a.ward]}.`, "cyan");
                      }}
                      className="flex items-center gap-1.5 rounded-full border border-emerald/30 bg-emerald/10 px-3.5 py-1.5 text-[11.5px] font-medium text-emerald transition hover:bg-emerald/15"
                    >
                      <DischargeIcon size={12} /> {t("hospital.patients.dischargeAction")}
                    </button>
                  </div>
                )}
              </Card>
            </motion.div>
          );
        })}
        {visible.length === 0 && (
          <Card className="flex flex-col items-center gap-2 py-8 text-center">
            <ClipboardList size={18} className="text-text-tertiary" />
            <p className="text-[13px] text-text-secondary">
              {statusFilter === "active" ? t("hospital.patients.emptyActive") : t("hospital.patients.emptyDischarged")}
            </p>
          </Card>
        )}
      </div>

      <FormModal
        open={open}
        title={t("hospital.patients.admitPatient")}
        onClose={() => setOpen(false)}
        onSubmit={submit}
        submitLabel={t("hospital.patients.admitPatient")}
      >
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{t("hospital.patients.patientDetails")}</p>
          <div className="space-y-2">
            <input
              value={form.patientName}
              onChange={(e) => setForm((f) => ({ ...f, patientName: e.target.value }))}
              placeholder={t("hospital.patients.patientName")}
              className={hospitalInputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min={0}
                value={form.age}
                onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))}
                placeholder={t("hospital.patients.age")}
                className={hospitalInputClass}
              />
              <select
                value={form.gender}
                onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
                className={hospitalInputClass}
              >
                <option value="Female">{t("onboarding.gender.female")}</option>
                <option value="Male">{t("onboarding.gender.male")}</option>
                <option value="Other">{t("onboarding.gender.other")}</option>
              </select>
            </div>
            <textarea
              value={form.diagnosis}
              onChange={(e) => setForm((f) => ({ ...f, diagnosis: e.target.value }))}
              placeholder={t("hospital.patients.diagnosisPlaceholder")}
              rows={2}
              className={cn(hospitalInputClass, "resize-none")}
            />
            <input
              value={form.diagnosisCode}
              onChange={(e) => setForm((f) => ({ ...f, diagnosisCode: e.target.value }))}
              placeholder={t("hospital.patients.diagnosisCodePlaceholder")}
              className={hospitalInputClass}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{t("hospital.patients.insuranceAndContact")}</p>
          <div className="space-y-2">
            <input
              value={form.insuranceProvider}
              onChange={(e) => setForm((f) => ({ ...f, insuranceProvider: e.target.value }))}
              placeholder={t("hospital.patients.insurancePlaceholder")}
              className={hospitalInputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.emergencyContactName}
                onChange={(e) => setForm((f) => ({ ...f, emergencyContactName: e.target.value }))}
                placeholder={t("hospital.patients.emergencyContactNamePlaceholder")}
                className={hospitalInputClass}
              />
              <input
                value={form.emergencyContactPhone}
                onChange={(e) => setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))}
                placeholder={t("hospital.patients.emergencyContactPhonePlaceholder")}
                className={hospitalInputClass}
              />
            </div>
          </div>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{t("hospital.patients.wardAndDoctor")}</p>
          <div className="space-y-2">
            <select
              value={form.ward}
              onChange={(e) => setForm((f) => ({ ...f, ward: e.target.value as BedCategory }))}
              className={hospitalInputClass}
            >
              {(["emergency", "icu", "general"] as BedCategory[]).map((w) => (
                <option key={w} value={w} disabled={freeFor(w) <= 0}>
                  {WARD_LABEL[w]} ({freeFor(w)} {freeFor(w) === 1 ? t("hospital.patients.bedFree") : t("hospital.patients.bedsFree")})
                </option>
              ))}
            </select>
            <select
              value={form.doctorId}
              onChange={(e) => setForm((f) => ({ ...f, doctorId: e.target.value }))}
              className={hospitalInputClass}
            >
              {doctors.length === 0 && <option value="">{t("hospital.patients.addDoctorFirst")}</option>}
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.specialty}
                </option>
              ))}
            </select>
          </div>
        </div>
      </FormModal>

      <FormModal
        open={transferring !== null}
        title={transferring ? `${t("hospital.patients.transferAction")} ${transferring.patientName}` : t("hospital.patients.transferPatientTitle")}
        onClose={() => setTransferring(null)}
        onSubmit={submitTransfer}
        submitLabel={t("hospital.patients.confirmTransfer")}
      >
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
            {t("hospital.patients.currentlyIn")} {transferring ? WARD_LABEL[transferring.ward] : ""}, {t("hospital.patients.bedLabel")} {transferring?.bedLabel}
          </p>
          <select
            value={transferWard}
            onChange={(e) => setTransferWard(e.target.value as BedCategory)}
            className={hospitalInputClass}
          >
            {(["emergency", "icu", "general"] as BedCategory[])
              .filter((w) => w !== transferring?.ward)
              .map((w) => (
                <option key={w} value={w} disabled={freeFor(w) <= 0}>
                  {WARD_LABEL[w]} ({freeFor(w)} {freeFor(w) === 1 ? t("hospital.patients.bedFree") : t("hospital.patients.bedsFree")})
                </option>
              ))}
          </select>
        </div>
      </FormModal>

      <FormModal
        open={vitalsFor !== null}
        title={vitalsFor ? `${t("hospital.patients.updateVitals")} · ${vitalsFor.patientName}` : t("hospital.patients.updateVitals")}
        onClose={() => setVitalsFor(null)}
        onSubmit={submitVitals}
        submitLabel={t("hospital.patients.saveVitals")}
      >
        <div className="grid grid-cols-2 gap-2">
          <input
            value={vitalsForm.bp}
            onChange={(e) => setVitalsForm((f) => ({ ...f, bp: e.target.value }))}
            placeholder={t("hospital.patients.vitalsBpPlaceholder")}
            className={hospitalInputClass}
          />
          <input
            type="number"
            min={0}
            value={vitalsForm.heartRate}
            onChange={(e) => setVitalsForm((f) => ({ ...f, heartRate: e.target.value }))}
            placeholder={t("hospital.patients.vitalsHrPlaceholder")}
            className={hospitalInputClass}
          />
          <input
            type="number"
            step="0.1"
            min={0}
            value={vitalsForm.temperatureF}
            onChange={(e) => setVitalsForm((f) => ({ ...f, temperatureF: e.target.value }))}
            placeholder={t("hospital.patients.vitalsTempPlaceholder")}
            className={hospitalInputClass}
          />
          <input
            type="number"
            min={0}
            max={100}
            value={vitalsForm.spo2}
            onChange={(e) => setVitalsForm((f) => ({ ...f, spo2: e.target.value }))}
            placeholder={t("hospital.patients.vitalsSpo2Placeholder")}
            className={hospitalInputClass}
          />
        </div>
      </FormModal>

      <FormModal
        open={noteFor !== null}
        title={noteFor ? `${t("hospital.patients.addNote")} · ${noteFor.patientName}` : t("hospital.patients.addNote")}
        onClose={() => setNoteFor(null)}
        onSubmit={submitNote}
        submitLabel={t("hospital.patients.saveNote")}
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={noteForm.authorName}
              onChange={(e) => setNoteForm((f) => ({ ...f, authorName: e.target.value }))}
              placeholder={t("hospital.patients.noteAuthorPlaceholder")}
              className={hospitalInputClass}
            />
            <select
              value={noteForm.authorRole}
              onChange={(e) => setNoteForm((f) => ({ ...f, authorRole: e.target.value as "doctor" | "nurse" }))}
              className={hospitalInputClass}
            >
              <option value="doctor">{t("hospital.patients.roleDoctor")}</option>
              <option value="nurse">{t("hospital.patients.roleNurse")}</option>
            </select>
          </div>
          <textarea
            value={noteForm.text}
            onChange={(e) => setNoteForm((f) => ({ ...f, text: e.target.value }))}
            placeholder={t("hospital.patients.notePlaceholder")}
            rows={3}
            className={cn(hospitalInputClass, "resize-none")}
          />
        </div>
      </FormModal>
    </div>
  );
}
