import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** Exact same .trim().toUpperCase() normalization medicationLifecycle.ts already applies for its Phase 5 pharmacy charge code — one normalization convention, not two. */
export function normalizeDrugName(drugName: string): string {
  return drugName.trim().toUpperCase();
}

export async function linkMedicationToItem(tx: Tx, input: { facilityId?: string | null; drugName: string; itemId: string }) {
  const drugNameKey = normalizeDrugName(input.drugName);
  const existing = await tx.medicationItemLink.findFirst({ where: { facilityId: input.facilityId ?? null, drugNameKey } });
  if (existing) throw new BadRequestError(`"${input.drugName}" is already linked to an item at this scope.`);
  return tx.medicationItemLink.create({ data: { facilityId: input.facilityId ?? null, drugNameKey, itemId: input.itemId } });
}

/** Facility-scoped link takes precedence over a global (facilityId=null) one. Returns null (not a thrown error) when unmapped — the caller (dispenseMedication) decides whether that's fatal. */
export async function resolveItemForDrugName(db: Db, facilityId: string, drugName: string) {
  const drugNameKey = normalizeDrugName(drugName);
  const facilityLink = await db.medicationItemLink.findFirst({ where: { facilityId, drugNameKey }, include: { item: true } });
  if (facilityLink) return facilityLink.item;
  const globalLink = await db.medicationItemLink.findFirst({ where: { facilityId: null, drugNameKey }, include: { item: true } });
  return globalLink?.item ?? null;
}
