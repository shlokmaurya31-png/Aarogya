import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { cardForEdit, removeCard, updateCard } from "@/lib/insurance/cards";

type P = { params: Promise<{ id: string }> };
const member = (req: NextRequest) => req.nextUrl.searchParams.get("memberPersonId") ?? undefined;

/** GET — the card's own edit screen (full numbers, the member or their INSURANCE proxy only). */
export async function GET(req: NextRequest, { params }: P) {
  return withApiErrors(async () => cardForEdit({ userId: (await patientSession()).userId, memberPersonId: member(req) }, (await params).id));
}

/** PATCH { version, …fields } */
export async function PATCH(req: NextRequest, { params }: P) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return updateCard({ userId: s.userId, memberPersonId: member(req) }, (await params).id, body);
  });
}

export async function DELETE(req: NextRequest, { params }: P) {
  return withApiErrors(async () => removeCard({ userId: (await patientSession()).userId, memberPersonId: member(req) }, (await params).id));
}
