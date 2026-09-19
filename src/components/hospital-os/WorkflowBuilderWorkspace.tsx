"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Workflow, Plus, ArrowUp, ArrowDown, Trash2, Play, CheckCircle2, Save, Rocket } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { useToastStore } from "@/store/useToastStore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Phase D9 — visual Workflow Builder. An accessible, structured authoring workspace
 * (palette + vertical pipeline + properties + live validation + simulation) that
 * produces the canonical D7 workflow definition. The backend is authoritative:
 * every save/validate/publish/simulate re-runs server-side. Not a code editor, not a
 * BPMN platform. Uses the existing design system.
 */

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

type Step = any;
const uid = () => Math.random().toString(36).slice(2, 8);

const priorityTone = (p: string): StatusTone => (p === "STAT" ? "danger" : p === "URGENT" ? "warning" : "neutral");

export function WorkflowBuilderWorkspace() {
  const push = useToastStore((s) => s.push);
  const [meta, setMeta] = useState<any>(null);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [visible, setVisible] = useState<boolean | null>(null);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [name, setName] = useState("New workflow");
  const [key, setKey] = useState("");
  const [trigger, setTrigger] = useState<any>(null); // { eventType, eventVersion, condition? }
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [sim, setSim] = useState<any>(null);
  const [simPayload, setSimPayload] = useState('{ "critical": true }');
  const [drafts, setDrafts] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);

  useEffect(() => {
    api("/api/hospital/enterprise/workflow-builder/metadata").then(({ ok, data }) => {
      if (!ok) { setVisible(false); return; }
      setVisible(true); setMeta(data);
    });
    api("/api/hospital/enterprise/organizations").then(({ ok, data }) => {
      if (ok) { setOrgs(data.organizations ?? []); setOrgId((p) => p || data.organizations?.[0]?.id || ""); }
    });
    api("/api/hospital/enterprise/workflow-builder/templates").then(({ ok, data }) => { if (ok) setTemplates(data.templates ?? []); });
  }, []);

  const loadDrafts = useCallback(() => {
    if (!orgId) return;
    api(`/api/hospital/enterprise/workflow-builder/drafts?organizationId=${orgId}`).then(({ ok, data }) => { if (ok) setDrafts(data.drafts ?? []); });
  }, [orgId]);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  const documentObj = useMemo(() => ({ name, ...(trigger ? { trigger } : {}), steps }), [name, trigger, steps]);

  // Live (advisory) validation — the server re-validates on save/publish.
  useEffect(() => {
    const t = setTimeout(() => {
      api("/api/hospital/enterprise/workflow-builder/validate", { method: "POST", body: JSON.stringify({ document: documentObj }) })
        .then(({ ok, data }) => { if (ok) setReport(data); });
    }, 350);
    return () => clearTimeout(t);
  }, [documentObj]);

  if (visible === false) return <div className="p-6 text-[13px] text-text-tertiary">You do not have access to the Workflow Builder.</div>;
  if (!meta) return <div className="p-6 text-[13px] text-text-tertiary">Loading builder…</div>;

  function addStep(type: string) {
    const k = `${type.toLowerCase()}_${uid()}`;
    const base: any = { type, key: k };
    if (type === "TASK") Object.assign(base, { taskType: "TASK", title: "New task", priority: "ROUTINE" });
    if (type === "TIMER") Object.assign(base, { dueAfterSeconds: 3600 });
    if (type === "CONDITION") Object.assign(base, { condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } });
    if (type === "ACTION") Object.assign(base, { action: { name: meta.actions[0] ?? "UPDATE_WORKFLOW_STATE", params: {} } });
    setSteps((s) => [...s, base]);
    setSelected(k);
  }
  const move = (i: number, d: number) => setSteps((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const del = (k: string) => setSteps((s) => s.filter((x) => x.key !== k));
  const patchStep = (k: string, patch: any) => setSteps((s) => s.map((x) => (x.key === k ? { ...x, ...patch } : x)));

  async function loadTemplate(id: string) {
    const { ok, data } = await api(`/api/hospital/enterprise/workflow-builder/templates/${id}`);
    if (!ok) return push("Template load failed", "red");
    const d = data.document;
    setName(d.name); setKey(id + "-" + uid()); setTrigger(d.trigger ?? null); setSteps(d.steps ?? []); setDraftId(null); setSelected(null);
    push("Template copied into a new draft (not published)", "emerald");
  }

  async function loadDraft(id: string) {
    const { ok, data } = await api(`/api/hospital/enterprise/workflow-builder/drafts/${id}`);
    if (!ok) return push("Draft load failed", "red");
    const d = data.draft; const doc = d.document;
    setDraftId(d.id); setName(d.name); setKey(d.key); setTrigger(doc.trigger ?? null); setSteps(doc.steps ?? []); setSelected(null);
  }

  async function save() {
    if (!orgId || !key) return push("Set an organization and a key first", "red");
    const { ok, data } = await api("/api/hospital/enterprise/workflow-builder/drafts", { method: "POST", body: JSON.stringify({ id: draftId, organizationId: orgId, key, name, document: documentObj }) });
    if (ok) { setDraftId(data.draft.id); push("Draft saved", "emerald"); loadDrafts(); } else push(data.error ?? "Save failed", "red");
  }
  async function publish() {
    if (!draftId) { await save(); }
    const id = draftId ?? (await api(`/api/hospital/enterprise/workflow-builder/drafts?organizationId=${orgId}`)).data?.drafts?.find((x: any) => x.key === key)?.id;
    if (!id) return push("Save the draft before publishing", "red");
    const { ok, data } = await api(`/api/hospital/enterprise/workflow-builder/drafts/${id}/publish`, { method: "POST", body: "{}" });
    push(ok ? `Published "${data.definition?.key}" (D7 can now execute it)` : (data.error ?? "Publish failed"), ok ? "emerald" : "red");
    if (ok) loadDrafts();
  }
  async function simulate() {
    let payload: any = {};
    try { payload = JSON.parse(simPayload); } catch { return push("Simulation payload is not valid JSON", "red"); }
    const { ok, data } = await api("/api/hospital/enterprise/workflow-builder/simulate", { method: "POST", body: JSON.stringify({ document: documentObj, key, organizationId: orgId, payload }) });
    if (ok) setSim(data); else push(data.error ?? "Simulation failed", "red");
  }

  const selectedStep = steps.find((s) => s.key === selected);

  return (
    <div className="space-y-4">
      <ToastViewport />
      <div className="flex flex-wrap items-center gap-2">
        <Workflow size={18} className="text-brand" />
        <h1 className="text-[17px] font-semibold">Workflow Builder</h1>
        <span className="text-[12px] text-text-tertiary">Author workflows without code — validated, versioned, executed by D7</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={save}><Save size={14} /> Save draft</Button>
          <Button size="sm" variant="secondary" onClick={simulate}><Play size={14} /> Simulate</Button>
          <Button size="sm" variant="primary" onClick={publish}><Rocket size={14} /> Publish</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Workflow name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-hairline bg-surface px-2 py-1 text-[13px]" />
        <input aria-label="Workflow key" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="stable-key" className="w-[180px] rounded-lg border border-hairline bg-surface px-2 py-1 text-[12px]" />
        <select aria-label="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)} className="rounded-lg border border-hairline bg-surface px-2 py-1 text-[12px]">
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {report && <StatusPill tone={report.valid ? "success" : "warning"} dot={false} label={report.valid ? "Valid — publishable" : "Draft — not yet publishable"} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr_300px]">
        {/* Palette + drafts + templates */}
        <div className="space-y-3">
          <Card className="p-3">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Add node</div>
            <div className="flex flex-col gap-1">
              {meta.stepTypes.map((t: string) => (
                <Button key={t} size="sm" variant="ghost" onClick={() => addStep(t)}><Plus size={13} /> {t}</Button>
              ))}
            </div>
          </Card>
          <Card className="p-3">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Templates</div>
            <div className="flex flex-col gap-1">
              {templates.map((t) => <button key={t.id} onClick={() => loadTemplate(t.id)} className="text-left text-[12px] text-brand hover:underline">{t.name}</button>)}
            </div>
          </Card>
          <Card className="p-3">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Drafts</div>
            {drafts.length === 0 ? <div className="text-[11px] text-text-tertiary">No drafts</div> : (
              <div className="flex flex-col gap-1">
                {drafts.map((d) => <button key={d.id} onClick={() => loadDraft(d.id)} className="truncate text-left text-[12px] hover:underline">{d.name}</button>)}
              </div>
            )}
          </Card>
        </div>

        {/* Pipeline canvas */}
        <div className="space-y-2">
          <Card className="p-3">
            <div className="text-[11px] uppercase tracking-wide text-text-tertiary">WHEN (trigger)</div>
            <select aria-label="Trigger event" value={trigger ? `${trigger.eventType}@${trigger.eventVersion}` : ""}
              onChange={(e) => { const [t, v] = e.target.value.split("@"); setTrigger(v ? { eventType: t, eventVersion: Number(v), ...(trigger?.condition ? { condition: trigger.condition } : {}) } : null); }}
              className="mt-1 w-full rounded-lg border border-hairline bg-surface px-2 py-1 text-[13px]">
              <option value="">Select an event…</option>
              {meta.triggers.map((t: any) => <option key={`${t.eventType}@${t.eventVersion}`} value={`${t.eventType}@${t.eventVersion}`}>{t.eventType}@{t.eventVersion}</option>)}
            </select>
            {trigger && <ConditionEditor label="IF (trigger condition, optional)" meta={meta} value={trigger.condition ?? null} onChange={(c: any) => setTrigger({ ...trigger, ...(c ? { condition: c } : {}) })} clearable onClear={() => { const { condition, ...rest } = trigger; void condition; setTrigger(rest); }} />}
          </Card>

          <div className="text-center text-[11px] text-text-tertiary">THEN ↓</div>

          {steps.length === 0 && <Card className="p-3 text-[12px] text-text-tertiary">No steps yet — add a Task, Timer, Condition, or Action from the palette.</Card>}
          {steps.map((s, i) => (
            <Card key={s.key} className={`p-3 ${selected === s.key ? "ring-1 ring-brand" : ""}`}>
              <div className="flex items-center gap-2">
                <button onClick={() => setSelected(s.key)} className="flex items-center gap-2 text-left">
                  <StatusPill tone={s.type === "TASK" ? "brand" : s.type === "TIMER" ? "info" : s.type === "CONDITION" ? "neutral" : "success"} dot={false} label={s.type} />
                  <span className="text-[13px] font-medium">{s.title ?? s.taskType ?? s.key}</span>
                  {s.priority && <StatusPill tone={priorityTone(s.priority)} dot={false} label={s.priority} />}
                  {s.sla && <span className="text-[11px] text-text-tertiary">SLA {s.sla.dueAfterSeconds}s</span>}
                </button>
                <div className="ml-auto flex gap-1">
                  <button aria-label="Move up" onClick={() => move(i, -1)} className="rounded p-1 hover:bg-fill-hover"><ArrowUp size={13} /></button>
                  <button aria-label="Move down" onClick={() => move(i, 1)} className="rounded p-1 hover:bg-fill-hover"><ArrowDown size={13} /></button>
                  <button aria-label="Delete" onClick={() => del(s.key)} className="rounded p-1 text-danger hover:bg-fill-hover"><Trash2 size={13} /></button>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Properties + validation + simulation */}
        <div className="space-y-3">
          <Card className="p-3">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Properties</div>
            {!selectedStep ? <div className="text-[11px] text-text-tertiary">Select a node to edit.</div> : (
              <StepProperties meta={meta} step={selectedStep} onChange={(patch: any) => patchStep(selectedStep.key, patch)} />
            )}
          </Card>

          <Card className="p-3">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-secondary"><CheckCircle2 size={14} /> Validation</div>
            {report?.sections?.map((sec: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-[12px]">
                <span className={sec.ok ? "text-success" : "text-danger"}>{sec.ok ? "✓" : "✗"}</span>
                <span className="text-text-secondary">{sec.label}:</span>
                <span className="text-text-tertiary">{sec.detail}</span>
              </div>
            ))}
            {report?.errors?.map((e: string, i: number) => <div key={i} className="text-[12px] text-danger">✗ {e}</div>)}
          </Card>

          <Card className="p-3">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Simulation (safe)</div>
            <textarea aria-label="Simulation payload" value={simPayload} onChange={(e) => setSimPayload(e.target.value)} rows={3}
              className="w-full rounded-lg border border-hairline bg-surface p-2 font-mono text-[11px]" />
            <Button className="mt-1" size="sm" variant="secondary" onClick={simulate}><Play size={13} /> Run simulation</Button>
            {sim && (
              <div className="mt-2 space-y-1 text-[11px]">
                <StatusPill tone={sim.triggerMatched ? "success" : "warning"} dot={false} label={sim.triggerMatched ? "Trigger matched" : "Trigger not matched"} />
                {sim.steps.map((st: any, i: number) => (
                  <div key={i} className={st.outcome === "WOULD_EXECUTE" ? "text-text-secondary" : "text-text-tertiary"}>
                    {st.outcome === "WOULD_EXECUTE" ? "✓" : "•"} {st.type} {st.key}: {st.detail}
                  </div>
                ))}
                <div className="text-text-tertiary italic">{sim.notes?.[0]}</div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ConditionEditor({ label, meta, value, onChange, clearable, onClear }: any) {
  const group = value && (value.all || value.any) ? value : { all: value ? [value] : [] };
  const combinator = group.all ? "all" : "any";
  const leaves: any[] = group[combinator] ?? [];
  const setLeaves = (next: any[]) => onChange({ [combinator]: next });
  return (
    <div className="mt-2 rounded-lg border border-hairline p-2">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-text-tertiary">
        <span>{label}</span>
        <select aria-label="Combinator" value={combinator} onChange={(e) => onChange({ [e.target.value]: leaves })} className="rounded border border-hairline bg-surface px-1 text-[11px]">
          <option value="all">ALL of</option><option value="any">ANY of</option>
        </select>
        {clearable && <button onClick={onClear} className="ml-auto text-danger">clear</button>}
      </div>
      {leaves.map((leaf, i) => (
        <div key={i} className="mb-1 flex flex-wrap gap-1">
          <input aria-label="Field" value={leaf.field ?? ""} onChange={(e) => setLeaves(leaves.map((l, j) => (j === i ? { ...l, field: e.target.value } : l)))} placeholder="payload.field" className="w-[130px] rounded border border-hairline bg-surface px-1 py-0.5 text-[11px]" />
          <select aria-label="Operator" value={leaf.operator ?? "equals"} onChange={(e) => setLeaves(leaves.map((l, j) => (j === i ? { ...l, operator: e.target.value } : l)))} className="rounded border border-hairline bg-surface px-1 text-[11px]">
            {meta.operators.map((op: string) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input aria-label="Value" value={String(leaf.value ?? "")} onChange={(e) => { const v = e.target.value; const parsed = v === "true" ? true : v === "false" ? false : /^-?\d+$/.test(v) ? Number(v) : v; setLeaves(leaves.map((l, j) => (j === i ? { ...l, value: parsed } : l))); }} placeholder="value" className="w-[90px] rounded border border-hairline bg-surface px-1 py-0.5 text-[11px]" />
          <button aria-label="Remove rule" onClick={() => setLeaves(leaves.filter((_, j) => j !== i))} className="text-danger">×</button>
        </div>
      ))}
      <button onClick={() => setLeaves([...leaves, { field: "payload.", operator: "equals", value: "" }])} className="text-[11px] text-brand hover:underline">+ rule</button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mb-2 block text-[11px] text-text-tertiary">{label}{children}</label>;
}

function StepProperties({ meta, step, onChange }: any) {
  const inp = "mt-0.5 w-full rounded border border-hairline bg-surface px-2 py-1 text-[12px]";
  if (step.type === "TASK") return (
    <div>
      <Field label="Title"><input className={inp} value={step.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} /></Field>
      <Field label="Task type"><input className={inp} value={step.taskType ?? ""} onChange={(e) => onChange({ taskType: e.target.value })} /></Field>
      <Field label="Priority"><select className={inp} value={step.priority ?? "ROUTINE"} onChange={(e) => onChange({ priority: e.target.value })}>{meta.priorities.map((p: string) => <option key={p}>{p}</option>)}</select></Field>
      <Field label="Assigned role"><input className={inp} value={step.assignedRole ?? ""} onChange={(e) => onChange({ assignedRole: e.target.value || undefined })} /></Field>
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={!!step.sla} onChange={(e) => onChange({ sla: e.target.checked ? { dueAfterSeconds: 900, escalation: { taskType: "ESCALATION", title: "SLA breached", priority: "STAT" } } : undefined })} /> SLA + escalation
      </label>
      {step.sla && <Field label="SLA seconds"><input type="number" className={inp} value={step.sla.dueAfterSeconds} onChange={(e) => onChange({ sla: { ...step.sla, dueAfterSeconds: Number(e.target.value) } })} /></Field>}
    </div>
  );
  if (step.type === "TIMER") return <Field label="Delay seconds"><input type="number" className={inp} value={step.dueAfterSeconds} onChange={(e) => onChange({ dueAfterSeconds: Number(e.target.value) })} /></Field>;
  if (step.type === "ACTION") return (
    <Field label="Action"><select className={inp} value={step.action?.name} onChange={(e) => onChange({ action: { name: e.target.value, params: {} } })}>{meta.actions.map((a: string) => <option key={a}>{a}</option>)}</select></Field>
  );
  if (step.type === "CONDITION") return <ConditionEditor label="Condition" meta={meta} value={step.condition} onChange={(c: any) => onChange({ condition: c })} />;
  return null;
}
