import { prisma } from "@/lib/db";
import { loadActorMemberships } from "@/lib/auth/tenantContext";
import { createDefinition, createVersion, publishVersion } from "./definitions";
import type { WorkflowConfig } from "./definition";

/**
 * Phase D7 — a small canonical catalogue that proves the engine end-to-end (§27).
 * These are GLOBAL (platform) templates, idempotent by key. They are proof
 * workflows, not the final configurable hospital library (that is later D8 work).
 */

interface SeedWorkflow { key: string; name: string; description: string; config: WorkflowConfig }

const SEED_WORKFLOWS: SeedWorkflow[] = [
  {
    key: "critical-lab-review",
    name: "Critical lab result review",
    description: "When a critical lab result is released, escalate its follow-up task (created by the task-generator) to the hospital administrator if it is still open after the SLA. Never creates a task of its own.",
    config: {
      trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } },
      steps: [
        {
          type: "ESCALATE", key: "escalate",
          target: { taskType: "CRITICAL_RESULT_FOLLOW_UP", sourceField: "payload.resultId" },
          afterSeconds: 900, raisePriorityTo: "STAT", reassignToRole: "HOSPITAL_ADMIN",
        },
      ],
    },
  },
  {
    key: "admission-tasks",
    name: "Admission task set",
    description: "When a patient is admitted, create the admission checklist task.",
    config: {
      trigger: { eventType: "AdmissionCreated", eventVersion: 1 },
      steps: [{ type: "TASK", key: "admit-checklist", taskType: "ADMISSION_CHECKLIST", title: "Complete admission checklist", priority: "URGENT", assignedRole: "NURSE" }],
    },
  },
  {
    key: "collections-followup",
    name: "Invoice collections follow-up",
    description: "When a SaaS invoice is finalized, create a collections follow-up task and escalate if it lingers.",
    config: {
      trigger: { eventType: "InvoiceFinalized", eventVersion: 1 },
      steps: [
        {
          type: "TASK", key: "collect", taskType: "COLLECTIONS_FOLLOWUP", title: "Follow up on finalized invoice",
          priority: "ROUTINE", assignedRole: "BILLING_STAFF",
          sla: { dueAfterSeconds: 86400, escalation: { taskType: "COLLECTIONS_ESCALATION", title: "Invoice unresolved past follow-up SLA", priority: "URGENT" } },
        },
      ],
    },
  },
  {
    key: "consent-followup",
    name: "Consent granted follow-up",
    description: "When interoperability consent is granted, create an operational follow-up task (no external network calls).",
    config: {
      trigger: { eventType: "ConsentGranted", eventVersion: 1 },
      steps: [{ type: "TASK", key: "consent-note", taskType: "CONSENT_FOLLOWUP", title: "Record consent follow-up", priority: "ROUTINE", assignedRole: "HOSPITAL_ADMIN" }],
    },
  },
];

/** Canonical JSON (sorted keys), so a stored config compares equal to the seed's. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * Idempotently create + publish the canonical global workflows. A template
 * whose published config differs from the seed gets a new version published
 * (versions are immutable), so existing environments pick up a change such as
 * critical-lab-review becoming escalate-only.
 */
export async function ensureWorkflowSeed(platformUserId: string): Promise<{ created: number; updated: number }> {
  const m = await loadActorMemberships(platformUserId, "AAROGYA_ADMIN");
  let created = 0;
  let updated = 0;
  for (const w of SEED_WORKFLOWS) {
    const existing = await prisma.workflowDefinition.findFirst({ where: { organizationId: null, key: w.key }, select: { id: true, currentVersionId: true } });
    if (existing) {
      const current = existing.currentVersionId ? await prisma.workflowVersion.findUnique({ where: { id: existing.currentVersionId }, select: { config: true } }) : null;
      if (current && canonical(current.config) === canonical(w.config)) continue;
      const v = await createVersion(m, existing.id, w.config);
      await publishVersion(m, existing.id, v.id);
      updated++;
      continue;
    }
    const def = await createDefinition(m, { organizationId: null, key: w.key, name: w.name, description: w.description, config: w.config });
    const draft = def.versions.find((v) => v.version === 1);
    if (draft) await publishVersion(m, def.id, draft.id);
    created++;
  }
  return { created, updated };
}
