"use client";

import { useRouter } from "next/navigation";
import { Clock, FileCheck, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

const STATUS_META: Record<string, { label: string; tone: "amber" | "emerald" | "red" | "cyan"; icon: typeof Clock; blurb: string }> = {
  UNVERIFIED: { label: "Unverified", tone: "amber", icon: ShieldAlert, blurb: "Your verification hasn't been submitted yet." },
  EMAIL_PENDING: { label: "Email pending", tone: "amber", icon: Clock, blurb: "We couldn't automatically match your institutional email domain. A reviewer will confirm it shortly." },
  DOCUMENT_PENDING: { label: "Document pending", tone: "amber", icon: FileCheck, blurb: "Your document was received and is queued for review." },
  UNDER_REVIEW: { label: "Under review", tone: "amber", icon: Clock, blurb: "An Aarogya reviewer is checking your submission. This usually takes 1-2 business days." },
  VERIFIED: { label: "Verified", tone: "emerald", icon: ShieldCheck, blurb: "You're verified. Welcome to Aarogya Scholar." },
  REJECTED: { label: "Rejected", tone: "red", icon: ShieldX, blurb: "Your verification was rejected. Contact your institution admin or resubmit with a clearer document." },
  EXPIRED: { label: "Expired", tone: "red", icon: ShieldX, blurb: "Your verification has expired. Please resubmit." },
  SUSPENDED: { label: "Suspended", tone: "red", icon: ShieldX, blurb: "Your access has been suspended. Contact Aarogya support." },
};

export function VerificationStatusPanel({
  status,
  name,
  institution,
  devControlsEnabled,
}: {
  status: string;
  name: string;
  institution: string;
  devControlsEnabled: boolean;
}) {
  const router = useRouter();
  const push = useToastStore((s) => s.push);
  const meta = STATUS_META[status] ?? STATUS_META.UNVERIFIED;
  const Icon = meta.icon;

  async function devSet(action: "approve" | "reject" | "pending") {
    const res = await fetch("/api/student/verification/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) {
      push(data.error ?? "Failed.", "red");
      return;
    }
    push(`Verification status set to ${data.verificationStatus}.`, "cyan");
    if (data.verificationStatus === "VERIFIED") {
      router.push("/student/dashboard");
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-20">
      <ToastViewport />
      <Card className="rounded-[20px] text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-black/[0.03]">
          <Icon size={24} className={meta.tone === "emerald" ? "text-emerald" : meta.tone === "red" ? "text-red" : "text-amber"} />
        </div>
        <p className="mt-4 text-[16px] font-semibold">Verification Center</p>
        <p className="mt-1 text-[13px] text-text-secondary">{name} · {institution}</p>
        <div className="mt-4 flex justify-center">
          <StatusPill label={meta.label} tone={meta.tone} className="rounded-md" />
        </div>
        <p className="mt-4 text-[12.5px] leading-relaxed text-text-tertiary">{meta.blurb}</p>

        {devControlsEnabled && status !== "VERIFIED" && (
          <div className="mt-6 rounded-lg border border-dashed border-hairline-strong p-4">
            <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Dev-only verification shortcut</p>
            <p className="mt-1 text-[11px] text-text-tertiary">Never present in a production build.</p>
            <div className="mt-3 flex justify-center gap-2">
              <button onClick={() => devSet("approve")} className="rounded-md bg-emerald px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110">Approve</button>
              <button onClick={() => devSet("reject")} className="rounded-md border border-red/30 px-3 py-1.5 text-[12px] font-medium text-red hover:bg-red/10">Reject</button>
              <button onClick={() => devSet("pending")} className="rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-cyan/30">Pending</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
