"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, History, Inbox, ShieldOff, Share2 } from "lucide-react";
import { Card, SectionTitle, Empty, StatusPill, formatDateTime } from "./ui";
import { CATEGORY_LABEL, ShareChoices, choiceBody, type ShareChoiceValue } from "./ShareChoices";

/**
 * Week 4c — the patient's side of consent sharing (docs/CONSENT_SHARING_DESIGN.md
 * §5, §7): requests waiting for them (approve, narrower if they like, or
 * decline), the shares they've given (stop any), who opened their record and
 * how, and one-tap "revoke all". 4c answers: the notices sent about access
 * (a daily summary, break-glass at once), and the consents a hospital recorded
 * on paper, which revoke-all leaves, each with how to withdraw it.
 */
interface Request { id: string; status: string; requesterName: string | null; facilityName: string; purpose: string; categories: string[]; reason: string | null; createdAt: string; expiresAt: string }
interface Share { id: string; kind: string; status: string; categories: string[]; sensitiveCategories: string[]; recipient: { doctorName: string | null; facilityName: string | null }; expiresAt: string; createdAt: string; endedReason: string | null }
interface LogEntry { id: string; at: string; what: string; who: string | null; facility: string | null; wayIn: string | null; categories: string[] | null }
interface PaperConsent { id: string; facilityName: string; purpose: string; recordedAt: string; howToWithdraw: string }
interface Notice { id: string; title: string; body: string; createdAt: string }

const PURPOSE: Record<string, string> = { CONSULTATION: "a consultation", SECOND_OPINION: "a second opinion", FOLLOW_UP: "a follow-up", REFERRAL: "a referral", OTHER: "another reason" };
const cats = (c: string[]) => c.map((x) => CATEGORY_LABEL[x] ?? x).join(", ");

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return r?.ok ? null : ((await r?.json().catch(() => null))?.error ?? "That didn't go through. Try again.");
}

function RequestCard({ r, onDone }: { r: Request; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ShareChoiceValue>({ categories: r.categories, sensitiveCategories: [], from: "", to: "" });
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "APPROVE" | "DECLINE") => {
    const e = await post(`/api/patient/person/access-requests/${r.id}/decide`, decision === "DECLINE" ? { decision } : { decision, ...choiceBody(choice), validDays: days });
    if (e) setError(e); else onDone();
  };
  return (
    <li className="rounded-xl border border-hairline p-3" aria-label="Access request">
      <p className="text-[13px]"><span className="font-medium">{r.requesterName ?? r.facilityName}</span>{r.requesterName ? ` at ${r.facilityName}` : ""} asks to see your {cats(r.categories).toLowerCase()} for {PURPOSE[r.purpose] ?? r.purpose}.</p>
      {r.reason && <p className="mt-1 text-[12.5px] text-text-secondary">&ldquo;{r.reason}&rdquo;</p>}
      <p className="mt-1 text-[11.5px] text-text-tertiary">Asked {formatDateTime(r.createdAt)} · waits until {formatDateTime(r.expiresAt)}</p>
      {open ? (
        <div className="mt-3 space-y-3">
          <ShareChoices value={choice} onChange={setChoice} allowed={r.categories} />
          <label className="flex items-center gap-2 text-[12.5px]">For
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-md border border-hairline bg-transparent px-2 py-1">
              {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
            </select>
          </label>
          <button onClick={() => decide("APPROVE")} disabled={!choice.categories.length} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Approve</button>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button onClick={() => setOpen(true)} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink">Review and approve</button>
          <button onClick={() => decide("DECLINE")} className="rounded-md border border-hairline px-3 py-1.5 text-[12.5px]">Decline</button>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-amber">{error}</p>}
    </li>
  );
}

export function SharingCenter({ reloadKey = 0 }: { reloadKey?: number }) {
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [paper, setPaper] = useState<PaperConsent[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    const get = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get("/api/patient/person/access-requests"), get("/api/patient/person/shares"), get("/api/patient/person/access-log?limit=30"), get("/api/patient/person/revoke-all"), get("/api/patient/person/notifications?limit=10")]).then(([a, b, c, d, e]) => {
      if (!alive) return;
      setRequests(a?.requests ?? []); setShares(b?.shares ?? []); setLog(c?.entries ?? []); setPaper(d?.paperConsents ?? []); setNotices(e?.notifications ?? []);
    });
    return () => { alive = false; };
  }, [tick, reloadKey]);

  const waiting = (requests ?? []).filter((r) => r.status === "REQUESTED");
  const live = (shares ?? []).filter((s) => s.status === "ACTIVE" || s.status === "PENDING");
  async function stop(id: string) { setMessage(await post(`/api/patient/person/shares/${id}/end`, {})); load(); }
  async function revokeAll() {
    const e = await post("/api/patient/person/revoke-all", { confirm: "REVOKE" });
    setConfirming(false);
    setMessage(e ?? "Done. Everyone you shared with has lost access. Hospitals treating you still see their own records.");
    load();
  }

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle><span className="inline-flex items-center gap-2"><Inbox size={15} /> Requests to see your record</span></SectionTitle>
        {requests === null ? <Empty>Loading…</Empty> : waiting.length === 0 ? <Empty>No requests waiting.</Empty> : (
          <ul className="space-y-3">{waiting.map((r) => <RequestCard key={r.id} r={r} onDone={load} />)}</ul>
        )}
      </Card>
      <Card>
        <SectionTitle><span className="inline-flex items-center gap-2"><Share2 size={15} /> Who you&apos;re sharing with</span></SectionTitle>
        {shares === null ? <Empty>Loading…</Empty> : live.length === 0 ? <Empty>You aren&apos;t sharing your record with anyone right now.</Empty> : (
          <ul className="space-y-2">
            {live.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2 text-[13px] last:border-0">
                <span>
                  <span className="font-medium">{s.recipient.doctorName ?? s.recipient.facilityName ?? "Waiting for your doctor"}</span>
                  <span className="text-text-secondary"> · {cats(s.categories)}{s.sensitiveCategories.length ? ` · ${s.sensitiveCategories.length} sensitive` : ""} · until {formatDateTime(s.expiresAt)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusPill label={s.status === "ACTIVE" ? "Active" : "Waiting"} tone={s.status === "ACTIVE" ? "good" : "info"} />
                  <button onClick={() => stop(s.id)} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:border-danger/40 hover:text-danger">Stop sharing</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle><span className="inline-flex items-center gap-2"><History size={15} /> Who opened your record</span></SectionTitle>
        {log === null ? <Empty>Loading…</Empty> : log.length === 0 ? <Empty>Nothing yet.</Empty> : (
          <ul className="space-y-1.5" aria-label="Access log">
            {log.map((e) => (
              <li key={e.id} className="text-[12.5px]">
                <span className="text-text-tertiary">{formatDateTime(e.at)}</span> · {e.who ? <span className="font-medium">{e.who}</span> : null}{e.facility ? ` (${e.facility})` : ""} {e.what.toLowerCase()}
                {e.wayIn ? <span className="text-text-secondary"> through {e.wayIn}</span> : null}
                {e.categories?.length ? <span className="text-text-tertiary"> · {cats(e.categories)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle><span className="inline-flex items-center gap-2"><Bell size={15} /> What we&apos;ve told you</span></SectionTitle>
        <p className="mb-2 text-[11.5px] text-text-tertiary">A summary each day someone opened your record, and a message at once if a hospital used emergency access.</p>
        {notices.length === 0 ? <Empty>No messages yet.</Empty> : (
          <ul className="space-y-1.5" aria-label="Notifications">
            {notices.map((n) => <li key={n.id} className="text-[12.5px]"><span className="text-text-tertiary">{formatDateTime(n.createdAt)}</span> · <span className="font-medium">{n.title}</span><br /><span className="text-text-secondary">{n.body}</span></li>)}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle><span className="inline-flex items-center gap-2"><ShieldOff size={15} /> Revoke all access</span></SectionTitle>
        <p className="text-[12.5px] text-text-secondary">Ends every code and share you&apos;ve given, declines waiting requests, withdraws consents you gave to hospitals and stops sharing your uploads with them. Hospitals treating you keep their own records of your care.</p>
        {confirming ? (
          <div className="mt-3 flex gap-2">
            <button onClick={revokeAll} className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white">Yes, revoke all</button>
            <button onClick={() => setConfirming(false)} className="rounded-md border border-hairline px-3 py-1.5 text-[12.5px]">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="mt-3 rounded-md border border-danger/40 px-3 py-1.5 text-[12.5px] text-danger">Revoke all access</button>
        )}
        {message && <p className="mt-2 text-[12px] text-text-secondary">{message}</p>}
        {paper.length > 0 && (
          <div className="mt-3 rounded-lg border border-hairline p-3" aria-label="Paper consents">
            <p className="text-[12.5px] font-medium">Consents you signed on paper (not changed by revoke all)</p>
            <ul className="mt-1.5 space-y-2">
              {paper.map((c) => <li key={c.id} className="text-[12px]"><span className="font-medium">{c.facilityName}</span> · for {c.purpose} · recorded {formatDateTime(c.recordedAt)}<br /><span className="text-text-secondary">{c.howToWithdraw}</span></li>)}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
