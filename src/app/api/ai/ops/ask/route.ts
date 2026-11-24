import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { AskError } from "@/lib/rag/ask";
import { askOps } from "@/lib/rag/opsAsk";

/**
 * RAG Phase 5, step 5.6 — POST /api/ai/ops/ask: a question about the
 * hospital's live state (OPS_QA: beds, queues, stock, unacknowledged critical
 * results), answered at Tier 0 from the services' own tables for the
 * caller's facility, every answer stating when it was read. Who asks and
 * their facility come from the session (the staff AI permission); each
 * reader then needs its own screen's permission (src/lib/rag/opsAsk.ts).
 * JSON only: the answer is a few templated sentences.
 */
const MAX_BODY = 4 * 1024;
const BODY = z.object({ question: z.string().trim().min(1).max(600) }).strict();

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AskError) return NextResponse.json({ error: err.code, ...(err.detail ? { message: err.detail } : {}) }, { status: err.status });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("ai.ops.ask failed", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "Internal error." }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const { session, facilityId } = await requireFacilityStaff("ai:knowledge:ask");
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new BadRequestError("Body must be JSON."); }
    const parsed = BODY.safeParse(json);
    if (!parsed.success) throw new BadRequestError("Invalid request: question");
    return NextResponse.json(await askOps({ kind: "STAFF", userId: session.userId, role: session.role, facilityId }, parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
