"use client";

import { useCallback, useEffect, useState } from "react";
import { ScanLine, ClipboardCheck, Aperture } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { RadiologyQueue } from "@/components/hospital-os/RadiologyQueue";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "worklist" | "acquisition";

export function RadiologyWorkspace() {
  const push = useToastStore((s) => s.push);
  const [tab, setTab] = useState<Tab>("worklist");
  const [worklist, setWorklist] = useState<any[] | null>(null);
  const [form, setForm] = useState<Record<string, { uid: string; images: string; notes: string }>>({});

  const load = useCallback(() => {
    if (tab === "acquisition") fetch("/api/hospital/radiology/acquisition-worklist").then((r) => r.json()).then((d) => setWorklist(d.worklist ?? []));
  }, [tab]);
  useEffect(load, [load]);

  async function recordAcquisition(orderId: string, studyId: string) {
    const f = form[studyId] ?? { uid: "", images: "", notes: "" };
    const res = await fetch(`/api/hospital/orders/imaging/${orderId}/study/acquisition`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyInstanceUid: f.uid || undefined, numberOfImages: f.images ? Number(f.images) : undefined, technicalNotes: f.notes || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { push(data.error ?? "Failed.", "red"); return; }
    push("Acquisition recorded (PACS reference registered).", "emerald"); load();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ToastViewport />
      <div className="flex items-center gap-2">
        <ScanLine size={18} className="text-cyan" />
        <h1 className="text-[20px] font-semibold tracking-tight">Radiology</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([["worklist", "Worklist & Reporting", ClipboardCheck], ["acquisition", "Acquisition / PACS", Aperture]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] ${tab === t ? "border-cyan/40 bg-cyan/5 text-cyan" : "border-hairline text-text-secondary hover:border-hairline-strong"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "worklist" && <RadiologyQueue />}

      {tab === "acquisition" && (
        <Card className="rounded-[20px]"><CardLabel>Acquisition worklist (technologist — DICOM/PACS boundary)</CardLabel>
          <p className="mt-1 text-[11.5px] text-text-tertiary">Records study/series UID + image count and registers a PACS reference via the local adapter. No image bytes are stored here; availability never falsely claims a functioning PACS.</p>
          <div className="mt-3 space-y-2">
            {!worklist && <div className="h-24 animate-pulse rounded-xl bg-black/[0.04]" />}
            {worklist && worklist.length === 0 && <p className="text-[13px] text-text-tertiary">No arrived/in-progress/completed studies.</p>}
            {worklist?.map((s: any) => {
              const f = form[s.studyId] ?? { uid: "", images: "", notes: "" };
              return (
                <div key={s.studyId} className="rounded-xl border border-hairline p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[13px] font-medium">{s.patient.fullName} · <span className="text-text-tertiary">{s.patient.uhid}</span></p>
                      <p className="text-[11px] text-text-tertiary">{s.modality} · {s.studyDescription} · {s.accessionNumber}{s.resource ? ` · ${s.resource}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusPill label={s.status.replace(/_/g, " ")} tone={s.status === "COMPLETED" ? "emerald" : "amber"} className="rounded-md" />
                      {s.acquired && <StatusPill label={`PACS: ${s.imageAvailability}`} tone="cyan" className="rounded-md" />}
                    </div>
                  </div>
                  {s.acquired ? (
                    <p className="mt-2 text-[11.5px] text-text-tertiary">Acquired · {s.numberOfImages ?? "?"} image(s){s.studyInstanceUid ? ` · UID ${s.studyInstanceUid}` : ""}{s.pacsReference ? ` · ${s.pacsReference}` : ""}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input value={f.uid} onChange={(e) => setForm({ ...form, [s.studyId]: { ...f, uid: e.target.value } })} placeholder="Study Instance UID (optional)" className="rounded-lg border border-hairline bg-transparent px-2 py-1 text-[12px]" />
                      <input value={f.images} onChange={(e) => setForm({ ...form, [s.studyId]: { ...f, images: e.target.value } })} placeholder="# images" className="w-24 rounded-lg border border-hairline bg-transparent px-2 py-1 text-[12px]" />
                      <button onClick={() => recordAcquisition(s.imagingOrderId, s.studyId)} className="rounded-md border border-cyan/40 bg-cyan/5 px-2.5 py-1 text-[11px] text-cyan">Record acquisition</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
