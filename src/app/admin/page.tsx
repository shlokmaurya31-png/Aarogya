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
import type { VerificationApplication } from "@/types";

const STATUS_TONE: Record<VerificationApplication["status"], "amber" | "emerald" | "red"> = {
  pending: "amber",
  verified: "emerald",
  rejected: "red",
};

const STATUS_FILTERS = ["all", "pending", "verified", "rejected"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const ROLE_FILTERS = ["all", "doctor", "lab"] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

export default function AdminPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const verificationApplications = useAuthStore((s) => s.verificationApplications);
  const approveApplication = useAuthStore((s) => s.approveApplication);
  const rejectApplication = useAuthStore((s) => s.rejectApplication);
  const logout = useAuthStore((s) => s.logout);
  const push = useToastStore((s) => s.push);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user || user.role !== "admin") router.replace("/admin/login");
  }, [hasHydrated, user, router]);

  const visible = useMemo(
    () =>
      verificationApplications
        .filter((a) => statusFilter === "all" || a.status === statusFilter)
        .filter((a) => roleFilter === "all" || a.role === roleFilter),
    [verificationApplications, statusFilter, roleFilter]
  );

  const pendingCount = verificationApplications.filter((a) => a.status === "pending").length;
  const verifiedCount = verificationApplications.filter((a) => a.status === "verified").length;
  const labCount = verificationApplications.filter((a) => a.role === "lab").length;

  function handleApprove(app: VerificationApplication) {
    approveApplication(app.id);
    push(`${app.name} verified and approved.`, "emerald");
  }

  function handleReject(app: VerificationApplication) {
    rejectApplication(app.id);
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Card>
            <CardLabel>Pending verification</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{pendingCount}</p>
          </Card>
          <Card>
            <CardLabel>Verified</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{verifiedCount}</p>
          </Card>
          <Card>
            <CardLabel>Lab applications</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{labCount}</p>
          </Card>
          <Card>
            <CardLabel>Total applications</CardLabel>
            <p className="mt-2 text-[28px] font-semibold tabular-nums">{verificationApplications.length}</p>
          </Card>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">Doctor & lab verification queue</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
              {ROLE_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setRoleFilter(f)}
                  className={`rounded-full px-3 py-1 text-[11.5px] capitalize transition ${
                    roleFilter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {f === "all" ? "All roles" : f}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`rounded-full px-3 py-1 text-[11.5px] capitalize transition ${
                    statusFilter === f ? "bg-cyan text-ink" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
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
                    <StatusPill label={app.role} tone="cyan" />
                    <StatusPill label={app.status} tone={STATUS_TONE[app.status]} />
                  </div>
                  <p className="mt-1 text-[12px] text-text-tertiary">
                    {app.specialty ? `${app.specialty} · ` : ""}
                    {app.facility} · {app.role === "lab" ? "Accreditation" : "Registration"} ID: {app.registrationId}
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
