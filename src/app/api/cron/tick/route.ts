import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runTick } from "@/lib/runner/tick";

/**
 * POST /api/cron/tick — one bounded unit of background work (workflow spine §3.1).
 *
 * Trigger-agnostic: staging calls it every minute from Supabase pg_cron +
 * pg_net, production can use Vercel Pro cron, and anything else holding the
 * secret may call it. Authenticated by `Authorization: Bearer <CRON_SECRET>`
 * (constant-time compare), never by a user session. Refused with 503 when
 * CRON_SECRET is unset, so an unconfigured deployment can't be driven.
 * Overlapping calls are safe (SKIP LOCKED claims, idempotent consumers).
 */
export const maxDuration = 60;

function authorized(req: NextRequest, secret: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: "Cron is not configured." }, { status: 503 });
  }
  if (!authorized(req, secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await runTick({ budgetMs: 50_000 });
    return NextResponse.json({ ok: true, ...result, events: result.events, workflows: result.workflows });
  } catch {
    return NextResponse.json({ error: "Tick failed." }, { status: 500 });
  }
}
