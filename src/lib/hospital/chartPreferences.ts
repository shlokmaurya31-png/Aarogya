import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Flagship 4b — "show imported" (docs/LEGACY_IMPORT_DESIGN.md §11.4): whether
 * the chart's timeline includes results imported from the hospital's previous
 * system. Off by default, remembered per user (User.showImportedResults), and
 * only ever a display choice: imported results never enter verification,
 * critical alerts or released reports, whatever it is set to.
 */
export async function chartPreferences(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { showImportedResults: true } });
  return { showImportedResults: u?.showImportedResults ?? false };
}

export async function setShowImportedResults(staff: { userId: string; facilityId: string }, body: { showImportedResults?: unknown }) {
  if (typeof body.showImportedResults !== "boolean") throw new BadRequestError("showImportedResults must be true or false.");
  const show = body.showImportedResults;
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.updateMany({ where: { id: staff.userId, showImportedResults: !show }, data: { showImportedResults: show } });
    // Unchanged: nothing happened, so no event.
    if (u.count === 1) {
      await emitFacilityEvent(tx, {
        type: "ChartPreferenceChanged", aggregateId: staff.userId, facilityId: staff.facilityId, actorUserId: staff.userId,
        payload: { userId: staff.userId, showImportedResults: show },
      });
    }
    return { showImportedResults: show };
  });
}
