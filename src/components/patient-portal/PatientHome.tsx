"use client";

import Link from "next/link";
import { AlertCircle, CalendarDays, FileText, Receipt } from "lucide-react";
import { Card, SectionTitle, Empty, Unavailable, usePatientData, formatDateTime, rupees } from "./ui";

type SectionState<T> = { status: "OK"; data: T } | { status: "UNAVAILABLE" };
interface HomeData {
  patientName: string;
  isSelf: boolean;
  nextAppointment: SectionState<{ doctorName: string; department: string | null; scheduledStart: string; statusLabel: string } | null>;
  billing: SectionState<{ outstandingMinor: number; currency: string; invoiceCount: number }>;
  recentReports: SectionState<{ id: string; title: string; date: string; kind: string }[]>;
  actionsRequired: string[];
}

export function PatientHome() {
  const { state } = usePatientData<HomeData>("/api/patient/home");

  if (state.status === "loading") return <Empty>Loading your health summary…</Empty>;
  if (state.status === "error") return <Unavailable label="Your health summary" />;
  const home = state.data;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-semibold">Hello, {home.patientName}</h1>
        <p className="text-[13px] text-text-secondary">Here is what is happening with your care.</p>
      </div>

      {home.actionsRequired.length > 0 && (
        <Card className="border-amber/30 bg-amber/5">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-amber">
            <AlertCircle size={15} /> Needs your attention
          </div>
          <ul className="space-y-1">
            {home.actionsRequired.map((a, i) => (
              <li key={i} className="text-[13px] text-text-primary">• {a}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionTitle>Next appointment</SectionTitle>
        {home.nextAppointment.status === "UNAVAILABLE" ? (
          <Unavailable label="Appointments" />
        ) : home.nextAppointment.data ? (
          <div className="flex items-center gap-3">
            <CalendarDays size={18} className="text-cyan" />
            <div>
              <div className="text-[14px] font-medium">{home.nextAppointment.data.doctorName}</div>
              <div className="text-[12px] text-text-secondary">
                {home.nextAppointment.data.department ?? "Consultation"} · {formatDateTime(home.nextAppointment.data.scheduledStart)} · {home.nextAppointment.data.statusLabel}
              </div>
            </div>
          </div>
        ) : (
          <Empty>You have no upcoming appointments. <Link href="/patient/appointments" className="text-cyan">Book one</Link>.</Empty>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center gap-2"><Receipt size={15} className="text-cyan" /><span className="text-[13px] font-medium">Bills</span></div>
          {home.billing.status === "UNAVAILABLE" ? (
            <Unavailable label="Billing" />
          ) : home.billing.data.outstandingMinor > 0 ? (
            <p className="text-[13px]">{rupees(home.billing.data.outstandingMinor)} due across {home.billing.data.invoiceCount} bill(s). <Link href="/patient/billing" className="text-cyan">View</Link></p>
          ) : (
            <Empty>Nothing due right now.</Empty>
          )}
        </Card>
        <Card>
          <div className="mb-2 flex items-center gap-2"><FileText size={15} className="text-cyan" /><span className="text-[13px] font-medium">Recent reports</span></div>
          {home.recentReports.status === "UNAVAILABLE" ? (
            <Unavailable label="Reports" />
          ) : home.recentReports.data.length ? (
            <ul className="space-y-1">
              {home.recentReports.data.map((r) => (
                <li key={r.id} className="text-[13px]">{r.title}</li>
              ))}
            </ul>
          ) : (
            <Empty>No reports have been shared with you yet.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
