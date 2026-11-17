"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Upload } from "lucide-react";

/**
 * Flagship 5, step 6c — an upload that survives a dropping connection
 * (docs/MOBILE_ACCESSIBILITY.md §4). The file goes in pieces; when the
 * network drops, the screen says so and carries on from what arrived once it
 * is back (and on its own, with backoff, if the "online" event never comes).
 * A photo can come straight from the camera. Progress is a real progress bar,
 * announced to screen readers.
 */
type Phase = { kind: "idle" } | { kind: "sending"; sent: number; size: number } | { kind: "waiting"; sent: number; size: number } | { kind: "done" } | { kind: "error"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json<T>(r: Response): Promise<T> { return (await r.json()) as T }

export function ResumableUpload({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  /** Until the browser says it's online again, or the backoff passes (whichever first). */
  const waitForNetwork = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { window.removeEventListener("online", done); clearTimeout(t); resolve(); };
    const t = setTimeout(done, ms);
    window.addEventListener("online", done);
  });

  async function send(f: File, name: string) {
    cancelled.current = false;
    setPhase({ kind: "sending", sent: 0, size: f.size });
    let uploadId: string | null = null;
    let chunk = 256 * 1024;
    let sent = 0;
    let backoff = 1_000;
    // One step: start, a piece, or completion. A network failure waits and tries again from what the server has.
    while (!cancelled.current) {
      try {
        if (!uploadId) {
          const r = await fetch("/api/patient/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, contentType: f.type, sizeBytes: f.size, title: name || f.name, type: "REPORT" }) });
          const b = await json<{ uploadId?: string; chunkBytes?: number; error?: string }>(r);
          if (!r.ok || !b.uploadId) { setPhase({ kind: "error", message: b.error ?? "The upload couldn't start." }); return; }
          uploadId = b.uploadId; chunk = b.chunkBytes ?? chunk;
        } else if (sent < f.size) {
          const r = await fetch(`/api/patient/uploads/${uploadId}?offset=${sent}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: f.slice(sent, sent + chunk) });
          if (r.status === 409 || r.ok) {
            // In order, or the server tells us where it is: either way, carry on from what it has.
            const b = r.ok ? await json<{ receivedBytes: number }>(r) : await json<{ receivedBytes: number }>(await fetch(`/api/patient/uploads/${uploadId}`));
            sent = b.receivedBytes;
          } else { setPhase({ kind: "error", message: (await json<{ error?: string }>(r).catch(() => ({ error: undefined }))).error ?? "The upload was refused." }); return; }
        } else {
          const r = await fetch(`/api/patient/uploads/${uploadId}/complete`, { method: "POST" });
          if (!r.ok) { setPhase({ kind: "error", message: (await json<{ error?: string }>(r).catch(() => ({ error: undefined }))).error ?? "The upload couldn't be finished." }); return; }
          setPhase({ kind: "done" }); setFile(null); setTitle(""); onUploaded();
          return;
        }
        backoff = 1_000;
        setPhase({ kind: "sending", sent, size: f.size });
      } catch {
        // The connection dropped: say so, wait for it, then ask the server how much arrived.
        setPhase({ kind: "waiting", sent, size: f.size });
        await waitForNetwork(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        if (uploadId) {
          const r = await fetch(`/api/patient/uploads/${uploadId}`).catch(() => null);
          if (r?.ok) sent = (await json<{ receivedBytes: number }>(r)).receivedBytes;
        }
        await sleep(0);
      }
    }
  }

  const busy = phase.kind === "sending" || phase.kind === "waiting";
  const pct = phase.kind === "sending" || phase.kind === "waiting" ? Math.floor((phase.sent / Math.max(phase.size, 1)) * 100) : phase.kind === "done" ? 100 : 0;
  const pick = (f: File | null) => { setFile(f); if (phase.kind !== "sending" && phase.kind !== "waiting") setPhase({ kind: "idle" }); };
  const control = "inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-hairline px-3 py-2 text-[13px]";

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (file && !busy) void send(file, title.trim()); }} className="space-y-2" aria-label="Add a report">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${control} cursor-pointer`}>
          <Upload size={14} aria-hidden /> Choose a file
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="Report file" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} disabled={busy} />
        </label>
        <label className={`${control} cursor-pointer`}>
          <Camera size={14} aria-hidden /> Take a photo
          <input type="file" accept="image/*" capture="environment" aria-label="Take a photo of the report" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} disabled={busy} />
        </label>
        {file && <span className="text-[12.5px] text-text-secondary" aria-live="polite">{file.name}</span>}
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="Title (optional)" aria-label="Title" className="min-h-[44px] w-full rounded-md border border-hairline bg-transparent px-3 py-2 text-[13px]" />
      <button type="submit" disabled={!file || busy} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-ink disabled:opacity-50">
        <Upload size={14} aria-hidden /> {busy ? "Uploading…" : "Upload"}
      </button>
      {phase.kind !== "idle" && (
        <div className="space-y-1">
          <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded-full bg-hairline">
            <div className="h-full bg-cyan transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p role="status" className="text-[12.5px]">
            {phase.kind === "sending" && `Uploading: ${pct}% sent.`}
            {phase.kind === "waiting" && `Connection lost at ${pct}%. It will carry on from there when you're back online.`}
            {phase.kind === "done" && "Uploaded."}
            {phase.kind === "error" && phase.message}
          </p>
        </div>
      )}
    </form>
  );
}
