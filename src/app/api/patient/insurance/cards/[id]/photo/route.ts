import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { cardPhotoUrl, setCardPhoto } from "@/lib/insurance/cards";

type P = { params: Promise<{ id: string }> };
const member = (req: NextRequest) => req.nextUrl.searchParams.get("memberPersonId") ?? undefined;

/** GET ?side=FRONT|BACK — a 5-minute URL for the photo. */
export async function GET(req: NextRequest, { params }: P) {
  return withApiErrors(async () => {
    const side = req.nextUrl.searchParams.get("side") === "BACK" ? "BACK" : "FRONT";
    return cardPhotoUrl({ userId: (await patientSession()).userId, memberPersonId: member(req) }, (await params).id, side);
  });
}

/** POST multipart (file, side) — a photo of the card; re-encoded, no metadata kept. */
export async function POST(req: NextRequest, { params }: P) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) throw new BadRequestError("Attach a photo.");
    const f = file as File;
    return setCardPhoto({ userId: s.userId, memberPersonId: member(req) }, (await params).id, form?.get("side"), { bytes: Buffer.from(await f.arrayBuffer()), contentType: f.type });
  });
}
