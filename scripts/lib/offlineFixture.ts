import { prisma } from "../../src/lib/db";
import { activeSignOff, OFFLINE_SIGN_OFF_SCOPE, setWardOfflineMode } from "../../src/lib/hospital/offline/switch";

/**
 * Flagship 4e: gates that issue packs need the ward's offline mode on, which
 * needs the clinical sign-off. A synthetic sign-off row (the verify database
 * only) if none is active, then the ward turned on by its hospital admin.
 */
export async function enableOfflineForGate(admin: { userId: string; facilityId: string }, wardId: string) {
  if (!(await activeSignOff())) {
    await prisma.clinicalSignOff.create({ data: { scope: OFFLINE_SIGN_OFF_SCOPE, advisorName: "Gate fixture (synthetic)", reference: "verify-gate", signedOffAt: new Date(), recordedByUserId: admin.userId } })
      .catch((e) => { if ((e as { code?: string }).code !== "P2002") throw e; });
  }
  await setWardOfflineMode(admin, wardId, { enabled: true, reason: "verify gate" });
}
