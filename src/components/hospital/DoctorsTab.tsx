"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Pencil, Phone, Plus, Stethoscope, Trash2, UserCog, Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { FormModal, hospitalInputClass } from "@/components/hospital/FormModal";
import { useHospitalOpsStore } from "@/store/useHospitalOpsStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { HospitalAdmission, HospitalDoctorEntry, ShiftId } from "@/types";

const emptyForm = { name: "", specialty: "", qualification: "", registrationId: "", phone: "", shift: "morning" as ShiftId };

export function DoctorsTab({
  hospitalId,
  doctors,
  admissions,
}: {
  hospitalId: string;
  doctors: HospitalDoctorEntry[];
  admissions: HospitalAdmission[];
}) {
  const { t } = useTranslation();
  const addDoctor = useHospitalOpsStore((s) => s.addDoctor);
  const updateDoctor = useHospitalOpsStore((s) => s.updateDoctor);
  const removeDoctor = useHospitalOpsStore((s) => s.removeDoctor);
  const toggleDoctorDuty = useHospitalOpsStore((s) => s.toggleDoctorDuty);
  const push = useToastStore((s) => s.push);

  const SHIFT_LABEL: Record<ShiftId, string> = {
    morning: t("hospital.shift.morning"),
    evening: t("hospital.shift.evening"),
    night: t("hospital.shift.night"),
  };

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const onDutyCount = doctors.filter((d) => d.onDuty).length;

  function patientsUnder(doctorId: string) {
    return admissions.filter((a) => a.doctorId === doctorId && a.status !== "discharged").length;
  }

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(d: HospitalDoctorEntry) {
    setEditingId(d.id);
    setForm({
      name: d.name,
      specialty: d.specialty,
      qualification: d.qualification,
      registrationId: d.registrationId,
      phone: d.phone,
      shift: d.shift,
    });
    setOpen(true);
  }

  function submit() {
    if (!form.name.trim() || !form.specialty.trim() || !form.qualification.trim() || !form.registrationId.trim()) {
      push(t("hospital.doctors.validationError"), "amber");
      return;
    }
    const payload = {
      name: form.name.trim(),
      specialty: form.specialty.trim(),
      qualification: form.qualification.trim(),
      registrationId: form.registrationId.trim(),
      phone: form.phone.trim() || t("hospital.doctors.notProvided"),
      shift: form.shift,
    };
    if (editingId) {
      updateDoctor(hospitalId, editingId, payload);
      push(`${payload.name}'s ${t("hospital.doctors.detailsUpdated")}`, "emerald");
    } else {
      addDoctor(hospitalId, { ...payload, onDuty: true });
      push(`${payload.name} ${t("hospital.doctors.addedToRoster")}`, "emerald");
    }
    setOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-text-primary">{t("hospital.doctors.rosterTitle")}</p>
          <p className="text-[12px] text-text-secondary">
            {onDutyCount} {t("hospital.doctors.of")} {doctors.length} {t("hospital.doctors.onDutyRightNow")}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
        >
          <Plus size={14} /> {t("hospital.doctors.addDoctor")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {doctors.map((d, i) => (
          <motion.div
            key={d.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.03 }}
          >
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
                    <Stethoscope size={17} />
                  </span>
                  <div>
                    <p className="text-[13.5px] font-medium text-text-primary">{d.name}</p>
                    <p className="text-[12px] text-text-secondary">{d.specialty}</p>
                    <p className="mt-0.5 text-[11px] text-text-tertiary">{d.qualification}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <button
                    onClick={() => openEdit(d)}
                    aria-label={`${t("hospital.doctors.editAria")} ${d.name}`}
                    className="text-text-tertiary transition hover:text-cyan"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => {
                      removeDoctor(hospitalId, d.id);
                      push(`${d.name} ${t("hospital.doctors.removedFromRoster")}`, "amber");
                    }}
                    aria-label={`${t("hospital.doctors.removeAria")} ${d.name}`}
                    className="text-text-tertiary transition hover:text-red"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-tertiary">
                <span>{t("prescriptionDoc.label.regNo")} {d.registrationId}</span>
                <a
                  href={`tel:${d.phone.replace(/\s/g, "")}`}
                  className="flex items-center gap-1 transition hover:text-cyan"
                >
                  <Phone size={11} /> {d.phone}
                </a>
                <span className="flex items-center gap-1">
                  <Users size={11} /> {patientsUnder(d.id)}{" "}
                  {patientsUnder(d.id) === 1 ? t("hospital.doctors.patient") : t("hospital.doctors.patients")}{" "}
                  {t("hospital.doctors.underCare")}
                </span>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-text-tertiary">{SHIFT_LABEL[d.shift]}</span>
                <button onClick={() => toggleDoctorDuty(hospitalId, d.id)}>
                  <StatusPill
                    label={d.onDuty ? t("hospital.doctors.onDuty") : t("hospital.doctors.offDuty")}
                    tone={d.onDuty ? "emerald" : "neutral"}
                  />
                </button>
              </div>
            </Card>
          </motion.div>
        ))}
        {doctors.length === 0 && (
          <Card className="col-span-full flex flex-col items-center gap-2 py-8 text-center">
            <UserCog size={18} className="text-text-tertiary" />
            <p className="text-[13px] text-text-secondary">{t("hospital.doctors.emptyState")}</p>
          </Card>
        )}
      </div>

      <FormModal
        open={open}
        title={editingId ? t("hospital.doctors.editDoctor") : t("hospital.doctors.addDoctor")}
        onClose={() => setOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? t("hospital.doctors.saveChanges") : t("hospital.doctors.addToRoster")}
      >
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
            {t("hospital.doctors.detailsLabel")}
          </p>
          <div className="space-y-2">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("hospital.doctors.placeholderName")}
              className={hospitalInputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.specialty}
                onChange={(e) => setForm((f) => ({ ...f, specialty: e.target.value }))}
                placeholder={t("login.field.specialty")}
                className={hospitalInputClass}
              />
              <input
                value={form.registrationId}
                onChange={(e) => setForm((f) => ({ ...f, registrationId: e.target.value }))}
                placeholder={t("login.field.registrationId")}
                className={hospitalInputClass}
              />
            </div>
            <input
              value={form.qualification}
              onChange={(e) => setForm((f) => ({ ...f, qualification: e.target.value }))}
              placeholder={t("hospital.doctors.placeholderQualification")}
              className={hospitalInputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder={t("hospital.doctors.placeholderPhone")}
                className={hospitalInputClass}
              />
              <select
                value={form.shift}
                onChange={(e) => setForm((f) => ({ ...f, shift: e.target.value as ShiftId }))}
                className={hospitalInputClass}
              >
                {(Object.keys(SHIFT_LABEL) as ShiftId[]).map((s) => (
                  <option key={s} value={s}>
                    {SHIFT_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </FormModal>
    </div>
  );
}
