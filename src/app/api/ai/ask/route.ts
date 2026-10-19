import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { requirePatientContext } from "@/lib/patient/context";
import { askAi, AskError, type AskRequest } from "@/lib/rag/ask";
import { AI_MODES } from "@/lib/rag/modes";
import type { AiActor } from "@/lib/rag/access";

/**
 * Week 4b — POST /api/ai/ask (docs/RAG_DESIGN.md §8). The body names only the
 * mode, the patient and, where the mode needs one, the share, the report,
 * the appointment, the question, the period or the language; who is asking,
 * their facility and every access decision come from the session.
 *
 * Server-sent events by default: `meta` (interaction id, mode, the
 * AI-generated label, language), then `sentence` events (text, citation
 * numbers, labels), then `citations`, then `done` (the outcome). A staff
 * answer streams as each sentence passes validation; a patient answer only
 * after all of it did. `Accept: application/json` returns the same as one
 * JSON object. NO_RECORD and REFUSED_SAFETY are 200; 401, 403, 404, 413, 429
 * as elsewhere; 503 when the provider is down.
 */
const MAX_BODY = 16 * 1024;
const BODY = z.object({
  mode: z.enum(AI_MODES),
  patientId: z.string().min(1).max(64),
  shareId: z.string().min(1).max(64).optional(),
  documentId: z.string().min(1).max(64).optional(),
  appointmentId: z.string().min(1).max(64).optional(),
  question: z.string().trim().min(1).max(1000).optional(),
  period: z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).strict().optional(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
}).strict();

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AskError) return NextResponse.json({ error: err.code }, { status: err.status });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("ai.ask failed", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "Internal error." }, { status: 500 });
}

async function actorFor(): Promise<AiActor> {
  const session = await requireSession();
  if (session.role === "PATIENT") {
    const ctx = await requirePatientContext();
    return { kind: "PATIENT", userId: ctx.userId };
  }
  const { session: s, facilityId } = await requireFacilityStaff("ai:record:ask");
  return { kind: "STAFF", userId: s.userId, role: s.role, facilityId };
}

export async function POST(req: NextRequest) {
  let actor: AiActor;
  let body: AskRequest;
  try {
    actor = await actorFor();
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new BadRequestError("Body must be JSON."); }
    const parsed = BODY.safeParse(json);
    if (!parsed.success) throw new BadRequestError(`Invalid request: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
    body = parsed.data;
  } catch (err) {
    return errorResponse(err);
  }

  if ((req.headers.get("accept") ?? "").includes("application/json")) {
    try {
      return NextResponse.json(await askAi(actor, body));
    } catch (err) {
      return errorResponse(err);
    }
  }

  // Server-sent events. Access, limits and refusals are decided before the stream opens.
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  let opened: (r: NextResponse | null) => void;
  const ready = new Promise<NextResponse | null>((r) => (opened = r));
  void askAi(actor, body, {
    onMeta: (m) => { opened(null); send("meta", m); },
    onSentence: (s) => send("sentence", s),
  }).then((result) => {
    send("citations", result.citations);
    send("done", { outcome: result.outcome });
    controller.close();
  }, (err) => {
    // Before the stream opened: a plain error response. After: a closing error event.
    opened(errorResponse(err));
    try { send("done", { outcome: "ERROR", error: err instanceof AskError ? err.code : "INTERNAL" }); controller.close(); } catch { /* already closed */ }
  });
  const early = await ready;
  if (early) return early;
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
