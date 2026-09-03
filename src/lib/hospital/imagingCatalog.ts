import { prisma } from "@/lib/db";

/** Facility-scoped + global (facilityId: null) catalog/resource lookups (brief §4, §8). No abnormal-flag/reference-range equivalent — imaging has no numeric ranges. */
export async function listImagingCatalog(facilityId: string) {
  return prisma.imagingCatalog.findMany({
    where: { active: true, OR: [{ facilityId }, { facilityId: null }] },
    orderBy: { name: "asc" },
  });
}

export async function listImagingResources(facilityId: string) {
  return prisma.imagingResource.findMany({
    where: { facilityId, active: true },
    orderBy: { name: "asc" },
  });
}
