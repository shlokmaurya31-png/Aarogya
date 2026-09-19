import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { createDefinition, createVersion, publishVersion, getDefinition, getVersionConfig } from "@/lib/workflows";
import { assertCanAuthorWorkflow, assertCanReadWorkflowScope } from "@/lib/workflows/authz";
import { parseBuilderDocument, type BuilderDocument } from "./document";
import { compileBuilderDocument } from "./compile";

/**
 * Phase D9 — builder draft lifecycle + publication + import/export.
 *
 * Drafts (possibly incomplete) live in WorkflowBuilderDraft; publishing COMPILES a
 * draft to the canonical config and drives the authoritative D7 lifecycle
 * (createDefinition/createVersion → publishVersion). The client can never create a
 * trusted published workflow directly. Authoring is tenant-scoped
 * (assertCanAuthorWorkflow); global templates remain platform-only.
 */

export interface SaveDraftInput {
  id?: string;
  organizationId: string;
  facilityId?: string | null;
  workflowDefinitionId?: string | null;
  key: string;
  name: string;
  document: unknown;
}

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/;

export async function saveDraft(m: ActorMemberships, input: SaveDraftInput) {
  assertCanAuthorWorkflow(m, input.organizationId);
  if (!KEY_RE.test(input.key)) throw new BadRequestError("key must be a lowercase slug ([a-z0-9_.-]).");
  const doc = parseBuilderDocument(input.document);
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
  if (!org) throw new BadRequestError("No such organization.");

  let row;
  if (input.id) {
    const existing = await prisma.workflowBuilderDraft.findUnique({ where: { id: input.id }, select: { id: true, organizationId: true } });
    if (!existing) throw new NotFoundError();
    assertCanAuthorWorkflow(m, existing.organizationId);
    row = await prisma.workflowBuilderDraft.update({
      where: { id: input.id },
      data: { name: input.name, key: input.key, document: doc as object, facilityId: input.facilityId ?? null, workflowDefinitionId: input.workflowDefinitionId ?? undefined, updatedByUserId: m.userId },
    });
  } else {
    row = await prisma.workflowBuilderDraft.create({
      data: { organizationId: input.organizationId, facilityId: input.facilityId ?? null, workflowDefinitionId: input.workflowDefinitionId ?? null, key: input.key, name: input.name, document: doc as object, status: "DRAFT", createdByUserId: m.userId, updatedByUserId: m.userId },
    });
  }
  await recordAuditEvent("workflow.builder.draftSaved", m.userId, { draftId: row.id, key: input.key }, { organizationId: input.organizationId });
  return row;
}

export async function getDraft(m: ActorMemberships, id: string) {
  const draft = await prisma.workflowBuilderDraft.findUnique({ where: { id } });
  if (!draft) throw new NotFoundError();
  assertCanReadWorkflowScope(m, draft.organizationId);
  return draft;
}

export async function listDrafts(m: ActorMemberships, organizationId: string) {
  assertCanReadWorkflowScope(m, organizationId);
  return prisma.workflowBuilderDraft.findMany({ where: { organizationId }, orderBy: { updatedAt: "desc" }, take: 200 });
}

export async function deleteDraft(m: ActorMemberships, id: string) {
  const draft = await prisma.workflowBuilderDraft.findUnique({ where: { id }, select: { id: true, organizationId: true } });
  if (!draft) throw new NotFoundError();
  assertCanAuthorWorkflow(m, draft.organizationId);
  await prisma.workflowBuilderDraft.delete({ where: { id } });
  await recordAuditEvent("workflow.builder.draftDeleted", m.userId, { draftId: id }, { organizationId: draft.organizationId ?? undefined });
  return { deleted: true };
}

/**
 * Publish a draft: compile → canonical config → D7 lifecycle. Editing an existing
 * definition creates + publishes a NEW version; a brand-new workflow creates the
 * definition and publishes v1. The D7 validator + guarded publication remain
 * authoritative (no partial publish — each D7 step is transactional).
 */
export async function publishDraft(m: ActorMemberships, id: string) {
  const draft = await prisma.workflowBuilderDraft.findUnique({ where: { id } });
  if (!draft) throw new NotFoundError();
  assertCanAuthorWorkflow(m, draft.organizationId);
  if (!draft.organizationId) throw new BadRequestError("Draft has no organization scope.");
  const config = compileBuilderDocument(draft.document as BuilderDocument); // throws if incomplete/invalid

  let definitionId = draft.workflowDefinitionId ?? null;
  if (definitionId) {
    const version = await createVersion(m, definitionId, config);
    await publishVersion(m, definitionId, version.id);
  } else {
    const def = await createDefinition(m, { organizationId: draft.organizationId, facilityId: draft.facilityId, key: draft.key, name: draft.name, description: undefined, config });
    const v1 = def.versions.find((v) => v.version === 1);
    if (!v1) throw new BadRequestError("Publish failed: no initial version.");
    await publishVersion(m, def.id, v1.id);
    definitionId = def.id;
  }
  // Link the draft to the (now published) definition so future edits version it.
  await prisma.workflowBuilderDraft.update({ where: { id }, data: { workflowDefinitionId: definitionId } });
  return getDefinition(m, definitionId);
}

/** Import a workflow document as a DRAFT (never directly published; §30). */
export async function importWorkflow(m: ActorMemberships, input: { organizationId: string; facilityId?: string | null; name: string; key: string; document: unknown }) {
  assertCanAuthorWorkflow(m, input.organizationId);
  // Revalidate structurally on import; tenant scope is server-derived so an imported
  // document cannot inject a cross-tenant reference.
  parseBuilderDocument(input.document);
  const row = await saveDraft(m, { organizationId: input.organizationId, facilityId: input.facilityId ?? null, name: input.name, key: input.key, document: input.document });
  await recordAuditEvent("workflow.builder.imported", m.userId, { draftId: row.id, key: input.key }, { organizationId: input.organizationId });
  return row;
}

/** Export a published/draft workflow version as a portable builder document (no secrets). */
export async function exportWorkflow(m: ActorMemberships, definitionId: string, versionId?: string) {
  const def = await getDefinition(m, definitionId); // scoped read
  const vId = versionId ?? def.currentVersionId ?? def.versions[0]?.id;
  if (!vId) throw new NotFoundError();
  const version = await getVersionConfig(m, definitionId, vId);
  const config = version.config as { trigger: unknown; steps: unknown };
  const document = { name: def.name, ...(config as object) };
  await recordAuditEvent("workflow.builder.exported", m.userId, { workflowId: definitionId, versionId: vId }, { organizationId: def.organizationId ?? undefined });
  return { key: def.key, name: def.name, version: version.version, document };
}
