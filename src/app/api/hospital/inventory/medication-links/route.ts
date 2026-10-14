import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, requireSession } from "@/lib/auth/rbac";
import { loadActorMemberships } from "@/lib/auth/tenantContext";
import { prisma } from "@/lib/db";
import { linkMedicationToItem, listMedicationLinksForFacility, type MedicationLinkTarget } from "@/lib/hospital/inventory/itemMedicationLink";

/**
 * Real write path for MedicationItemLink (brief P0-A) — without this route,
 * dispenseMedication has no way to resolve a drug name to a stock item
 * short of direct database access. GET lists the links a facility resolves
 * through (its own, its organization's, global), in resolveItemForDrugName's
 * order.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:item:view", searchParams.get("facilityId") ?? undefined);
    const links = await listMedicationLinksForFacility(prisma, facilityId);
    return { links };
  });
}

/**
 * Body: { drugName, itemId, scope?: "FACILITY" | "ORGANIZATION" | "GLOBAL",
 * facilityId?, organizationId? }. `global: true` is accepted as scope GLOBAL.
 * The service authorizes the scope (facility inventory manager / org admin /
 * platform admin) and audits the change.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const session = await requireSession();
    const actor = await loadActorMemberships(session.userId, session.role);

    const { drugName, itemId } = body ?? {};
    if (!drugName || typeof drugName !== "string") throw new BadRequestError("drugName is required.");
    if (!itemId || typeof itemId !== "string") throw new BadRequestError("itemId is required.");

    const scope = body?.global === true ? "GLOBAL" : (body?.scope ?? "FACILITY");
    let target: MedicationLinkTarget;
    if (scope === "GLOBAL") target = { scope };
    else if (scope === "ORGANIZATION") {
      if (typeof body?.organizationId !== "string") throw new BadRequestError("organizationId is required for an ORGANIZATION link.");
      target = { scope, organizationId: body.organizationId };
    } else if (scope === "FACILITY") {
      const facilityId = typeof body?.facilityId === "string" ? body.facilityId : actor.primaryFacilityId;
      if (!facilityId) throw new BadRequestError("facilityId is required for a FACILITY link.");
      target = { scope, facilityId };
    } else throw new BadRequestError("scope must be FACILITY, ORGANIZATION or GLOBAL.");

    const link = await prisma.$transaction((tx) => linkMedicationToItem(tx, actor, { target, drugName, itemId }));
    return { link };
  });
}
