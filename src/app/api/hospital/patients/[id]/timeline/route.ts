import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { decodeTimelineCursor, timelinePage, timelineSummary } from "@/lib/patient/timeline";
import { recordAuditEvent } from "@/lib/auth/audit";
import { noteStaffChartRead } from "@/lib/doctors/self";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    // 5b follow-up: reading one's own chart as staff is allowed, recorded as SELF_ACCESS (src/lib/doctors/self.ts).
    await noteStaffChartRead({ userId: session.userId, facilityId }, patient.id, "TIMELINE");

    // Flagship 2d: a page at a time, newest first; the summary header with the first page only.
    const viewer = { kind: "STAFF" as const, facilityId };
    const cursor = searchParams.get("cursor");
    if (cursor && !decodeTimelineCursor(cursor)) throw new BadRequestError("Invalid cursor.");
    const limit = searchParams.get("limit");
    const [page, summary] = await Promise.all([
      timelinePage(id, viewer, { cursor, limit: limit ? Number(limit) || undefined : undefined }),
      cursor ? null : timelineSummary(id, viewer),
    ]);

    // Record-access logging (brief §29) — metadata only, never the payload itself.
    await recordAuditEvent(
      "hospital.patient.viewed",
      session.userId,
      { patientId: id, view: "timeline" },
      { facilityId, patientId: id }
    );

    return { timeline: page.entries, nextCursor: page.nextCursor, ...(summary ? { summary } : {}) };
  });
}
