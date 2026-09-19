import type { BuilderDocument } from "./document";

/**
 * Phase D9 — a small set of SAFE starter templates (§25). Each uses only real D6
 * events and D7 actions, and compiles to a valid canonical config. Templates are
 * COPIED into a draft (never auto-published) — the administrator reviews, validates,
 * and publishes.
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  document: BuilderDocument;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "icu-admission",
    name: "ICU admission task set",
    description: "When a patient is admitted, create the core ICU admission tasks (nursing assessment, intensivist review, pharmacy review). Add a trigger condition once the event carries the admitting department.",
    document: {
      name: "ICU admission task set",
      trigger: { eventType: "AdmissionCreated", eventVersion: 1 },
      steps: [
        { type: "TASK", key: "nursing", taskType: "NURSING_ASSESSMENT", title: "Nursing assessment", priority: "URGENT", assignedRole: "NURSE" },
        { type: "TASK", key: "intensivist", taskType: "INTENSIVIST_REVIEW", title: "Intensivist review", priority: "URGENT", assignedRole: "DOCTOR" },
        { type: "TASK", key: "pharmacy", taskType: "PHARMACY_REVIEW", title: "Pharmacy review", priority: "ROUTINE", assignedRole: "PHARMACIST" },
      ],
    },
  },
  {
    id: "critical-lab",
    name: "Critical lab review",
    description: "When a critical lab result is released, create a STAT clinical review task with an SLA and escalation. The SLA is configurable per hospital via the D8 configuration engine.",
    document: {
      name: "Critical lab review",
      trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } },
      steps: [
        {
          type: "TASK", key: "review", taskType: "CRITICAL_RESULT_REVIEW", title: "Review critical lab result",
          priority: "STAT", assignedRole: "DOCTOR",
          sla: { dueAfterSeconds: 900, escalation: { taskType: "CRITICAL_RESULT_ESCALATION", title: "Critical result not reviewed within SLA", priority: "STAT", assignedRole: "HOSPITAL_ADMIN" } },
        },
      ],
    },
  },
  {
    id: "collections-followup",
    name: "Invoice collections follow-up",
    description: "When a SaaS invoice is finalized, create a collections follow-up task and escalate if it lingers past its SLA.",
    document: {
      name: "Invoice collections follow-up",
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
];

export function listTemplates() {
  return WORKFLOW_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
