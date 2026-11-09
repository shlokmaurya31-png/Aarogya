"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dropFromOutbox, getDeviceId, loadPack, outbox, queue, savePack, setDeviceId, wipe, type OutboxCommand } from "@/lib/ward/store";

/**
 * Flagship 4c — the ward device app (docs/OFFLINE_NURSING_DESIGN.md §3–5, §13.4):
 * an installable web app for the shared ward tablet. The medication round,
 * vitals, intake/output and nursing tasks work with the network cut: every
 * action is a command in the tablet's encrypted outbox (with its own id and
 * the tablet's time), pushed in order when the network is back, and then a
 * fresh pack is pulled. It shows "Offline since hh:mm", gives a dose only on
 * the tablet that holds it, keeps PRN doses within their limits (a dose over a
 * limit is refused, and the charge nurse told), refuses doses past the
 * facility's offline limit (vitals, I/O and tasks are still recorded), and
 * shows controlled and high-alert medicines as "online only".
 */

interface Dose { administrationId: string; drugName: string; dose: string; route: string; scheduledAt: string; onlineOnly: boolean; givableOffline: boolean }
interface Prn { orderId: string; drugName: string; dose: string; route: string; reason: string | null; minIntervalMinutes: number | null; maxPer24h: number | null; onlineOnly: boolean; givableOffline: boolean; givenAt: string[] }
interface PackPatient {
  patientId: string; name: string; uhid: string; bed: string | null; encounterId: string | null;
  allergies: { substance: string; severity: string | null }[];
  doses: Dose[]; prn: Prn[]; tasks: { taskId: string; title: string; priority: string; dueAt: string | null }[];
}
interface Pack { packId: string; deviceId: string; issuedAt: string; expiresAt: string; patients: PackPatient[]; wardSummary: { patientId: string; bed: string | null; name: string; uhid: string; allergyCount: number }[] }
interface SyncSummary { at: string; applied: number; conflicts: number; refused: number }

const hhmm = (iso: string | number | Date) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const REASONS: [string, string][] = [["patient-declined", "Patient declined"], ["npo", "Nil by mouth"], ["unavailable", "Medicine not available"], ["clinical-hold", "Held on clinical grounds"]];
/** "Call the doctor now" (design §5): wide thresholds; the advisor signs off the exact ones (§6.4). */
function alarming(v: Record<string, number>) {
  return (v.hr !== undefined && (v.hr > 130 || v.hr < 40)) || (v.sbp !== undefined && v.sbp < 90) || (v.spo2 !== undefined && v.spo2 < 90) || (v.rr !== undefined && (v.rr > 30 || v.rr < 8)) || (v.tempC !== undefined && v.tempC >= 39.5);
}

export function WardApp({ nurseName }: { nurseName: string }) {
  const [deviceId, setDevice] = useState<string | null>(null);
  const [deviceInput, setDeviceInput] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [pending, setPending] = useState<{ seq: number; cmd: OutboxCommand }[]>([]);
  const [online, setOnline] = useState(true);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reasonFor, setReasonFor] = useState<{ id: string; status: "DOSE_HELD" | "DOSE_REFUSED" } | null>(null);
  const [vitalsFor, setVitalsFor] = useState<string | null>(null);
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [ioFor, setIoFor] = useState<string | null>(null);
  const [io, setIo] = useState({ ioType: "OUTPUT", category: "URINE", quantityMl: "" });

  const refreshOutbox = useCallback(async () => setPending(await outbox()), []);

  useEffect(() => {
    void (async () => {
      setDevice(await getDeviceId());
      setPack(await loadPack<Pack>());
      await refreshOutbox();
    })();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/ward-sw.js", { scope: "/ward" }).catch(() => undefined);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [refreshOutbox]);

  /** Push the outbox (in order), then pull a fresh pack. Anything not answered stays queued. */
  const sync = useCallback(async () => {
    if (!deviceId || !navigator.onLine) return;
    setBusy(true);
    try {
      const items = await outbox();
      if (items.length) {
        const res = await fetch("/api/hospital/offline/sync", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, commands: items.map(({ cmd }) => { const { label: _label, ...c } = cmd; return c; }) }),
        });
        if (!res.ok) { setMessage((await res.json().catch(() => null))?.error ?? "Sync didn't go through; it will try again."); return; }
        const body = await res.json() as { results: { clientOperationId: string; outcome: string; conflicts: unknown[] }[] };
        const answered = new Set(body.results.map((r) => r.clientOperationId));
        await dropFromOutbox(items.filter((i) => answered.has(i.cmd.clientOperationId)).map((i) => i.seq));
        setLastSync({ at: new Date().toISOString(), applied: body.results.filter((r) => r.outcome !== "REFUSED").length, conflicts: body.results.filter((r) => r.conflicts.length > 0).length, refused: body.results.filter((r) => r.outcome === "REFUSED").length });
      }
      const p = await fetch("/api/hospital/offline/pack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, deviceClock: new Date().toISOString() }) });
      if (p.ok) { const fresh = await p.json() as Pack; await savePack(fresh); setPack(fresh); setMessage(null); }
      else setMessage((await p.json().catch(() => null))?.error ?? "The list couldn't be refreshed.");
    } catch {
      setMessage("The network dropped during sync; everything stays on this tablet until it's back.");
    } finally {
      setBusy(false);
      await refreshOutbox();
    }
  }, [deviceId, refreshOutbox]);

  useEffect(() => {
    const goOffline = () => { setOnline(false); setOfflineSince((s) => s ?? Date.now()); };
    const goOnline = () => { setOnline(true); setOfflineSince(null); void sync(); };
    if (!navigator.onLine) goOffline();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => { window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); };
  }, [sync]);

  const expired = pack ? now > Date.parse(pack.expiresAt) : false;
  const recorded = useMemo(() => {
    const m = new Map<string, OutboxCommand>();
    for (const { cmd } of pending) if (typeof cmd.administrationId === "string") m.set(cmd.administrationId, cmd);
    return m;
  }, [pending]);

  async function record(cmd: Omit<OutboxCommand, "clientOperationId" | "deviceTime">) {
    await queue({ ...cmd, clientOperationId: crypto.randomUUID(), deviceTime: new Date().toISOString() } as OutboxCommand);
    await refreshOutbox();
    if (navigator.onLine) void sync();
  }

  function prnCheck(o: Prn, t: number): "MIN_INTERVAL" | "DAILY_MAX" | null {
    const times = [...o.givenAt.map((x) => Date.parse(x)), ...pending.filter(({ cmd }) => cmd.kind === "PRN_GIVEN" && cmd.medicationOrderId === o.orderId).map(({ cmd }) => Date.parse(cmd.deviceTime))];
    if (o.minIntervalMinutes && times.some((x) => Math.abs(t - x) < o.minIntervalMinutes! * 60_000)) return "MIN_INTERVAL";
    if (o.maxPer24h && times.filter((x) => x > t - 86_400_000 && x <= t).length + 1 > o.maxPer24h) return "DAILY_MAX";
    return null;
  }

  async function givePrn(p: PackPatient, o: Prn, at: number) {
    const breach = prnCheck(o, at);
    if (breach) {
      // Refused here, and the charge nurse told (design §6.2): no dose is recorded.
      setMessage(breach === "MIN_INTERVAL" ? `${o.drugName}: too soon after the last dose. Not given; the charge nurse will be told.` : `${o.drugName}: the most doses for 24 hours. Not given; the charge nurse will be told.`);
      await record({ kind: "PRN_BREACH_REFUSED", medicationOrderId: o.orderId, breach, label: `${p.name}: ${o.drugName} refused (${breach === "MIN_INTERVAL" ? "too soon" : "daily maximum"})` });
      return;
    }
    await record({ kind: "PRN_GIVEN", medicationOrderId: o.orderId, label: `${p.name}: ${o.drugName} (as needed) given` });
  }

  if (!deviceId) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-[20px] font-semibold">Set up this ward tablet</h1>
        <p className="mt-1 text-[13px] text-text-secondary">Enter the device code the hospital admin gave when registering this tablet.</p>
        <input aria-label="Device code" value={deviceInput} onChange={(e) => setDeviceInput(e.target.value.trim())} className="mt-3 w-full rounded-md border border-hairline bg-card px-3 py-2 text-[14px]" />
        <button disabled={!deviceInput} onClick={async () => { await setDeviceId(deviceInput); setDevice(deviceInput); }} className="mt-3 rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-ink disabled:opacity-50">Save</button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold">Ward round</h1>
          <p className="text-[12px] text-text-secondary">{nurseName}{pack ? ` · list until ${hhmm(pack.expiresAt)}` : ""}</p>
        </div>
        <div className="flex gap-2">
          <button disabled={!online || busy} onClick={() => void sync()} className="rounded-md border border-hairline px-3 py-1.5 text-[12px] disabled:opacity-50">{pack ? "Sync now" : "Download my list"}</button>
          <button disabled={pending.length > 0} title={pending.length ? "Sync first: records are waiting" : undefined}
            onClick={async () => { await wipe(); await fetch("/api/scholar-auth/logout", { method: "POST" }).catch(() => undefined); location.href = "/hospital-os/login"; }}
            className="rounded-md border border-hairline px-3 py-1.5 text-[12px] disabled:opacity-50">Hand back the tablet</button>
        </div>
      </header>

      {!online && (
        <div role="status" className="mt-3 rounded-lg border border-amber/60 bg-amber/10 px-3 py-2 text-[13px] font-medium">
          Offline since {hhmm(offlineSince ?? now)}. Keep recording: everything is kept on this tablet and sent when the network is back.
        </div>
      )}
      {expired && (
        <div role="alert" className="mt-3 rounded-lg border border-red-500/60 bg-red-500/10 px-3 py-2 text-[13px] font-medium">
          Your offline list has expired: no doses can be given from this tablet. Use the downtime sheet. Vitals, intake/output and tasks can still be recorded.
        </div>
      )}
      {message && <p className="mt-2 text-[12.5px] text-amber">{message}</p>}
      <p className="mt-2 text-[12px] text-text-secondary" aria-live="polite">
        {pending.length ? `${pending.length} waiting to sync` : "Everything is synced"}
        {lastSync && ` · last sync ${hhmm(lastSync.at)}: ${lastSync.applied} recorded${lastSync.conflicts ? `, ${lastSync.conflicts} for the charge nurse to review` : ""}${lastSync.refused ? `, ${lastSync.refused} refused` : ""}`}
      </p>

      {!pack && <p className="mt-4 text-[13px]">Download your list at the start of the shift, while the network is on.</p>}
      {pack?.patients.map((p) => (
        <section key={p.patientId} aria-label={p.name} className="mt-4 rounded-surface border border-hairline bg-card p-3">
          <h2 className="text-[15px] font-semibold">{p.bed ? `${p.bed} · ` : ""}{p.name} <span className="text-[12px] font-normal text-text-secondary">{p.uhid}</span></h2>
          <p className="text-[12px] text-text-secondary">Allergies: {p.allergies.length ? p.allergies.map((a) => a.substance).join(", ") : "none recorded"}</p>

          <h3 className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">Medicines due</h3>
          <ul className="mt-1 space-y-1.5">
            {p.doses.map((d) => {
              const done = recorded.get(d.administrationId);
              return (
                <li key={d.administrationId} data-testid={`dose-${d.administrationId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-[13px]">
                  <span>{hhmm(d.scheduledAt)} · {d.drugName} {d.dose} {d.route}</span>
                  {done ? <span className="text-[12px] text-success">{done.label.split(": ").pop()} at {hhmm(done.deviceTime)} · waiting to sync</span>
                    : d.onlineOnly ? <span className="text-[12px] font-medium text-amber">Online only: use the MAR, or the downtime sheet</span>
                    : !d.givableOffline ? <span className="text-[12px] text-text-tertiary">Not on this device</span>
                    : expired ? <span className="text-[12px] text-text-tertiary">Offline list expired</span>
                    : reasonFor?.id === d.administrationId ? (
                      <span className="flex gap-1">
                        {REASONS.map(([code, text]) => <button key={code} onClick={async () => { await record({ kind: reasonFor.status, administrationId: d.administrationId, reasonCode: code, label: `${p.name}: ${d.drugName} ${reasonFor.status === "DOSE_HELD" ? "held" : "refused"}` }); setReasonFor(null); }} className="rounded border border-hairline px-1.5 py-0.5 text-[11px]">{text}</button>)}
                      </span>
                    ) : (
                      <span className="flex gap-1.5">
                        <button onClick={() => record({ kind: "DOSE_GIVEN", administrationId: d.administrationId, label: `${p.name}: ${d.drugName} given` })} className="rounded-md bg-cyan px-2.5 py-1 text-[12px] font-medium text-ink">Given</button>
                        <button onClick={() => setReasonFor({ id: d.administrationId, status: "DOSE_HELD" })} className="rounded-md border border-hairline px-2 py-1 text-[12px]">Held</button>
                        <button onClick={() => setReasonFor({ id: d.administrationId, status: "DOSE_REFUSED" })} className="rounded-md border border-hairline px-2 py-1 text-[12px]">Refused</button>
                      </span>
                    )}
                </li>
              );
            })}
            {!p.doses.length && <li className="text-[12px] text-text-tertiary">No doses due on this list.</li>}
          </ul>

          {p.prn.length > 0 && (
            <>
              <h3 className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">As needed</h3>
              <ul className="mt-1 space-y-1.5">
                {p.prn.map((o) => (
                  <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-[13px]">
                    <span>{o.drugName} {o.dose} {o.route}{o.minIntervalMinutes ? ` · not within ${o.minIntervalMinutes / 60} h · at most ${o.maxPer24h} in 24 h` : ""}</span>
                    {o.onlineOnly ? <span className="text-[12px] font-medium text-amber">Online only</span>
                      : !o.givableOffline ? <span className="text-[12px] text-text-tertiary">Not allowed offline</span>
                      : expired ? <span className="text-[12px] text-text-tertiary">Offline list expired</span>
                      : <button onClick={(e) => givePrn(p, o, e.timeStamp + performance.timeOrigin)} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Give a dose</button>}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            {p.encounterId && <button onClick={() => { setVitalsFor(vitalsFor === p.patientId ? null : p.patientId); setVitals({}); }} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Record vitals</button>}
            {p.encounterId && <button onClick={() => setIoFor(ioFor === p.patientId ? null : p.patientId)} className="rounded-md border border-hairline px-2.5 py-1 text-[12px]">Intake / output</button>}
          </div>
          {vitalsFor === p.patientId && p.encounterId && (
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
              e.preventDefault();
              const v = Object.fromEntries(Object.entries(vitals).filter(([, x]) => x !== "").map(([k, x]) => [k, Number(x)]));
              if (!Object.keys(v).length) return;
              await record({ kind: "VITALS", encounterId: p.encounterId, vitals: v, label: `${p.name}: vitals` });
              if (alarming(v)) setMessage(`${p.name}: Call the doctor now.`);
              setVitalsFor(null);
            }}>
              {([["hr", "HR"], ["sbp", "SBP"], ["dbp", "DBP"], ["rr", "RR"], ["spo2", "SpO2"], ["tempC", "Temp °C"]] as const).map(([k, l]) => (
                <label key={k} className="text-[11px] text-text-secondary">{l}<input aria-label={l} inputMode="decimal" value={vitals[k] ?? ""} onChange={(e) => setVitals({ ...vitals, [k]: e.target.value })} className="mt-0.5 block w-16 rounded border border-hairline bg-card px-1.5 py-1 text-[13px]" /></label>
              ))}
              <button type="submit" className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink">Save vitals</button>
            </form>
          )}
          {ioFor === p.patientId && p.encounterId && (
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
              e.preventDefault();
              const ml = Number(io.quantityMl);
              if (!ml) return;
              await record({ kind: "INTAKE_OUTPUT", encounterId: p.encounterId, ioType: io.ioType, category: io.category, quantityMl: ml, label: `${p.name}: ${io.ioType.toLowerCase()} ${ml} ml` });
              setIoFor(null); setIo({ ...io, quantityMl: "" });
            }}>
              <select aria-label="Intake or output" value={io.ioType} onChange={(e) => setIo({ ...io, ioType: e.target.value, category: e.target.value === "INPUT" ? "ORAL" : "URINE" })} className="rounded border border-hairline bg-card px-1.5 py-1 text-[13px]"><option value="INPUT">Intake</option><option value="OUTPUT">Output</option></select>
              <select aria-label="Kind" value={io.category} onChange={(e) => setIo({ ...io, category: e.target.value })} className="rounded border border-hairline bg-card px-1.5 py-1 text-[13px]">
                {(io.ioType === "INPUT" ? ["ORAL", "IV", "ENTERAL", "OTHER"] : ["URINE", "DRAIN", "EMESIS", "STOOL", "OTHER"]).map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
              </select>
              <label className="text-[11px] text-text-secondary">ml<input aria-label="Millilitres" inputMode="numeric" value={io.quantityMl} onChange={(e) => setIo({ ...io, quantityMl: e.target.value })} className="mt-0.5 block w-20 rounded border border-hairline bg-card px-1.5 py-1 text-[13px]" /></label>
              <button type="submit" className="rounded-md bg-cyan px-3 py-1 text-[12px] font-medium text-ink">Save</button>
            </form>
          )}

          {p.tasks.length > 0 && (
            <>
              <h3 className="mt-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">Tasks</h3>
              <ul className="mt-1 space-y-1">
                {p.tasks.map((t) => {
                  const done = pending.some(({ cmd }) => cmd.kind === "TASK_COMPLETED" && cmd.taskId === t.taskId);
                  return (
                    <li key={t.taskId} className="flex items-center justify-between gap-2 text-[13px]">
                      <span>{t.title}{t.dueAt ? ` · due ${hhmm(t.dueAt)}` : ""}</span>
                      {done ? <span className="text-[12px] text-success">Done · waiting to sync</span>
                        : <button onClick={() => record({ kind: "TASK_COMPLETED", taskId: t.taskId, label: `${p.name}: ${t.title} done` })} className="rounded-md border border-hairline px-2 py-0.5 text-[12px]">Done</button>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ))}

      {pack && pack.wardSummary.length > 0 && (
        <section aria-label="The rest of the ward" className="mt-4 rounded-surface border border-hairline p-3">
          <h2 className="text-[13px] font-semibold">The rest of the ward (read only)</h2>
          <ul className="mt-1 text-[12px] text-text-secondary">
            {pack.wardSummary.map((w) => <li key={w.patientId}>{w.bed ?? "—"} · {w.name} ({w.uhid}){w.allergyCount ? ` · ${w.allergyCount} allergies` : ""}</li>)}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section aria-label="Waiting to sync" className="mt-4 text-[12px] text-text-secondary">
          <h2 className="font-semibold">Waiting to sync</h2>
          <ul>{pending.map(({ seq, cmd }) => <li key={seq}>{hhmm(cmd.deviceTime)} · {cmd.label}</li>)}</ul>
        </section>
      )}
    </main>
  );
}
