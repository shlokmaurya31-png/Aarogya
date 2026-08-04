"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Check, LogOut, ShieldCheck, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useAuthStore } from "@/store/useAuthStore";
import { useToastStore } from "@/store/useToastStore";
import type { DoctorApplication } from "@/types";

const STATUS_TONE: Record<DoctorApplication["status"], "amber" | "emerald" | "red"> = {
  pending: "amber",
  verified: "emerald",
  rejected: "red",
};

const FILTERS = ["all", "pending", "verified", "rejected"] as const;
type Filter = (typeof FILTERS)[number];

export default function AdminPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const doctorApplications = useAuthStore((s) => s.doctorApplications);
  const approveDoctorApplication = useAuthStore((s) => s.approveDoctorApplication);
  const rejectDoctorApplication = useAuthStore((s) => s.rejectDoctorApplication);
  const logout = useAuthStore((s) => s.logout);
  const push = useToastStore((s) => s.push);
  const [filter, setFilter] = useState<Filter>("pending");

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user || user.role !== "admin") router.replace("/admin/login");
  }, [hasHydrated, user, router]);

  const visible = useMemo(
    () => (filter === "all" ? doctorApplications : doctorApplications.filter((a) => a.status === filter)),
    [doctorApplications, filter]
  );

  const pendingCount = doctorApplications.filter((a) => a.status === "pending").length;
  const verifiedCount = doctorApplications.filter((a) => a.status === "verified").length;

  function handleApprove(app: DoctorApplication) {
    approveDoctorApplication(app.id);
    push(`${app.name} verified and approved.`, "emerald");
  }

  function handleReject(app: DoctorApplication) {
    rejectDoctorApplication(app.id);
    push(`${app.name}'s application rejected.`, "red");
  }

  if (!hasHydrated || !user || user.role !== "admin") {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-ink text-text-primary">
      <header className="sticky top-0 z-40 border-b border-hairline bg-ink/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5 text-[13.5px] font-semibold">
            <ShieldCheck size={16} className="text-cyan" />
            Aarogya Admin
          </div>
          <button
            onClick={() => {
              logout();
              router.push("/");
            }}
            className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-red/30 hover:text-red"
          >
            <LogOut size={13} /> Log out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-5 py-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardLabel>Pending verification</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{pendingCount}</p>
          </Card>
          <Card>
            <CardLabel>Verified doctors</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{verifiedCount}</p>
          </Card>
          <Card>
            <CardLabel>Total applications</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{doctorApplications.length}</p>
          </Card>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">Doctor verification queue</h2>
          <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-[11.5px] capitalize transition ${
                  filter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {visible.length === 0 && (
            <Card className="text-center text-[13px] text-text-tertiary">No applications in this filter.</Card>
          )}
          {visible.map((app) => (
            <motion.div
              key={app.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <p className="text-[13.5px] font-medium">{app.name}</p>
                    <StatusPill label={app.status} tone={STATUS_TONE[app.status]} />
                  </div>
                  <p className="mt-1 text-[12px] text-text-tertiary">
                    {app.specialty} · {app.facility} · {app.registrationId}
                  </p>
                  <p className="mt-1 text-[11.5px] text-text-tertiary">
                    {app.email} · submitted {app.submittedAt} · proof: {app.proofFileName}
                  </p>
                </div>
                {app.status === "pending" && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => handleApprove(app)}
                      className="flex items-center gap-1.5 rounded-full bg-emerald px-3.5 py-2 text-[12px] font-medium text-white transition hover:brightness-110"
                    >
                      <Check size={13} /> Approve
                    </button>
                    <button
                      onClick={() => handleReject(app)}
                      className="flex items-center gap-1.5 rounded-full border border-red/30 px-3.5 py-2 text-[12px] font-medium text-red transition hover:bg-red/10"
                    >
                      <X size={13} /> Reject
                    </button>
                  </div>
                )}
              </Card>
            </motion.div>
          ))}
        </div>
      </main>
      <ToastViewport />
    </div>
  );
}
