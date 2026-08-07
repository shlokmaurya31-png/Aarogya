"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { patient } from "@/lib/mock-data";
import { useRecordsStore } from "@/store/useRecordsStore";
import { useTranslation } from "@/hooks/useTranslation";

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function PrescriptionDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const prescription = useRecordsStore((s) => s.prescriptions.find((p) => p.id === id));
  const { t } = useTranslation();

  if (!prescription) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ink px-4 text-center">
        <p className="text-[14px] text-text-secondary">{t("prescriptionDoc.notFound")}</p>
        <Link href="/dashboard" className="text-[13px] text-cyan hover:underline">
          {t("prescriptionDoc.backToDashboard")}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink px-4 py-10 print:bg-white print:py-0">
      <div className="mx-auto flex w-full max-w-[720px] items-center justify-between print:hidden">
        <Link
          href="/dashboard"
          className="flex items-center gap-1.5 text-[13px] text-text-secondary transition hover:text-text-primary"
        >
          <ArrowLeft size={14} /> {t("prescriptionDoc.action.back")}
        </Link>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
        >
          <Printer size={14} /> {t("prescriptionDoc.action.print")}
        </button>
      </div>

      <div className="mx-auto mt-6 w-full max-w-[720px] rounded-2xl border border-black/10 bg-white p-8 text-neutral-900 shadow-xl print:mt-0 print:rounded-none print:border-0 print:p-8 print:shadow-none sm:p-10">
        <div className="border-b-2 border-neutral-900 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500">
                {t("prescriptionDoc.eyebrow")}
              </p>
              <h1 className="mt-1 text-[20px] font-semibold text-neutral-900">{prescription.facility}</h1>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-neutral-500">{t("prescriptionDoc.label.prescriptionId")}</p>
              <p className="font-mono text-[12px] text-neutral-700">{prescription.id.toUpperCase()}</p>
            </div>
          </div>

          <div className="mt-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[16px] font-semibold text-neutral-900">{prescription.prescribedBy}</p>
              <p className="text-[12.5px] text-neutral-600">{prescription.qualification}</p>
              <p className="text-[12px] text-neutral-500">
                {t("prescriptionDoc.label.regNo")} {prescription.registrationId}
              </p>
            </div>
            <p className="text-[12px] text-neutral-500">
              {t("prescriptionDoc.label.issued")} {formatDate(prescription.startDate)}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-neutral-50 px-4 py-3 text-[12.5px] print:border print:border-neutral-300 print:bg-transparent sm:grid-cols-4">
          <div>
            <p className="text-neutral-500">{t("prescriptionDoc.label.patient")}</p>
            <p className="font-medium text-neutral-900">{patient.name}</p>
          </div>
          <div>
            <p className="text-neutral-500">{t("prescriptionDoc.label.patientId")}</p>
            <p className="font-medium text-neutral-900">{patient.patientId}</p>
          </div>
          <div>
            <p className="text-neutral-500">{t("prescriptionDoc.label.ageGender")}</p>
            <p className="font-medium text-neutral-900">
              {patient.age} {t("prescriptionDoc.label.yrs")}, {patient.gender}
            </p>
          </div>
          <div>
            <p className="text-neutral-500">{t("prescriptionDoc.label.bloodGroup")}</p>
            <p className="font-medium text-neutral-900">{patient.bloodGroup}</p>
          </div>
        </div>

        <div className="mt-6">
          <p className="font-serif text-[26px] italic text-neutral-900">℞</p>
          <div className="mt-2 overflow-hidden rounded-xl border border-neutral-200">
            <table className="w-full text-[13px]">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t("prescriptionDoc.label.medicine")}</th>
                  <th className="px-4 py-2 text-left font-medium">{t("prescriptionDoc.label.dose")}</th>
                  <th className="px-4 py-2 text-left font-medium">{t("prescriptionDoc.label.frequency")}</th>
                  <th className="px-4 py-2 text-left font-medium">{t("prescriptionDoc.label.status")}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-neutral-200">
                  <td className="px-4 py-3 font-medium text-neutral-900">{prescription.drug}</td>
                  <td className="px-4 py-3 text-neutral-700">{prescription.dose}</td>
                  <td className="px-4 py-3 text-neutral-700">{prescription.frequency}</td>
                  <td className="px-4 py-3 capitalize text-neutral-700">{prescription.status.replace("-", " ")}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-10 flex items-end justify-between gap-4 border-t border-neutral-200 pt-4">
          <p className="max-w-[260px] text-[10.5px] text-neutral-400">{t("prescriptionDoc.footer.disclaimer")}</p>
          <div className="text-right">
            <p className="font-serif text-[18px] italic text-neutral-800">{prescription.prescribedBy}</p>
            <p className="text-[11px] text-neutral-500">
              {t("prescriptionDoc.label.regNo")} {prescription.registrationId}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
