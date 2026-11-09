import { prisma } from "@/lib/db";

/**
 * Flagship 3d — imported entries name the old system's clinician as text
 * (decided §10.3): "Recorded by: <name> (imported)". Keyed by encounter id;
 * only imported encounters with a clinician have one. (Phase 1 kept the name
 * with a " (legacy)" suffix; it is shown without it.)
 */
export async function importedRecordedBy(encounterIds: string[]): Promise<Map<string, string>> {
  if (!encounterIds.length) return new Map();
  const keys = await prisma.legacyRecordKey.findMany({ where: { kind: "ENCOUNTER", targetId: { in: encounterIds }, clinicianName: { not: null } }, select: { targetId: true, clinicianName: true } });
  return new Map(keys.map((k) => [k.targetId, `Recorded by: ${k.clinicianName!.replace(/ \(legacy\)$/, "")} (imported)`]));
}
