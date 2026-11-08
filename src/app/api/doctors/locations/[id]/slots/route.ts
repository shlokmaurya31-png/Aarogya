import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { locationSlots } from "@/lib/doctors/directory";
import { parseDayKey } from "@/lib/time/zone";

/** GET ?date=YYYY-MM-DD — a location's free slots that day (the facility's day, in its time zone), from the booking engine, live (Week 5a). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const date = parseDayKey(req.nextUrl.searchParams.get("date"));
    if (!date) throw new BadRequestError("date must be YYYY-MM-DD.");
    return { slots: await locationSlots((await params).id, date) };
  });
}
