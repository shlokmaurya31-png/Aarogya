import { prisma } from "@/lib/db";
import { ownedPersonId } from "./access";

/**
 * Phase 0 — who is "the patient themselves". A login is the patient for a
 * facility record only through its Person's ACTIVE, verified link to that
 * record (never Patient.userId, which is retired and no longer written). A
 * merged (superseded) record is not presented as live.
 */
export async function selfPatientIds(userId: string): Promise<string[]> {
  const personId = await ownedPersonId(userId);
  if (!personId) return [];
  const links = await prisma.personPatientLink.findMany({
    where: { personId, status: "ACTIVE" },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
    select: { patientId: true, patient: { select: { mergedIntoId: true } } },
  });
  return links.filter((l) => !l.patient.mergedIntoId).map((l) => l.patientId);
}

/** Is this login the patient for this facility record (an ACTIVE link)? */
export async function isPatientSelf(userId: string | null | undefined, patientId: string): Promise<boolean> {
  if (!userId) return false;
  return (await selfPatientIds(userId)).includes(patientId);
}
