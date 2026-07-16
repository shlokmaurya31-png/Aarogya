"use client";

import { motion } from "framer-motion";
import { ShieldCheck, BadgeCheck } from "lucide-react";
import { patient } from "@/lib/mock-data";
import { Card, CardLabel } from "@/components/ui/Card";

const STATS = [
  { label: "Age", value: `${patient.age}` },
  { label: "Gender", value: patient.gender },
  { label: "Height", value: patient.height },
  { label: "Weight", value: patient.weight },
  { label: "Blood Group", value: patient.bloodGroup },
];

export function PatientCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
    >
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <CardLabel>Patient Profile</CardLabel>
            <h3 className="mt-1 text-[16px] font-semibold">{patient.name}</h3>
          </div>
          <div className="flex gap-1.5">
            {patient.aadhaarLinked && (
              <span className="flex items-center gap-1 rounded-full bg-cyan/10 px-2.5 py-1 text-[10px] font-medium text-cyan">
                <BadgeCheck size={11} /> Aadhaar
              </span>
            )}
            <span className="flex items-center gap-1 rounded-full bg-emerald/10 px-2.5 py-1 text-[10px] font-medium text-emerald">
              <ShieldCheck size={11} /> ABHA
            </span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2">
          {STATS.map((s) => (
            <div key={s.label} className="rounded-2xl bg-white/[0.03] px-3 py-2.5 text-center">
              <p className="tabular-nums text-[14px] font-semibold">{s.value}</p>
              <p className="mt-0.5 text-[10px] text-text-tertiary">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
          <div className="rounded-2xl border border-hairline px-3.5 py-3">
            <p className="text-text-tertiary">Allergies</p>
            <p className="mt-1 font-medium text-amber">{patient.allergies.join(", ")}</p>
          </div>
          <div className="rounded-2xl border border-hairline px-3.5 py-3">
            <p className="text-text-tertiary">Ayushman Bharat</p>
            <p className="mt-1 font-medium capitalize text-emerald">{patient.ayushmanBharat}</p>
          </div>
          <div className="rounded-2xl border border-hairline px-3.5 py-3">
            <p className="text-text-tertiary">Insurance</p>
            <p className="mt-1 font-medium text-text-primary">{patient.insurance}</p>
          </div>
          <div className="rounded-2xl border border-hairline px-3.5 py-3">
            <p className="text-text-tertiary">ABHA Number</p>
            <p className="mt-1 font-medium tabular-nums text-text-primary">{patient.abhaNumber}</p>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
