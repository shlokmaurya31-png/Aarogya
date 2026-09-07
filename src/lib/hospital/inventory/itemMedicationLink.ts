import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
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
 * `facilityId` here is the caller's OWN facility (server-derived by the
 * route via requireFacilityStaff, never client-trusted) — it is the scope
 * the new link is created at (or the global scope, if input.facilityId is
 * explicitly null), NOT necessarily the item's facilityId. assertItemInFacility
 * separately proves itemId actually belongs to that same facility (or is a
 * global item), closing the same class of IDOR gap Phase 6A's own
 * facilityScope.ts was built to close for every other inventory mutation.
 */
export async function linkMedicationToItem(
  tx: Tx,
  input: { facilityId: string; global?: boolean; drugName: string; itemId: string }
) {
  const linkFacilityId = input.global ? null : input.facilityId;
  const item = await assertItemInFacility(tx, input.itemId, input.facilityId);
  if (!item.active) throw new BadRequestError("Cannot link a drug name to an inactive item.");
  if (item.category !== "MEDICATION") throw new BadRequestError(`Item category is ${item.category}, not MEDICATION.`);

  const drugNameKey = normalizeDrugName(input.drugName);
  const existing = await tx.medicationItemLink.findFirst({ where: { facilityId: linkFacilityId, drugNameKey } });
  if (existing) throw new BadRequestError(`"${input.drugName}" is already linked to an item at this scope.`);
  try {
    return await tx.medicationItemLink.create({ data: { facilityId: linkFacilityId, drugNameKey, itemId: input.itemId } });
  } catch (err) {
    if (isDuplicateLinkError(err)) throw new BadRequestError(`"${input.drugName}" is already linked to an item at this scope.`);
    throw err;
  }
}

/** Facility-scoped link takes precedence over a global (facilityId=null) one. Returns null (not a thrown error) when unmapped — the caller (dispenseMedication) decides whether that's fatal. */
export async function resolveItemForDrugName(db: Db, facilityId: string, drugName: string) {
  const drugNameKey = normalizeDrugName(drugName);
  const facilityLink = await db.medicationItemLink.findFirst({ where: { facilityId, drugNameKey }, include: { item: true } });
  if (facilityLink) return facilityLink.item;
  const globalLink = await db.medicationItemLink.findFirst({ where: { facilityId: null, drugNameKey }, include: { item: true } });
  return globalLink?.item ?? null;
}
