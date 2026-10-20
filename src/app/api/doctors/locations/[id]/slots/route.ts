import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { locationSlots } from "@/lib/doctors/directory";

/** GET ?date=YYYY-MM-DD — a location's free slots that day, from the booking engine, live (Week 5a). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const date = req.nextUrl.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError("date must be YYYY-MM-DD.");
    return { slots: await locationSlots((await params).id, new Date(`${date}T12:00:00`)) };
  });
}
