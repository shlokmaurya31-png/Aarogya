import { NextRequest, NextResponse } from "next/server";
import { requireSession, UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { AskError } from "@/lib/rag/ask";
import { chatAboutRecord, chatGeneral, CHAT_LIMITS, type ChatActor } from "@/lib/rag/assistant";

/**
 * POST /api/chat — the portal assistant ("Aarogya AI").
 *
 * RAG Phase 1: this route no longer builds a record and no longer reaches a
 * provider itself. Everything goes through the assistant gateway
 * (src/lib/rag/assistant.ts), which applies the same checks as /api/ai/ask:
 *
 *   Hospital staff naming a patient   the record gateway (CHART_QA): access
 *                                     resolver, real-data switch, AI consent,
 *                                     masked sources, cited and validated
 *                                     sentences, the interaction log.
 *   Everyone else                     a record-free reply: no patient record
 *                                     is given to the model. A patient asks
 *                                     about their record through Explain, the
 *                                     timeline and pre-visit questions.
 *
 * Nothing about the caller comes from the request: the role, the facility
 * and every access decision come from the session. The response is
 * { text, outcome, label, interactionId, citations }; { error } otherwise
 * (400, 401, 403, 404, 413, 429, 503).
 */
const MAX_BODY_BYTES = 64 * 1024;
const HOSPITAL_ROLES = new Set(["DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK", "HOSPITAL_ADMIN", "PROCUREMENT_OFFICER", "MEDICAL_SUPERINTENDENT", "QUALITY_LEAD"]);

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AskError) return NextResponse.json({ error: err.code }, { status: err.status });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Sign in to use the assistant." }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
  // Other 4xx domain errors (e.g. a suspended tenant's 403) keep their status.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status });
  console.error("chat failed", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "Internal error." }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    let body: { message?: unknown; page?: unknown; patientId?: unknown };
    try { body = JSON.parse(raw); } catch { throw new BadRequestError("Invalid JSON."); }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new BadRequestError("Missing 'message' string.");
    if (message.length > CHAT_LIMITS.messageChars) throw new BadRequestError(`Message exceeds ${CHAT_LIMITS.messageChars} characters.`);
    const page = typeof body.page === "string" ? body.page.slice(0, CHAT_LIMITS.pageChars) : undefined;
    const patientId = typeof body.patientId === "string" && body.patientId ? body.patientId.slice(0, 64) : null;

    if (HOSPITAL_ROLES.has(session.role)) {
      if (patientId) {
        // A record question: only for roles that may ask the record AI, and only through its gateway.
        const { session: s, facilityId } = await requireFacilityStaff("ai:record:ask");
        return NextResponse.json(await chatAboutRecord({ kind: "STAFF", userId: s.userId, role: s.role, facilityId }, { patientId, message }));
      }
      const { session: s, facilityId } = await requireFacilityStaff("clinical:chart:read");
      return NextResponse.json(await chatGeneral({ kind: "STAFF", userId: s.userId, role: s.role, facilityId }, { message, page }));
    }
    // A patient's `patientId` (a delegated record) is ignored: the assistant is record-free for patients.
    const actor: ChatActor = session.role === "PATIENT" ? { kind: "PATIENT", userId: session.userId } : { kind: "OTHER", userId: session.userId, role: session.role };
    return NextResponse.json(await chatGeneral(actor, { message, page }));
  } catch (err) {
    return errorResponse(err);
  }
}
