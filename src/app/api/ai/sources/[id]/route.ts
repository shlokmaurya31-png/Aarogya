import { NextRequest, NextResponse } from "next/server";
import { requireSession, UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { requirePatientContext } from "@/lib/patient/context";
import { AskError } from "@/lib/rag/ask";
import { openSource } from "@/lib/rag/sourceOpen";
import type { AiActor } from "@/lib/rag/access";

/**
 * RAG Phase 5, step 5.8 — GET /api/ai/sources/:id: one cited source of an AI
 * answer (the AiInteractionSource id), opened only for a caller who may read
 * it now (src/lib/rag/sourceOpen.ts); 404 for everyone else, the same as for
 * an id that doesn't exist. Who asks comes from the session. Never cached.
 */
const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AskError) return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401, headers: NO_STORE });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403, headers: NO_STORE });
  if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400, headers: NO_STORE });
  console.error("ai.sources failed", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "Internal error." }, { status: 500, headers: NO_STORE });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AskError(404, "NOT_FOUND");
    const session = await requireSession();
    let actor: AiActor;
    if (session.role === "PATIENT") actor = { kind: "PATIENT", userId: (await requirePatientContext()).userId };
    else {
      const { session: s, facilityId } = await requireFacilityStaff("ai:knowledge:ask");
      actor = { kind: "STAFF", userId: s.userId, role: s.role, facilityId };
    }
    return NextResponse.json(await openSource(actor, id), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
