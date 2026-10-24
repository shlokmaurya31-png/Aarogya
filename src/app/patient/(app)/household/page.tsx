"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, ShieldCheck, Upload } from "lucide-react";
import { Card, SectionTitle, Empty } from "@/components/patient-portal/ui";
import { SharedRecordSections, type SharedRecordData } from "@/components/hospital-os/SharedRecordSections";
import { DEFAULT_SHARE_CHOICE, ShareChoices, choiceBody, type ShareChoiceValue } from "@/components/patient-portal/ShareChoices";

/**
 * Week 5b — the household (docs/HOUSEHOLD_DESIGN.md): your family's profiles,
 * adding a child (parental consent: a code to your verified phone and your
 * declaration), a dependent adult (their consent is recorded by their own
 * code, two staff in person, or a reviewed legal document), inviting an adult
 * with their own login, and the profile switcher. Acting for someone needs
 * their grant: being in the household gives nothing. Every action is in the
 * member's access log.
 */
interface Member { memberId: string; personId: string; name: string; memberType: string; role: string; status: string; me: boolean }
interface Household { householdId: string; name: string; myRole: string; myStatus: string; myMemberId: string; members: Member[] }
interface Profile { personId: string; name: string; basis: string; permissions: string[]; categories: string[] }
interface Grant { id: string; proxyName: string; basis: string; status: string; permissions: string[]; categories: string[] }
interface Fact { id: string; factType: string; value: Record<string, unknown>; version: number; bulkConfirmable: boolean }

const TYPE: Record<string, string> = { SELF: "You", MANAGED_MINOR: "Child", DEPENDENT_ADULT: "Adult you help", LINKED_ADULT: "Adult" };
const STATUS: Record<string, string> = { INVITED: "Invited", PENDING_CONSENT: "Waiting for their consent", AWAITING_CLAIM: "Turned 18: theirs to claim", ACTIVE: "" };

async function call(url: string, body?: unknown, method = "POST") {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  const data = await r?.json().catch(() => null);
  return r?.ok ? { ok: true as const, data } : { ok: false as const, error: (data?.error as string) ?? "That didn't go through. Try again." };
}

function AddChild({ householdId, onDone }: { householdId: string; onDone: () => void }) {
  const [f, setF] = useState({ displayName: "", dateOfBirth: "", relationship: "MOTHER", declaration: false });
  const [consentId, setConsentId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function start() {
    const r = await call(`/api/patient/household/${householdId}/children`, f);
    if (r.ok) { setConsentId(r.data.consentId); setSentTo(r.data.sentTo); setMsg(null); } else setMsg(r.error);
  }
  async function confirm() {
    const r = await call(`/api/patient/household/children/${consentId}/confirm`, { code });
    if (r.ok) onDone(); else setMsg(r.error);
  }
  return (
    <div role="region" className="space-y-2 rounded-xl border border-hairline p-3" aria-label="Add a child">
      {!consentId ? (
        <>
          <input aria-label="Child's name" placeholder="Child's name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} className="w-full rounded-md border border-hairline bg-transparent px-2 py-1.5 text-[13px]" />
          <label className="flex items-center gap-2 text-[12.5px]">Date of birth <input aria-label="Date of birth" type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1" /></label>
          <select aria-label="You are the child's" value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} className="rounded-md border border-hairline bg-transparent px-2 py-1 text-[12.5px]">
            <option value="MOTHER">Mother</option><option value="FATHER">Father</option><option value="LEGAL_GUARDIAN">Legal guardian</option>
          </select>
          <label className="flex items-start gap-2 text-[12px] text-text-secondary">
            <input type="checkbox" checked={f.declaration} onChange={(e) => setF({ ...f, declaration: e.target.checked })} className="mt-0.5" />
            I declare that I am this child&apos;s parent or legal guardian, that I may consent on their behalf, and that what I entered is true.
          </label>
          <button onClick={start} disabled={!f.declaration || !f.displayName || !f.dateOfBirth} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Send me a code</button>
        </>
      ) : (
        <>
          <p className="text-[12.5px]">We sent a code to your phone {sentTo}.</p>
          <input aria-label="Code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1.5 font-mono text-[13px]" />
          <button onClick={confirm} className="ml-2 rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink">Add child</button>
        </>
      )}
      {msg && <p className="text-[12px] text-amber">{msg}</p>}
    </div>
  );
}

const CHOICES: { purpose: string; label: string; scopes?: string[] }[] = [
  { purpose: "DOCUMENT_PROCESSING", label: "Read their uploaded reports (so you can check what was found)" },
  { purpose: "AI_ASSISTANCE", label: "Let the AI assistant explain their record" },
  { purpose: "AI_TEXT_RETENTION", label: "Keep AI questions and answers for safety review", scopes: ["SAFETY_REVIEW"] },
];
const DECIDED: Record<string, string> = { GRANTED: "Yes", DECLINED: "No", LAPSED: "Lapsed at 18" };

/** A guardian's choices for a child (Week 5b): the same check as adding the child, a code to your phone and your declaration. They lapse at 18. */
function GuardianChoices({ profile }: { profile: Profile }) {
  const [current, setCurrent] = useState<Record<string, { decision: string; decidedAs: string } | null>>({});
  const [pending, setPending] = useState<{ purpose: string; decision: string; scopes?: string[] } | null>(null);
  const [relationship, setRelationship] = useState("MOTHER");
  const [declaration, setDeclaration] = useState(false);
  const [check, setCheck] = useState<{ checkId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    call(`/api/patient/members/${profile.personId}/consents`, undefined, "GET").then((r) => { if (alive && r.ok) setCurrent(r.data); });
    return () => { alive = false; };
  }, [profile, tick]);
  async function start() {
    if (!pending) return;
    const r = await call(`/api/patient/members/${profile.personId}/consents`, { ...pending, scopes: pending.decision === "GRANTED" ? pending.scopes : undefined, relationship, declaration });
    if (r.ok) { setCheck(r.data); setMsg(null); } else setMsg(r.error);
  }
  async function confirm() {
    if (!check) return;
    const r = await call(`/api/patient/members/${profile.personId}/consents/confirm`, { checkId: check.checkId, code });
    if (r.ok) { setMsg("Saved as your choice for them. It lapses when they turn 18."); setPending(null); setCheck(null); setCode(""); setDeclaration(false); setTick((t) => t + 1); } else setMsg(r.error);
  }
  return (
    <Card>
      <SectionTitle><span className="inline-flex items-center gap-2"><ShieldCheck size={15} /> Your choices for {profile.name}</span></SectionTitle>
      <ul className="space-y-1.5 text-[12.5px]" aria-label="Guardian choices">
        {CHOICES.map((c) => (
          <li key={c.purpose} className="flex flex-wrap items-center gap-2">
            <span className="flex-1">{c.label}: <span className="font-medium">{current[c.purpose] ? DECIDED[current[c.purpose]!.decision] : "Not chosen"}</span></span>
            <button onClick={() => { setPending({ purpose: c.purpose, decision: "GRANTED", scopes: c.scopes }); setCheck(null); }} className="rounded-md border border-hairline px-2 py-0.5 text-[12px]">Allow</button>
            <button onClick={() => { setPending({ purpose: c.purpose, decision: "DECLINED" }); setCheck(null); }} className="rounded-md border border-hairline px-2 py-0.5 text-[12px]">Don&apos;t allow</button>
          </li>
        ))}
      </ul>
      {pending && !check && (
        <div className="mt-3 space-y-2" role="region" aria-label="Confirm your choice">
          <select aria-label="You are the child's" value={relationship} onChange={(e) => setRelationship(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1 text-[12.5px]">
            <option value="MOTHER">Mother</option><option value="FATHER">Father</option><option value="LEGAL_GUARDIAN">Legal guardian</option>
          </select>
          <label className="flex items-start gap-2 text-[12px] text-text-secondary">
            <input type="checkbox" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} className="mt-0.5" />
            I declare that I am this child&apos;s parent or legal guardian and make this choice on their behalf. It lapses when they turn 18, and they will then choose for themselves.
          </label>
          <button onClick={start} disabled={!declaration} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Send me a code</button>
        </div>
      )}
      {check && (
        <div className="mt-3">
          <p className="text-[12.5px]">We sent a code to your phone {check.sentTo}.</p>
          <input aria-label="Choice code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1.5 font-mono text-[13px]" />
          <button onClick={confirm} className="ml-2 rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink">Confirm</button>
        </div>
      )}
      {msg && <p className="mt-2 text-[12px] text-text-secondary" role="status">{msg}</p>}
    </Card>
  );
}

function MemberPanel({ profile }: { profile: Profile }) {
  const [view, setView] = useState<{ record: (SharedRecordData & { patient: { id: string } }) | null; uploads: { id: string; title: string }[] } | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [choice, setChoice] = useState<ShareChoiceValue>({ categories: DEFAULT_SHARE_CHOICE.filter((c) => profile.categories.includes(c)), sensitiveCategories: [], from: "", to: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const can = (p: string) => profile.permissions.includes(p);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    const has = (p: string) => profile.permissions.includes(p);
    Promise.all([
      has("VIEW") ? call(`/api/patient/members/${profile.personId}/record`, undefined, "GET") : null,
      has("UPLOAD") ? call(`/api/patient/members/${profile.personId}/facts`, undefined, "GET") : null,
    ]).then(([v, f]) => {
      if (!alive) return;
      if (v?.ok) setView(v.data);
      if (f?.ok) setFacts(f.data.facts);
    });
    return () => { alive = false; };
  }, [profile, tick]);
  async function upload() {
    if (!file) return;
    const fd = new FormData(); fd.set("file", file); fd.set("title", title || file.name); fd.set("type", "REPORT");
    const r = await fetch(`/api/patient/members/${profile.personId}/documents`, { method: "POST", body: fd }).catch(() => null);
    setMsg(r?.ok ? "Uploaded. It will be read shortly; then confirm what was found." : "The upload didn't go through."); setFile(null); setTitle(""); load();
  }
  async function confirmAll() {
    const ok = facts.filter((f) => f.bulkConfirmable);
    const r = await call(`/api/patient/members/${profile.personId}/facts`, { decisions: ok.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
    setMsg(r.ok ? "Confirmed. They're in the record as confirmed by you (by proxy)." : r.error); load();
  }
  async function share() {
    const r = await call(`/api/patient/members/${profile.personId}/share`, choiceBody(choice));
    if (r.ok) setCode(r.data.code); else setMsg(r.error);
  }
  return (
    <div role="region" className="space-y-4" aria-label={`Acting for ${profile.name}`}>
      <p className="rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2 text-[12.5px]">Acting for <span className="font-semibold">{profile.name}</span>. You may: {profile.permissions.join(", ").toLowerCase()}. Everything you do here is in their access log.</p>
      {can("VIEW") && (view?.record ? <SharedRecordSections data={view.record} /> : <Empty>{view ? `No hospital records yet${view.uploads.length ? `; documents: ${view.uploads.map((u) => u.title).join(", ")}` : ""}.` : "Loading…"}</Empty>)}
      {profile.basis === "GUARDIAN" && <GuardianChoices profile={profile} />}
      {can("UPLOAD") && (
        <Card>
          <SectionTitle><span className="inline-flex items-center gap-2"><Upload size={15} /> Upload a report for {profile.name}</span></SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Report file" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[12px]" />
            <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1 text-[12.5px]" />
            <button onClick={upload} disabled={!file} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Upload</button>
          </div>
          {facts.length > 0 && (
            <div className="mt-3" aria-label="Found in the documents">
              <p className="text-[12.5px] font-medium">Found in their documents ({facts.length}), waiting for you to check</p>
              <ul className="mt-1 space-y-0.5 text-[12px] text-text-secondary">{facts.map((f) => <li key={f.id}>{f.factType.toLowerCase().replace("_", " ")}: {Object.values(f.value).filter((x) => typeof x === "string").join(" ")}</li>)}</ul>
              <button onClick={confirmAll} disabled={!facts.some((f) => f.bulkConfirmable)} className="mt-2 rounded-md border border-hairline px-3 py-1 text-[12px] disabled:opacity-50">Confirm the clear ones</button>
            </div>
          )}
        </Card>
      )}
      {can("SHARE") && (
        <Card>
          <SectionTitle>Share {profile.name}&apos;s record with a doctor</SectionTitle>
          {code ? <p className="font-mono text-[22px] tracking-[0.2em] text-brand" aria-label="Visit code">{code}</p> : (
            <>
              <ShareChoices value={choice} onChange={setChoice} allowed={profile.categories} />
              <button onClick={share} disabled={!choice.categories.length} className="mt-2 rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink disabled:opacity-50">Get a visit code</button>
            </>
          )}
        </Card>
      )}
      {msg && <p className="text-[12px] text-text-secondary" role="status">{msg}</p>}
    </div>
  );
}

export default function HouseholdPage() {
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    Promise.all([call("/api/patient/household", undefined, "GET"), call("/api/patient/proxies/profiles", undefined, "GET"), call("/api/patient/proxies/about-me", undefined, "GET")]).then(([h, p, g]) => {
      setHouseholds(h.ok ? h.data.households : []); setProfiles(p.ok ? p.data.profiles : []); setGrants(g.ok ? g.data.grants : []);
    });
  }, [tick]);
  const mine = households?.find((h) => h.myRole === "MANAGER" && h.myStatus === "ACTIVE");
  const invites = (households ?? []).filter((h) => h.myStatus === "INVITED");
  const profile = profiles.find((p) => p.personId === active);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center gap-2"><Users size={18} className="text-brand" /><h1 className="text-[20px] font-semibold tracking-tight">Family</h1></div>
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Profiles">
        <button role="tab" aria-selected={!active} onClick={() => setActive(null)} className={`rounded-full border px-3 py-1 text-[12.5px] ${!active ? "border-brand bg-accent/10" : "border-hairline"}`}>Me</button>
        {profiles.map((p) => <button key={p.personId} role="tab" aria-selected={active === p.personId} onClick={() => setActive(p.personId)} className={`rounded-full border px-3 py-1 text-[12.5px] ${active === p.personId ? "border-brand bg-accent/10" : "border-hairline"}`}>{p.name}</button>)}
      </div>
      {profile ? <MemberPanel key={profile.personId} profile={profile} /> : (
        <>
          {invites.map((h) => (
            <Card key={h.householdId}>
              <p className="text-[13px]">You&apos;re invited to <span className="font-medium">{h.name}</span>. Nobody there sees anything of yours unless you choose.</p>
              <div className="mt-2 flex gap-2">
                <button onClick={async () => { await call(`/api/patient/household/members/${h.myMemberId}/accept`, {}); reload(); }} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink">Join (share nothing yet)</button>
                <button onClick={async () => { await call(`/api/patient/household/members/${h.myMemberId}/remove`, {}); reload(); }} className="rounded-md border border-hairline px-3 py-1.5 text-[12.5px]">Decline</button>
              </div>
            </Card>
          ))}
          <Card>
            <SectionTitle>Your household</SectionTitle>
            {households === null ? <Empty>Loading…</Empty> : !mine ? (
              <button onClick={async () => { await call("/api/patient/household", { name: "My family" }); reload(); }} className="rounded-md bg-cyan px-3 py-1.5 text-[12.5px] font-medium text-ink">Start a household</button>
            ) : (
              <>
                <ul className="space-y-1.5" aria-label="Members">
                  {mine.members.map((m) => (
                    <li key={m.memberId} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span><span className="font-medium">{m.name}</span> <span className="text-text-tertiary">· {TYPE[m.memberType] ?? m.memberType}{STATUS[m.status] ? ` · ${STATUS[m.status]}` : ""}</span></span>
                      {m.status === "PENDING_CONSENT" && <span className="text-[11.5px] text-text-tertiary">Reference for staff: {m.memberId}</span>}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12.5px]"><UserPlus size={13} /> Add a child</button>
                  <input aria-label="Invite by email" placeholder="Invite an adult by email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-hairline bg-transparent px-2 py-1 text-[12.5px]" />
                  <button onClick={async () => { await call(`/api/patient/household/${mine.householdId}/invite`, { email }); setEmail(""); reload(); }} disabled={!email} className="rounded-md border border-hairline px-3 py-1.5 text-[12.5px] disabled:opacity-50">Invite</button>
                </div>
                {adding && <div className="mt-3"><AddChild householdId={mine.householdId} onDone={() => { setAdding(false); reload(); }} /></div>}
              </>
            )}
          </Card>
          <Card>
            <SectionTitle><span className="inline-flex items-center gap-2"><ShieldCheck size={15} /> Who can act for you</span></SectionTitle>
            {grants.length === 0 ? <Empty>Nobody acts for you.</Empty> : (
              <ul className="space-y-1.5" aria-label="Your proxies">
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                    <span><span className="font-medium">{g.proxyName}</span> <span className="text-text-tertiary">· {g.permissions.join(", ").toLowerCase()}</span></span>
                    <button onClick={async () => { await call(`/api/patient/proxies/grants/${g.id}`, undefined, "DELETE"); reload(); }} className="rounded-md border border-hairline px-2.5 py-1 text-[12px] hover:border-danger/40 hover:text-danger">Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
