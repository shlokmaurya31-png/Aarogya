import { z } from "zod";
import { assertNoSensitiveData } from "@/lib/events/sensitiveGuard";
import { LIMITS } from "@/lib/workflows";
import { BadRequestError } from "@/lib/auth/rbac";

/**
 * Phase D9 — the builder DOCUMENT: a lenient superset of the canonical D7
 * WorkflowConfig plus canvas/layout metadata. It is deliberately permissive so an
 * INCOMPLETE draft can be saved (no trigger yet, missing steps, etc.). All strict
 * validation happens on COMPILE (compile.ts → D7 validator); this schema only
 * enforces coarse structure + safety bounds so a draft can never be a vector for
 * oversized/secret/PHI payloads. UI validation is advisory; this is server-side.
 */

/** Serialized-size ceiling for a whole builder document (canvas-safety, §16/§43). */
export const MAX_DOCUMENT_BYTES = 64 * 1024;

// A node's canvas position (builder-only metadata, stripped on compile).
const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

/**
 * Lenient document schema. `trigger` and `steps` mirror the canonical shapes but are
 * optional and loosely typed here — compile.ts re-parses them with the strict D7
 * schema. Unknown top-level keys are stripped.
 */
export const BuilderDocumentSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    trigger: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).max(LIMITS.MAX_STEPS).optional(),
    layout: z.record(z.string(), positionSchema).optional(),
  })
  .strip();

export type BuilderDocument = z.infer<typeof BuilderDocumentSchema>;

/**
 * Parse + bound + sanitize a raw builder document. Rejects oversized documents and
 * (via the D6 sensitive guard, at any depth) any secret/credential key or blob-length
 * string — workflow definitions carry configuration, never PHI or secrets (§29).
 */
export function parseBuilderDocument(raw: unknown): BuilderDocument {
  const parsed = BuilderDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid builder document: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const size = JSON.stringify(parsed.data).length;
  if (size > MAX_DOCUMENT_BYTES) throw new BadRequestError(`Builder document exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  assertNoSensitiveData(parsed.data); // no secrets / PHI / blobs at any depth
  return parsed.data;
}
