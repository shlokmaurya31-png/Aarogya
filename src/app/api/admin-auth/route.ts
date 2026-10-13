import { NextResponse } from "next/server";

// Retired. This compared a password to ADMIN_EMAIL/ADMIN_PASSWORD env vars
// (non-constant-time, no rate limit) and issued no session — the "admin"
// state lived in localStorage. Admins now sign in via /api/scholar-auth/login
// as an AAROGYA_ADMIN account.
export async function POST() {
  return NextResponse.json(
    { error: "This sign-in method has been retired. Use /admin/login." },
    { status: 410 }
  );
}
