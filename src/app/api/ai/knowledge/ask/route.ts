import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { AskError, askKnowledge, type KnowledgeAskRequest } from "@/lib/rag/knowledgeAsk";
import type { AiActor } from "@/lib/rag/access";

/**
 * RAG Phase 3, step 3.4 — POST /api/ai/knowledge/ask: a question about the
 * hospital's approved documents in force (KNOWLEDGE_QA). The body is the
 * question and, optionally, the answer's language; who is asking, their
 * facility, organisation and access classes come from the session. No
 * patient is named, and none can be. Server-sent events like /api/ai/ask
 * (meta, sentence…, citations, done), or JSON with `Accept: application/json`.
 */
const MAX_BODY = 8 * 1024;
const BODY = z.object({ question: z.string().trim().min(1).max(1000), language: z.string().regex(/^[a-z]{2}$/).optional() }).strict();

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AskError) return NextResponse.json({ error: err.code, ...(err.detail ? { message: err.detail } : {}) }, { status: err.status });
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (err instanceof BadRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
  console.error("ai.knowledge.ask failed", err instanceof Error ? err.name : "unknown");
  return NextResponse.json({ error: "Internal error." }, { status: 500 });
}

export async function POST(req: NextRequest) {
  let actor: Extract<AiActor, { kind: "STAFF" }>;
  let body: KnowledgeAskRequest;
  try {
    const { session, facilityId } = await requireFacilityStaff("ai:knowledge:ask");
    actor = { kind: "STAFF", userId: session.userId, role: session.role, facilityId };
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
      return NextResponse.json(await askKnowledge(actor, body));
    } catch (err) {
      return errorResponse(err);
    }
  }

  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  let opened: (r: NextResponse | null) => void;
  const ready = new Promise<NextResponse | null>((r) => (opened = r));
  void askKnowledge(actor, body, {
    onMeta: (m) => { opened(null); send("meta", m); },
    onSentence: (s) => send("sentence", s),
  }).then((result) => {
    send("citations", result.citations);
    send("done", { outcome: result.outcome });
    controller.close();
  }, (err) => {
    opened(errorResponse(err));
    try { send("done", { outcome: "ERROR", error: err instanceof AskError ? err.code : "INTERNAL", ...(err instanceof AskError && err.detail ? { message: err.detail } : {}) }); controller.close(); } catch { /* already closed */ }
  });
  const early = await ready;
  if (early) return early;
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
