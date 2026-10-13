import { NextResponse } from "next/server";
import { destroySession, getSession } from "@/lib/auth/session";
import { revokeAllSessions } from "@/lib/auth/authorize/sessionControl";

export async function POST() {
  // Deleting the cookie alone leaves a copied cookie valid for its full 14
  // days. Bumping tokenVersion kills it server-side too. Sessions are not
  // per-device (see sessionControl.ts), so this signs out every device.
  const session = await getSession();
  if (session) {
    await revokeAllSessions({
      userId: session.userId,
      byUserId: session.userId,
      reason: "User logged out.",
    }).catch(() => {
      // User already gone, or DB unavailable: still clear the cookie below.
    });
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
