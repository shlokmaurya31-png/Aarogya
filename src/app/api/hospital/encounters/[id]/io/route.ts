import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Intake/output documentation (brief §14) — GET returns raw records plus a shift/day summary computed at read time (sum by ioType/category), never stored. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const sinceParam = searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 24 * 3_600_000);

    const records = await prisma.intakeOutputRecord.findMany({
      where: { encounterId: id, recordedAt: { gte: since } },
      orderBy: { recordedAt: "desc" },
    });

    const totals: Record<string, number> = {};
    for (const r of records) {
      const key = `${r.ioType}:${r.category}`;
      totals[key] = (totals[key] ?? 0) + r.quantityMl;
    }
    const totalInput = records.filter((r) => r.ioType === "INPUT").reduce((s, r) => s + r.quantityMl, 0);
    const totalOutput = records.filter((r) => r.ioType === "OUTPUT").reduce((s, r) => s + r.quantityMl, 0);

    return { records, summary: { since: since.toISOString(), totals, totalInput, totalOutput, balance: totalInput - totalOutput } };
  });
}

const IOSchema = z.object({
  ioType: z.enum(["INPUT", "OUTPUT"]),
  category: z.string().min(1),
  quantityMl: z.coerce.number().min(0),
  notes: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("io:record", body?.facilityId);
    const parsed = IOSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid intake/output data.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const record = await prisma.intakeOutputRecord.create({
      data: {
        encounterId: id,
        facilityId,
        ioType: parsed.data.ioType,
        category: parsed.data.category,
        quantityMl: parsed.data.quantityMl,
        recordedByStaffId: staff?.id ?? session.userId,
        notes: parsed.data.notes,
      },
    });
    await recordAuditEvent("hospital.vital.recorded", session.userId, { encounterId: id, ioRecordId: record.id, ioType: record.ioType });
    return { record };
  });
}
