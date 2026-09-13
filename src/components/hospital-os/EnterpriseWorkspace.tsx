"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Hospital, Users, SlidersHorizontal, Plus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { useToastStore } from "@/store/useToastStore";
import { ToastViewport } from "@/components/shared/ToastViewport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D1 — enterprise control plane.
 *
 * A restrained administrative console over the organization/facility hierarchy.
 * It only ever shows what the backend returns for THIS caller: organizations
 * they belong to, facilities they can reach, members they may administer. The
 * UI never implies access the server does not grant — every action round-trips
 * to a permission- and membership-checked API and surfaces the real result.
 */

const statusTone = (s: string): StatusTone =>
  s === "ACTIVE" ? "success"
    : s === "SUSPENDED" ? "warning"
      : s === "PROVISIONING" ? "info"
        : s === "DEACTIVATED" ? "danger" : "neutral";

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function EnterpriseWorkspace() {
  const push = useToastStore((s) => s.push);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [config, setConfig] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadOrgs = useCallback(async () => {
    const { ok, data } = await api("/api/hospital/enterprise/organizations");
    if (ok) {
      setOrgs(data.organizations ?? []);
      setSelectedId((prev) => prev ?? data.organizations?.[0]?.id ?? null);
    }
  }, []);
  useEffect(() => { loadOrgs(); }, [loadOrgs]);

  const loadDetail = useCallback(async (orgId: string) => {
    setLoading(true);
    const [d, mem, cfg] = await Promise.all([
      api(`/api/hospital/enterprise/organizations/${orgId}`),
      api(`/api/hospital/enterprise/organizations/${orgId}/members`),
      api(`/api/hospital/enterprise/config?organizationId=${orgId}`),
    ]);
    setDetail(d.ok ? d.data.organization : null);
    setMembers(mem.ok ? mem.data.members ?? [] : []);
    setConfig(cfg.ok ? cfg.data.config ?? [] : []);
    setLoading(false);
  }, []);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  async function act(label: string, url: string, init: RequestInit) {
    const { ok, data } = await api(url, init);
    if (!ok) { push(data.error ?? `${label} failed.`, "red"); return false; }
    push(`${label} done.`, "emerald");
    if (selectedId) loadDetail(selectedId);
    loadOrgs();
    return true;
  }

  return (
    <div className="space-y-4">
      <ToastViewport />

      <div className="flex items-center gap-2">
        <Building2 size={18} className="text-brand" />
        <h1 className="text-[17px] font-semibold">Enterprise</h1>
        <span className="text-[12px] text-text-tertiary">Organizations, facilities, memberships and configuration</span>
      </div>

      {orgs.length === 0 ? (
        <Card className="p-6 text-center text-[13px] text-text-tertiary">
          You do not administer any organizations.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
          {/* Organization list */}
          <div className="space-y-2">
            <CardLabel>Organizations</CardLabel>
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => setSelectedId(o.id)}
                className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-[13px] transition-colors ${
                  selectedId === o.id ? "border-brand bg-brand/5" : "border-hairline hover:bg-fill-hover"
                }`}
              >
                <span className="truncate">{o.name}</span>
                <StatusPill label={o.status} tone={statusTone(o.status)} dot={false} />
              </button>
            ))}
          </div>

          {/* Selected organization */}
          <div className="space-y-4">
            {loading && !detail ? (
              <Card className="p-6 text-[13px] text-text-tertiary">Loading…</Card>
            ) : detail ? (
              <>
                <OrganizationPanel org={detail} onTransition={(to) =>
                  act("Organization update", `/api/hospital/enterprise/organizations/${detail.id}/transition`, {
                    method: "POST", body: JSON.stringify({ to }),
                  })
                } />
                <FacilitiesPanel org={detail} onAction={act} />
                <MembersPanel orgId={detail.id} members={members} onAction={act} />
                <ConfigPanel orgId={detail.id} config={config} onAction={act} />
              </>
            ) : (
              <Card className="p-6 text-[13px] text-text-tertiary">Select an organization.</Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OrganizationPanel({ org, onTransition }: { org: any; onTransition: (to: string) => void }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold">{org.name}</h2>
            <StatusPill label={org.status} tone={statusTone(org.status)} />
          </div>
          {org.slug && <p className="mt-0.5 text-[11px] text-text-tertiary">{org.slug}</p>}
        </div>
        <div className="flex gap-2">
          {org.status === "ACTIVE" && (
            <Button size="sm" variant="secondary" onClick={() => onTransition("SUSPENDED")}>Suspend</Button>
          )}
          {org.status === "SUSPENDED" && (
            <Button size="sm" variant="primary" onClick={() => onTransition("ACTIVE")}>Reactivate</Button>
          )}
          {org.status !== "DEACTIVATED" && (
            <Button size="sm" variant="danger" onClick={() => onTransition("DEACTIVATED")}>Deactivate</Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function FacilitiesPanel({ org, onAction }: { org: any; onAction: (l: string, u: string, i: RequestInit) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const facilities = org.facilities ?? [];
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2"><Hospital size={15} className="text-brand" /><CardLabel>Facilities</CardLabel></div>
      <div className="space-y-2">
        {facilities.map((f: any) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span>{f.name}</span>
              {f.city && <span className="text-text-tertiary">· {f.city}</span>}
              <StatusPill label={f.status} tone={statusTone(f.status)} dot={false} />
            </div>
            <div className="flex gap-1.5">
              {f.status === "PROVISIONING" && (
                <Button size="sm" variant="primary" onClick={() => onAction("Facility activate", `/api/hospital/enterprise/facilities/${f.id}/transition`, { method: "POST", body: JSON.stringify({ to: "ACTIVE" }) })}>Activate</Button>
              )}
              {f.status === "ACTIVE" && (
                <Button size="sm" variant="secondary" onClick={() => onAction("Facility suspend", `/api/hospital/enterprise/facilities/${f.id}/transition`, { method: "POST", body: JSON.stringify({ to: "SUSPENDED" }) })}>Suspend</Button>
              )}
              {f.status === "SUSPENDED" && (
                <Button size="sm" variant="primary" onClick={() => onAction("Facility reactivate", `/api/hospital/enterprise/facilities/${f.id}/transition`, { method: "POST", body: JSON.stringify({ to: "ACTIVE" }) })}>Reactivate</Button>
              )}
            </div>
          </div>
        ))}
        {facilities.length === 0 && <p className="text-[12px] text-text-tertiary">No facilities.</p>}
      </div>
      {org.status === "ACTIVE" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-hairline pt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Facility name"
            className="h-8 rounded-control border border-hairline bg-card px-2 text-[13px]" />
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug (optional)"
            className="h-8 w-36 rounded-control border border-hairline bg-card px-2 text-[13px]" />
          <Button size="sm" leftIcon={<Plus size={14} />} onClick={async () => {
            const ok = await onAction("Facility create", `/api/hospital/enterprise/organizations/${org.id}/facilities`, {
              method: "POST", body: JSON.stringify({ name, slug: slug || undefined }),
            });
            if (ok) { setName(""); setSlug(""); }
          }} disabled={!name.trim()}>Add facility</Button>
        </div>
      )}
    </Card>
  );
}

function MembersPanel({ orgId, members, onAction }: { orgId: string; members: any[]; onAction: (l: string, u: string, i: RequestInit) => Promise<boolean> }) {
  const [userId, setUserId] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2"><Users size={15} className="text-brand" /><CardLabel>Organization members</CardLabel></div>
      <div className="space-y-1.5">
        {members.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2">
              <span>{m.user?.displayName ?? m.userId}</span>
              <span className="text-text-tertiary">{m.user?.email}</span>
              {m.isAdmin && <StatusPill label="Org admin" tone="brand" dot={false} />}
              {m.status !== "ACTIVE" && <StatusPill label={m.status} tone="warning" dot={false} />}
            </div>
            <Button size="sm" variant="ghost" onClick={() => onAction("Member removed", `/api/hospital/enterprise/organizations/${orgId}/members/${m.id}`, { method: "DELETE" })}>Remove</Button>
          </div>
        ))}
        {members.length === 0 && <p className="text-[12px] text-text-tertiary">No members.</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="User ID"
          className="h-8 w-56 rounded-control border border-hairline bg-card px-2 text-[13px]" />
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Org admin
        </label>
        <Button size="sm" leftIcon={<Plus size={14} />} disabled={!userId.trim()} onClick={async () => {
          const ok = await onAction("Member added", `/api/hospital/enterprise/organizations/${orgId}/members`, {
            method: "POST", body: JSON.stringify({ userId, isAdmin }),
          });
          if (ok) { setUserId(""); setIsAdmin(false); }
        }}>Add member</Button>
      </div>
    </Card>
  );
}

function ConfigPanel({ orgId, config, onAction }: { orgId: string; config: any[]; onAction: (l: string, u: string, i: RequestInit) => Promise<boolean> }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2"><SlidersHorizontal size={15} className="text-brand" /><CardLabel>Configuration (organization level)</CardLabel></div>
      <div className="space-y-2">
        {config.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13px]">
            <div>
              <p className="font-medium">{c.key}</p>
              <p className="text-[11px] text-text-tertiary">
                Effective: <span className="text-text-secondary">{c.value}</span> ·{" "}
                <StatusPill label={c.explicit ? `override (${c.source})` : `inherited (${c.source})`} tone={c.explicit ? "brand" : "neutral"} dot={false} />
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <input value={edits[c.key] ?? ""} onChange={(e) => setEdits((s) => ({ ...s, [c.key]: e.target.value }))}
                placeholder="new value" className="h-8 w-28 rounded-control border border-hairline bg-card px-2 text-[13px]" />
              <Button size="sm" variant="secondary" disabled={!edits[c.key]} onClick={async () => {
                const ok = await onAction("Config override", `/api/hospital/enterprise/config`, {
                  method: "PUT", body: JSON.stringify({ level: "organization", targetId: orgId, key: c.key, value: edits[c.key] }),
                });
                if (ok) setEdits((s) => ({ ...s, [c.key]: "" }));
              }}>Override</Button>
              {c.explicit && c.source === "organization" && (
                <Button size="sm" variant="ghost" onClick={() => onAction("Config reset", `/api/hospital/enterprise/config`, {
                  method: "DELETE", body: JSON.stringify({ level: "organization", targetId: orgId, key: c.key }),
                })}>Reset</Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
