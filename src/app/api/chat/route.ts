import { NextRequest, NextResponse } from "next/server";
import { requireSession, UnauthorizedError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { recordAuditEvent } from "@/lib/auth/audit";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { prisma } from "@/lib/db";
import { getAIProvider } from "@/lib/ai/getAIProvider";
import { patientAssistantContext, clinicianAssistantContext } from "@/lib/ai/assistantContext";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";

/**
 * The portal assistant ("Aarogya AI"). The record it answers from is built on
 * the server from what the caller is authorized to read. Nothing about the
 * patient comes from the client, and the audience comes from the account's
 * role, not from the request.
 *
 *   PATIENT accounts  their own record, or a delegated one (patientId), via
 *                     the patient portal's scope and data classes.
 *   Hospital staff    a general clinical assistant; with a patientId, that
 *                     one chart, only if the caller may read charts in the
 *                     patient's facility. The read is audited.
 *   Everyone else     (e.g. Scholar) a general assistant with no patient
 *                     record.
 *
 * The model is reached only through the AI provider boundary (src/lib/ai):
 * with no ANTHROPIC_API_KEY the mock provider answers honestly instead of
 * failing.
 */

// Every call can spend model credits, so the route is signed-in only and
// capped per user. Clients fall back to canned replies on any non-200.
const PER_MINUTE = 10;
const PER_DAY = 200;
const MAX_MESSAGE_CHARS = 2000;
const MAX_PAGE_CHARS = 100;
const MAX_BODY_BYTES = 64 * 1024;

const HOSPITAL_ROLES = new Set(["DOCTOR", "NURSE", "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK", "HOSPITAL_ADMIN"]);

export async function POST(req: NextRequest) {
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Sign in to use the assistant." }, { status: 401 });
    }
    throw err;
  }
  const userId = session.userId;

  for (const [scope, limit, windowMs] of [
    ["min", PER_MINUTE, 60_000],
    ["day", PER_DAY, 86_400_000],
  ] as const) {
    const rl = await rateLimit(`chat:${scope}:${userId}`, limit, windowMs);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many assistant requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }
  let body: { message?: unknown; page?: unknown; patientId?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const { message } = body;
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: `Message exceeds ${MAX_MESSAGE_CHARS} characters.` }, { status: 400 });
  }
  const page = typeof body.page === "string" ? body.page.slice(0, MAX_PAGE_CHARS) : undefined;
  const patientId = typeof body.patientId === "string" && body.patientId ? body.patientId : null;

  let audience: "patient" | "clinician";
  let context: string;
  try {
    if (session.role === "PATIENT") {
      audience = "patient";
      const scope = await resolveReadScope(await requirePatientContext(), patientId);
      context = await patientAssistantContext(scope);
    } else if (HOSPITAL_ROLES.has(session.role) && patientId) {
      audience = "clinician";
      const { facilityId } = await requireFacilityStaff("clinical:chart:read");
      const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { facilityId: true } });
      if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
      context = await clinicianAssistantContext(patientId, facilityId);
      await recordAuditEvent("hospital.patient.viewed", userId, { patientId, view: "ai-assistant" }, { facilityId, patientId });
    } else {
      // Scholar and staff without an open chart: no patient record at all.
      audience = "clinician";
      context = "No patient chart is open.";
    }
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    // Other 4xx domain errors (e.g. a suspended tenant's 403) keep their status.
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status });
    }
    throw err;
  }

  try {
    const text = await getAIProvider().assistantReply({ audience, context, page, message });
    return NextResponse.json({ text });
  } catch (err) {
    console.error("AI provider error:", err);
    return NextResponse.json({ error: "AI request failed." }, { status: 502 });
  }
}
