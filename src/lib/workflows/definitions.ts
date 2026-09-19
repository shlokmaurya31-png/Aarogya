import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { assertCanAuthorWorkflow, assertCanReadWorkflowScope } from "./authz";
import { validateWorkflowConfig } from "./validator";

/**
 * Phase D7 — workflow definition & version management (§4, §29).
 *
 * Authoring is PLATFORM-only. Every published version is validated first and is
 * immutable thereafter — a change creates a NEW version, and historical instances
 * keep referencing the version that created them. Publication is race-safe: a
 * guarded status transition means two concurrent publishes of the same version
 * cannot both win, and a definition has at most one PUBLISHED version.
 */

export interface CreateDefinitionInput {
  organizationId?: string | null;
  facilityId?: string | null;
  key: string;
  name: string;
  description?: string;
  config: unknown;
}

export async function createDefinition(m: ActorMemberships, input: CreateDefinitionInput) {
  assertCanAuthorWorkflow(m, input.organizationId ?? null);
  const cfg = validateWorkflowConfig(input.config);
  const organizationId = input.organizationId ?? null;
  if (organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw new BadRequestError("No such organization.");
  }
  const existing = await prisma.workflowDefinition.findFirst({ where: { organizationId, key: input.key }, select: { id: true } });
  if (existing) throw new ConflictError(`A workflow with key "${input.key}" already exists in this scope.`);

  const def = await prisma.$transaction(async (tx) => {
    const d = await tx.workflowDefinition.create({
      data: {
        organizationId, facilityId: input.facilityId ?? null, key: input.key, name: input.name, description: input.description,
        triggerEventType: cfg.trigger.eventType, triggerEventVersion: cfg.trigger.eventVersion,
        status: "ACTIVE", createdByUserId: m.userId, updatedByUserId: m.userId,
      },
    });
    await tx.workflowVersion.create({ data: { workflowDefinitionId: d.id, version: 1, status: "DRAFT", config: cfg as unknown as Prisma.InputJsonValue, createdByUserId: m.userId } });
    await recordAuditEvent("workflow.definition.created", m.userId, { workflowId: d.id, key: d.key }, { organizationId: organizationId ?? undefined }, tx);
    await recordAuditEvent("workflow.version.created", m.userId, { workflowId: d.id, version: 1 }, { organizationId: organizationId ?? undefined }, tx);
    return d;
  });
  return getDefinition(m, def.id);
}

/** Create a new DRAFT version of an existing definition. */
export async function createVersion(m: ActorMemberships, definitionId: string, config: unknown) {
  const cfg = validateWorkflowConfig(config);
  const def = await prisma.workflowDefinition.findUnique({ where: { id: definitionId }, select: { id: true, organizationId: true } });
  if (!def) throw new NotFoundError();
  assertCanAuthorWorkflow(m, def.organizationId);
  const latest = await prisma.workflowVersion.findFirst({ where: { workflowDefinitionId: definitionId }, orderBy: { version: "desc" }, select: { version: true } });
  const nextVersion = (latest?.version ?? 0) + 1;
  const version = await prisma.$transaction(async (tx) => {
    const v = await tx.workflowVersion.create({ data: { workflowDefinitionId: definitionId, version: nextVersion, status: "DRAFT", config: cfg as unknown as Prisma.InputJsonValue, createdByUserId: m.userId } });
    await recordAuditEvent("workflow.version.created", m.userId, { workflowId: definitionId, version: nextVersion }, { organizationId: def.organizationId ?? undefined }, tx);
    return v;
  });
  return version;
}

/**
 * Publish a DRAFT version. Race-safe: the guarded DRAFT→PUBLISHED transition means
 * only one concurrent publish wins; any previously-published version is retired and
 * the definition's denormalized trigger + currentVersionId are updated atomically.
 */
export async function publishVersion(m: ActorMemberships, definitionId: string, versionId: string) {
  // Authorize by the definition's scope FIRST (before touching the versionId), so an
  // unauthorized caller is denied regardless of whether the versionId is valid.
  const def = await prisma.workflowDefinition.findUnique({ where: { id: definitionId }, select: { organizationId: true } });
  if (!def) throw new NotFoundError();
  assertCanAuthorWorkflow(m, def.organizationId);
  const version = await prisma.workflowVersion.findUnique({ where: { id: versionId } });
  if (!version || version.workflowDefinitionId !== definitionId) throw new NotFoundError();
  if (version.status !== "DRAFT") throw new BadRequestError(`Only a DRAFT version can be published (is ${version.status}).`);
  const cfg = validateWorkflowConfig(version.config); // re-validate immutable payload before it becomes active
  await prisma.$transaction(async (tx) => {
    const promoted = await tx.workflowVersion.updateMany({ where: { id: versionId, status: "DRAFT" }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    if (promoted.count !== 1) throw new ConflictError("Version was published concurrently.");
    await tx.workflowVersion.updateMany({ where: { workflowDefinitionId: definitionId, status: "PUBLISHED", id: { not: versionId } }, data: { status: "RETIRED", retiredAt: new Date() } });
    await tx.workflowDefinition.update({ where: { id: definitionId }, data: { currentVersionId: versionId, triggerEventType: cfg.trigger.eventType, triggerEventVersion: cfg.trigger.eventVersion, status: "ACTIVE", updatedByUserId: m.userId } });
    await recordAuditEvent("workflow.published", m.userId, { workflowId: definitionId, versionId, version: version.version }, { organizationId: def.organizationId ?? undefined }, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
  return getDefinition(m, definitionId);
}

/** Retire the whole definition: no new instances will be triggered from it. */
export async function retireDefinition(m: ActorMemberships, definitionId: string) {
  const def = await prisma.workflowDefinition.findUnique({ where: { id: definitionId }, select: { id: true, organizationId: true } });
  if (!def) throw new NotFoundError();
  assertCanAuthorWorkflow(m, def.organizationId);
  await prisma.$transaction(async (tx) => {
    await tx.workflowDefinition.update({ where: { id: definitionId }, data: { status: "INACTIVE", currentVersionId: null, updatedByUserId: m.userId } });
    await tx.workflowVersion.updateMany({ where: { workflowDefinitionId: definitionId, status: "PUBLISHED" }, data: { status: "RETIRED", retiredAt: new Date() } });
    await recordAuditEvent("workflow.retired", m.userId, { workflowId: definitionId }, { organizationId: def.organizationId ?? undefined }, tx);
  });
  return getDefinition(m, definitionId);
}

export async function getDefinition(m: ActorMemberships, definitionId: string) {
  const def = await prisma.workflowDefinition.findUnique({
    where: { id: definitionId },
    include: { versions: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, publishedAt: true, retiredAt: true, createdAt: true } } },
  });
  if (!def) throw new NotFoundError();
  assertCanReadWorkflowScope(m, def.organizationId);
  return def;
}

export async function getVersionConfig(m: ActorMemberships, definitionId: string, versionId: string) {
  const def = await prisma.workflowDefinition.findUnique({ where: { id: definitionId }, select: { organizationId: true } });
  if (!def) throw new NotFoundError();
  assertCanReadWorkflowScope(m, def.organizationId);
  const v = await prisma.workflowVersion.findUnique({ where: { id: versionId } });
  if (!v || v.workflowDefinitionId !== definitionId) throw new NotFoundError();
  return v;
}

/** Platform sees all; an org admin sees global templates + their own org's definitions. */
export async function listDefinitions(m: ActorMemberships, opts?: { organizationId?: string; triggerEventType?: string; limit?: number }) {
  const where: Prisma.WorkflowDefinitionWhereInput = {};
  if (opts?.triggerEventType) where.triggerEventType = opts.triggerEventType;
  if (m.isPlatformAdmin) {
    if (opts?.organizationId) where.organizationId = opts.organizationId;
  } else {
    const ownOrgIds = [...m.orgMemberships.keys()];
    where.OR = [{ organizationId: null }, { organizationId: { in: ownOrgIds } }];
  }
  return prisma.workflowDefinition.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(opts?.limit ?? 100, 500) });
}
