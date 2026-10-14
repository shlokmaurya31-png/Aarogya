import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { roleHasPermission } from "@/lib/auth/permissions";
import { TenantAccessError, type ActorMemberships } from "@/lib/auth/tenantContext";
import { assertItemInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** Exact same .trim().toUpperCase() normalization medicationLifecycle.ts already applies for its Phase 5 pharmacy charge code — one normalization convention, not two. */
export function normalizeDrugName(drugName: string): string {
  return drugName.trim().toUpperCase();
}

/**
 * The app-level `existing` check below has the same TOCTOU gap as every
 * other "check then create" idiom in this codebase — two concurrent
 * requests linking the same drug name can both pass it before either
 * commits. MedicationItemLink's own @@unique([facilityId, drugNameKey])
 * is the real backstop; the loser hits this P2002 and gets the same clean
 * BadRequestError as the sequential duplicate case, not a raw 500 — same
 * pattern as isDuplicateCurrentResultError/isDuplicateActiveStudyError
 * elsewhere in this codebase.
 */
function isDuplicateLinkError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002");
}

/**
 * Where a link applies. Resolution is facility → organization → global.
 *   FACILITY      one facility; created by that facility's inventory manager
 *   ORGANIZATION  every facility of one organization; created by its org admin
 *   GLOBAL        every facility; created by a platform admin
 */
export type MedicationLinkTarget =
  | { scope: "FACILITY"; facilityId: string }
  | { scope: "ORGANIZATION"; organizationId: string }
  | { scope: "GLOBAL" };

/**
 * Seed and test fixtures create links without a request. They pass this
 * explicitly; a request path always passes the caller's memberships, so the
 * scope authorization below can never be skipped by accident.
 */
export const SYSTEM_ACTOR = { system: true } as const;
export type MedicationLinkActor = ActorMemberships | typeof SYSTEM_ACTOR;

/**
 * Who may create a link at each scope. A caller outside the scope's tenant
 * gets 404 (existence is not confirmed); a member without the right gets 403.
 */
export function assertCanManageLinkScope(actor: ActorMemberships, target: MedicationLinkTarget): void {
  if (target.scope === "GLOBAL") {
    if (!actor.isPlatformAdmin) throw new TenantAccessError("Global medication links can only be created by a platform administrator.");
    return;
  }
  if (target.scope === "ORGANIZATION") {
    if (!actor.orgMemberships.has(target.organizationId)) throw new NotFoundError();
    if (!actor.adminOrgIds.has(target.organizationId)) {
      throw new TenantAccessError("Organization medication links can only be created by an administrator of that organization.");
    }
    return;
  }
  const member = actor.facilityMemberships.has(target.facilityId) || actor.primaryFacilityId === target.facilityId;
  if (!member) throw new NotFoundError();
  if (!roleHasPermission(actor.role, "inventory:item:manage")) {
    throw new TenantAccessError("Facility medication links can only be created by that facility's inventory manager.");
  }
}

function scopeColumns(target: MedicationLinkTarget) {
  if (target.scope === "FACILITY") return { scope: target.scope, scopeRef: target.facilityId, facilityId: target.facilityId, organizationId: null };
  if (target.scope === "ORGANIZATION") return { scope: target.scope, scopeRef: target.organizationId, facilityId: null, organizationId: target.organizationId };
  return { scope: target.scope, scopeRef: "GLOBAL", facilityId: null, organizationId: null };
}

/**
 * Creates a drug-name → item link at `target`'s scope, after authorizing
 * `actor` for that scope. A FACILITY link may point at that facility's own
 * item or a global catalog item (assertItemInFacility). GLOBAL and
 * ORGANIZATION links are resolved by many facilities, so they may only point
 * at a global catalog item: one facility's own item must never be shown to,
 * or dispensed at, another facility. Every link change is audited in the same
 * transaction, with the scope in the detail.
 */
export async function linkMedicationToItem(
  tx: Tx,
  actor: MedicationLinkActor,
  input: { target: MedicationLinkTarget; drugName: string; itemId: string }
) {
  const { target } = input;
  if (!("system" in actor)) assertCanManageLinkScope(actor, target);

  const item =
    target.scope === "FACILITY"
      ? await assertItemInFacility(tx, input.itemId, target.facilityId)
      : await tx.item.findUnique({ where: { id: input.itemId } });
  if (!item) throw new NotFoundError("Item not found.");
  if (target.scope !== "FACILITY" && item.facilityId !== null) {
    throw new BadRequestError(`A ${target.scope.toLowerCase()} link must point at a global catalog item, not one facility's item.`);
  }
  if (!item.active) throw new BadRequestError("Cannot link a drug name to an inactive item.");
  if (item.category !== "MEDICATION") throw new BadRequestError(`Item category is ${item.category}, not MEDICATION.`);
  if (target.scope === "ORGANIZATION") {
    const org = await tx.organization.findUnique({ where: { id: target.organizationId }, select: { id: true } });
    if (!org) throw new NotFoundError();
  }

  const drugNameKey = normalizeDrugName(input.drugName);
  const columns = scopeColumns(target);
  const existing = await tx.medicationItemLink.findUnique({ where: { scopeRef_drugNameKey: { scopeRef: columns.scopeRef, drugNameKey } } });
  if (existing) throw new BadRequestError(`"${input.drugName}" is already linked to an item at this scope.`);
  let link;
  try {
    link = await tx.medicationItemLink.create({ data: { ...columns, drugNameKey, itemId: input.itemId } });
  } catch (err) {
    if (isDuplicateLinkError(err)) throw new BadRequestError(`"${input.drugName}" is already linked to an item at this scope.`);
    throw err;
  }
  await recordAuditEvent(
    "hospital.inventory.medicationLinked",
    "system" in actor ? null : actor.userId,
    { linkId: link.id, scope: target.scope, scopeRef: columns.scopeRef, drugNameKey, itemId: input.itemId },
    { facilityId: columns.facilityId ?? undefined, organizationId: columns.organizationId ?? undefined },
    tx
  );
  return link;
}

/** The scope keys a facility resolves through, most specific first. */
async function scopeChainFor(db: Db, facilityId: string): Promise<string[]> {
  const facility = await db.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  return facility ? [facilityId, facility.organizationId, "GLOBAL"] : [facilityId, "GLOBAL"];
}

/**
 * Links visible at a facility: its own, its organization's and global ones.
 * Organization and global links only ever count when they point at a global
 * catalog item (defense in depth against rows written before that rule).
 */
function visibleAt(chain: string[], facilityId: string): Prisma.MedicationItemLinkWhereInput {
  return {
    OR: [
      { scope: "FACILITY", scopeRef: facilityId },
      { scope: { in: ["ORGANIZATION", "GLOBAL"] }, scopeRef: { in: chain.slice(1) }, item: { facilityId: null } },
    ],
  };
}

export async function listMedicationLinksForFacility(db: Db, facilityId: string) {
  const chain = await scopeChainFor(db, facilityId);
  return db.medicationItemLink.findMany({
    where: visibleAt(chain, facilityId),
    include: { item: true },
    orderBy: [{ drugNameKey: "asc" }, { scope: "desc" }, { id: "asc" }],
  });
}

/** Most specific link wins: facility, then organization, then global. Returns null (not a thrown error) when unmapped — the caller (dispenseMedication) decides whether that's fatal. */
export async function resolveItemForDrugName(db: Db, facilityId: string, drugName: string) {
  const drugNameKey = normalizeDrugName(drugName);
  const chain = await scopeChainFor(db, facilityId);
  const links = await db.medicationItemLink.findMany({
    where: { drugNameKey, ...visibleAt(chain, facilityId) },
    include: { item: true },
  });
  // scopeRef + drugNameKey is unique, so there is at most one link per scope.
  for (const ref of chain) {
    const link = links.find((l) => l.scopeRef === ref);
    if (link) return link.item;
  }
  return null;
}
