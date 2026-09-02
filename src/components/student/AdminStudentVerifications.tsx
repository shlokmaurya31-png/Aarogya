"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Application {
  id: string; name: string; email: string; institution: string; course: string;
  academicYear: number; verificationMethod: string | null; status: string; submittedAt: string;
}

const STATUS_TONE: Record<string, "amber" | "emerald" | "red"> = {
  UNVERIFIED: "amber", EMAIL_PENDING: "amber", DOCUMENT_PENDING: "amber", UNDER_REVIEW: "amber",
  VERIFIED: "emerald", REJECTED: "red", EXPIRED: "red", SUSPENDED: "red",
};

export function AdminStudentVerifications() {
  const push = useToastStore((s) => s.push);
  const [apps, setApps] = useState<Application[] | null>(null);

  function load() {
    fetch("/api/admin/verifications/students").then((r) => r.json()).then((d) => setApps(d.applications ?? []));
  }
  useEffect(load, []);

  async function review(id: string, action: "approve" | "reject") {
    const res = await fetch("/api/admin/verifications/students", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    if (!res.ok) { push("Failed to update.", "red"); return; }
    push(action === "approve" ? "Student verified." : "Application rejected.", action === "approve" ? "emerald" : "amber");
    load();
  }

  const pending = apps?.filter((a) => a.status !== "VERIFIED" && a.status !== "REJECTED") ?? [];
  const decided = apps?.filter((a) => a.status === "VERIFIED" || a.status === "REJECTED") ?? [];

  return (
    <div>
      <ToastViewport />
      <h1 className="text-[20px] font-semibold tracking-tight">Aarogya Scholar — Student Verifications</h1>
      <p className="mt-1 text-[13px] text-text-secondary">{pending.length} pending review.</p>

      <div className="mt-5 space-y-3">
        {apps === null && <p className="text-[13px] text-text-tertiary">Loading...</p>}
        {pending.map((a) => (
          <Card key={a.id} className="flex flex-col gap-3 rounded-lg sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[13.5px] font-medium">{a.name}</p>
                <StatusPill label={a.status.replaceAll("_", " ")} tone={STATUS_TONE[a.status] ?? "amber"} className="rounded-md" />
              </div>
              <p className="mt-1 text-[12px] text-text-tertiary">{a.email} · {a.institution} · {a.course.replaceAll("_", " ")} Year {a.academicYear}</p>
              <p className="text-[11px] text-text-tertiary">Method: {a.verificationMethod?.replaceAll("_", " ") ?? "—"}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button onClick={() => review(a.id, "approve")} className="flex items-center gap-1.5 rounded-md bg-emerald px-3.5 py-2 text-[12px] font-medium text-white hover:brightness-110">
                <Check size={13} /> Approve
              </button>
              <button onClick={() => review(a.id, "reject")} className="flex items-center gap-1.5 rounded-md border border-red/30 px-3.5 py-2 text-[12px] font-medium text-red hover:bg-red/10">
                <X size={13} /> Reject
              </button>
            </div>
          </Card>
        ))}
        {apps !== null && pending.length === 0 && <p className="text-[13px] text-text-tertiary">No pending applications.</p>}
      </div>

      {decided.length > 0 && (
        <div className="mt-8">
          <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Reviewed</p>
          <div className="mt-3 space-y-2">
            {decided.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-hairline px-3.5 py-2.5 text-[12.5px]">
                <span>{a.name} · {a.institution}</span>
                <StatusPill label={a.status} tone={STATUS_TONE[a.status]} className="rounded-md" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
