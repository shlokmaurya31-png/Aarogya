import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { getCommandCenterSection, BASE_PERMISSION, ALL_SECTIONS, type SectionKey } from "@/lib/hospital-os/command-center";

/** GET: a single Command Center section (authorized + tenant-scoped). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  return withApiErrors(async () => {
    const { key } = await params;
    if (!(ALL_SECTIONS as readonly string[]).includes(key)) throw new BadRequestError("Unknown section.");
    const sp = new URL(req.url).searchParams;
    const fctx = await requireFacilityStaff(BASE_PERMISSION, sp.get("facilityId") ?? undefined);
    return getCommandCenterSection(fctx, key as SectionKey, {
      window: sp.get("window"), from: sp.get("from"), to: sp.get("to"), departmentId: sp.get("departmentId"),
    });
  });
}
