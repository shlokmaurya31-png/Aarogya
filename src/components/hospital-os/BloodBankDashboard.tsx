"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Droplet, ChartLine, AlertTriangle, Clock, Activity } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

interface Dashboard {
  inventory: Record<string, number>;
  expiringUnits: { id: string; unitNumber: string; expiresAt: string | null; product: { name: string } }[];
  requests: { id: string; productName: string; quantity: number; priority: string; status: string; patient: { fullName: string; uhid: string } }[];
  pendingCompatibility: number;
  activeTransfusions: { id: string; status: string; unit: { unitNumber: string }; patientId: string; requestId: string }[];
  openReactions: { id: string; status: string; transfusionId: string; reportedAt: string }[];
  recalledUnits: number;
}
interface BoardEntry {
  id: string; patient: { id: string; fullName: string; uhid: string }; encounterId: string;
  productName: string; quantity: number; priority: string; status: string; compatibility: string; reservedUnits: number; emergencyRelease: boolean;
}

const INV_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  AVAILABLE: "emerald", RESERVED: "cyan", ISSUED: "amber", IN_TRANSIT: "amber", TRANSFUSING: "amber",
  TRANSFUSED: "neutral", RETURNED: "neutral", WASTED: "red", QUARANTINED: "red", EXPIRED: "red", DISCARDED: "red",
};
const STATUS_TONE: Record<string, "emerald" | "amber" | "red" | "cyan" | "neutral"> = {
  REQUESTED: "neutral", REVIEWED: "amber", APPROVED: "cyan", COMPATIBILITY_PENDING: "amber", READY: "cyan", ISSUED: "amber", COMPLETED: "emerald", CANCELLED: "red", REJECTED: "red",
};
const COMPAT_TONE: Record<string, "emerald" | "amber" | "red" | "neutral"> = { VERIFIED_COMPATIBLE: "emerald", INCOMPATIBLE: "red", PENDING: "amber", NONE: "neutral" };
const INV_ORDER = ["AVAILABLE", "RESERVED", "ISSUED", "IN_TRANSIT", "TRANSFUSING", "TRANSFUSED", "QUARANTINED", "RETURNED", "WASTED", "EXPIRED", "DISCARDED"];

export function BloodBankDashboard() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [board, setBoard] = useState<BoardEntry[] | null>(null);

  useEffect(() => {
    fetch("/api/hospital/blood/dashboard").then((r) => r.json()).then((d) => setDash(d.dashboard ?? null));
    fetch("/api/hospital/blood/requests").then((r) => r.json()).then((d) => setBoard(d.board ?? []));
  }, []);

  if (!dash || !board) return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-64 rounded-[20px] bg-black/[0.04]" /></div>;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <Droplet size={18} className="text-red" />
        <h1 className="text-[20px] font-semibold tracking-tight">Blood Bank</h1>
      </div>

      {/* Inventory by status */}
      <Card className="rounded-[20px]">
        <CardLabel>Inventory by status</CardLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          {INV_ORDER.filter((s) => dash.inventory[s]).map((s) => (
            <div key={s} className="rounded-xl border border-hairline px-3 py-2">
              <p className="text-[18px] font-semibold leading-none">{dash.inventory[s]}</p>
              <StatusPill label={s.replace("_", " ")} tone={INV_TONE[s] ?? "neutral"} className="mt-1.5 rounded-md" />
            </div>
          ))}
          {Object.keys(dash.inventory).length === 0 && <p className="text-[13px] text-text-tertiary">No blood units registered yet.</p>}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-text-secondary">
          <span className="flex items-center gap-1"><Clock size={12} className="text-amber" /> {dash.pendingCompatibility} pending compatibility test(s)</span>
          <span className="flex items-center gap-1"><Activity size={12} className="text-amber" /> {dash.activeTransfusions.length} active transfusion(s)</span>
          {dash.recalledUnits > 0 && <span className="flex items-center gap-1 text-red"><AlertTriangle size={12} /> {dash.recalledUnits} recalled unit(s)</span>}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Expiring units */}
        <Card className="rounded-[20px]">
          <CardLabel>Expiring within 7 days</CardLabel>
          <div className="mt-2 space-y-1.5">
            {dash.expiringUnits.length === 0 && <p className="text-[13px] text-text-tertiary">No units expiring soon.</p>}
            {dash.expiringUnits.map((u) => (
              <div key={u.id} className="flex items-center justify-between text-[12.5px]">
                <span>{u.unitNumber} · {u.product.name}</span>
                <span className="text-amber">{u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : "—"}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Open reactions */}
        <Card className="rounded-[20px]">
          <CardLabel>Open reactions / incidents</CardLabel>
          <div className="mt-2 space-y-1.5">
            {dash.openReactions.length === 0 && <p className="text-[13px] text-text-tertiary">No open reactions.</p>}
            {dash.openReactions.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-[12.5px]">
                <span className="text-red">Reaction · {new Date(r.reportedAt).toLocaleString()}</span>
                <StatusPill label={r.status.replace("_", " ")} tone="red" className="rounded-md" />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Request board */}
      <Card className="rounded-[20px]">
        <CardLabel>Active blood requests ({board.length})</CardLabel>
        <div className="mt-3 space-y-2">
          {board.length === 0 && <p className="text-[13px] text-text-tertiary">No active requests. Create a blood request from a patient encounter.</p>}
          {board.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
              <div>
                <p className="text-[13.5px] font-medium">{b.patient.fullName} · <span className="text-text-tertiary">{b.patient.uhid}</span></p>
                <p className="text-[11.5px] text-text-tertiary">{b.productName} · {b.quantity} unit(s){b.reservedUnits ? ` · ${b.reservedUnits} reserved` : ""}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {b.emergencyRelease && <StatusPill label="EMERGENCY RELEASE" tone="red" className="rounded-md" />}
                {b.priority !== "ROUTINE" && <StatusPill label={b.priority} tone={b.priority === "EMERGENCY" ? "red" : "amber"} className="rounded-md" />}
                <StatusPill label={b.compatibility.replace(/_/g, " ")} tone={COMPAT_TONE[b.compatibility] ?? "neutral"} className="rounded-md" />
                <StatusPill label={b.status.replace(/_/g, " ")} tone={STATUS_TONE[b.status] ?? "neutral"} className="rounded-md" />
                <Link href={`/hospital-os/blood/${b.id}`} className="flex items-center gap-1 rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] hover:border-red/40 hover:text-red">
                  <ChartLine size={11} /> Open
                </Link>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
