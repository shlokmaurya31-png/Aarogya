"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Pencil, Phone, Plus, Trash2, Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { FormModal, hospitalInputClass } from "@/components/hospital/FormModal";
import { useHospitalOpsStore } from "@/store/useHospitalOpsStore";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { HospitalStaffMember, ShiftId, StaffRole } from "@/types";

const emptyForm = { name: "", role: "nurse" as StaffRole, ward: "", phone: "", shift: "morning" as ShiftId };

export function StaffTab({ hospitalId, staff }: { hospitalId: string; staff: HospitalStaffMember[] }) {
  const { t } = useTranslation();

  const ROLE_LABEL: Record<StaffRole, string> = {
    nurse: t("hospital.role.nurse"),
    technician: t("hospital.role.technician"),
    "ward-boy": t("hospital.role.wardBoy"),
    receptionist: t("hospital.role.receptionist"),
    pharmacist: t("hospital.role.pharmacist"),
    housekeeping: t("hospital.role.housekeeping"),
  };

  const SHIFT_LABEL: Record<ShiftId, string> = {
    morning: t("hospital.shift.morning"),
    evening: t("hospital.shift.evening"),
    night: t("hospital.shift.night"),
  };

  const addStaff = useHospitalOpsStore((s) => s.addStaff);
  const updateStaff = useHospitalOpsStore((s) => s.updateStaff);
  const removeStaff = useHospitalOpsStore((s) => s.removeStaff);
  const toggleStaffDuty = useHospitalOpsStore((s) => s.toggleStaffDuty);
  const push = useToastStore((s) => s.push);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const onDutyCount = staff.filter((m) => m.onDuty).length;

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(m: HospitalStaffMember) {
    setEditingId(m.id);
    setForm({ name: m.name, role: m.role, ward: m.ward, phone: m.phone, shift: m.shift });
    setOpen(true);
  }

  function submit() {
    if (!form.name.trim() || !form.ward.trim()) {
      push(t("hospital.staff.fillRequiredFields"), "amber");
      return;
    }
    const payload = {
      name: form.name.trim(),
      role: form.role,
      ward: form.ward.trim(),
      phone: form.phone.trim() || t("hospital.staff.notProvided"),
      shift: form.shift,
    };
    if (editingId) {
      updateStaff(hospitalId, editingId, payload);
      push(`${payload.name}${t("hospital.staff.detailsUpdated")}`, "emerald");
    } else {
      addStaff(hospitalId, { ...payload, onDuty: true });
      push(`${payload.name} ${t("hospital.staff.addedToStaff")}`, "emerald");
    }
    setOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-text-primary">{t("hospital.staff.title")}</p>
          <p className="text-[12px] text-text-secondary">
            {onDutyCount} {t("hospital.staff.onDutyOf")} {staff.length} {t("hospital.staff.onDutyRightNow")}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
        >
          <Plus size={14} /> {t("hospital.staff.addStaff")}
        </button>
      </div>

      <Card className="p-0">
        <div className="divide-y divide-hairline">
          {staff.map((m, i) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.03 }}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.045] text-[12px] font-medium text-text-secondary">
                  {m.name.charAt(0)}
                </span>
                <div>
                  <p className="text-[13px] font-medium text-text-primary">{m.name}</p>
                  <p className="text-[11.5px] text-text-tertiary">
                    {ROLE_LABEL[m.role]} · {m.ward} · {SHIFT_LABEL[m.shift]}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`tel:${m.phone.replace(/\s/g, "")}`}
                  className="hidden items-center gap-1 text-[11.5px] text-text-tertiary transition hover:text-cyan sm:flex"
                >
                  <Phone size={11} /> {m.phone}
                </a>
                <button onClick={() => toggleStaffDuty(hospitalId, m.id)}>
                  <StatusPill
                    label={m.onDuty ? t("hospital.staff.onDuty") : t("hospital.staff.offDuty")}
                    tone={m.onDuty ? "emerald" : "neutral"}
                  />
                </button>
                <button
                  onClick={() => openEdit(m)}
                  aria-label={`${t("hospital.staff.edit")} ${m.name}`}
                  className="text-text-tertiary transition hover:text-cyan"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => {
                    removeStaff(hospitalId, m.id);
                    push(`${m.name} ${t("hospital.staff.removedFromStaff")}`, "amber");
                  }}
                  aria-label={`${t("hospital.staff.remove")} ${m.name}`}
                  className="text-text-tertiary transition hover:text-red"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </motion.div>
          ))}
          {staff.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
              <Users size={18} className="text-text-tertiary" />
              <p className="text-[13px] text-text-secondary">{t("hospital.staff.emptyState")}</p>
            </div>
          )}
        </div>
      </Card>

      <FormModal
        open={open}
        title={editingId ? t("hospital.staff.editTitle") : t("hospital.staff.addTitle")}
        onClose={() => setOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? t("hospital.staff.saveChanges") : t("hospital.staff.addToStaff")}
      >
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{t("hospital.staff.detailsHeading")}</p>
          <div className="space-y-2">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("login.field.fullName")}
              className={hospitalInputClass}
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as StaffRole }))}
                className={hospitalInputClass}
              >
                {(Object.keys(ROLE_LABEL) as StaffRole[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <input
                value={form.ward}
                onChange={(e) => setForm((f) => ({ ...f, ward: e.target.value }))}
                placeholder={t("hospital.staff.placeholderWard")}
                className={hospitalInputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder={t("hospital.staff.placeholderPhone")}
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
