import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";
import { buildHome } from "@/lib/patient/experience/home";

/** Patient home dashboard — self by default, or a delegated patient via ?patientId. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    const patient = await prisma.patient.findUnique({ where: { id: scope.patientId }, select: { preferredName: true, fullName: true } });
    return buildHome(scope, patient?.preferredName || patient?.fullName || "there");
  });
}
