import type { Prisma, LocationType } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export async function createStockLocation(
  tx: Tx,
  input: { facilityId: string; name: string; type: LocationType; parentLocationId?: string }
) {
  const existing = await tx.stockLocation.findUnique({ where: { facilityId_name: { facilityId: input.facilityId, name: input.name } } });
  if (existing) throw new BadRequestError(`Location "${input.name}" already exists at this facility.`);
  if (input.parentLocationId) {
    const parent = await tx.stockLocation.findUniqueOrThrow({ where: { id: input.parentLocationId } });
    if (parent.facilityId !== input.facilityId) throw new BadRequestError("Parent location must be in the same facility.");
  }
  return tx.stockLocation.create({ data: input });
}

export async function updateStockLocation(tx: Tx, id: string, input: Partial<{ name: string; type: LocationType; active: boolean; parentLocationId: string | null }>) {
  await tx.stockLocation.findUniqueOrThrow({ where: { id } });
  return tx.stockLocation.update({ where: { id }, data: input });
}

export async function listLocations(tx: Tx, facilityId: string, opts: { active?: boolean } = {}) {
  return tx.stockLocation.findMany({ where: { facilityId, active: opts.active }, orderBy: { name: "asc" } });
}

/** Walks the parent chain for display (Facility > Store > Bin) — bounded to avoid an accidental cycle looping forever. */
export async function getLocationPath(tx: Tx, locationId: string): Promise<string[]> {
  const path: string[] = [];
  let current = await tx.stockLocation.findUnique({ where: { id: locationId } });
  let depth = 0;
  while (current && depth < 10) {
    path.unshift(current.name);
    current = current.parentLocationId ? await tx.stockLocation.findUnique({ where: { id: current.parentLocationId } }) : null;
    depth += 1;
  }
  return path;
}
