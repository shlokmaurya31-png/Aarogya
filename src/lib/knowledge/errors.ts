import { NextResponse } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * RAG Phase 2 — a knowledge refusal: an HTTP status, a closed code a screen
 * can act on, and a plain message. Never a file's contents or a matched value
 * (an identifier refusal names only the kinds found).
 */
export type KnowledgeErrorCode =
  | "EMPTY" | "TOO_LARGE" | "DOCX_DEFERRED" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "NOT_UTF8"
  | "UNREADABLE" | "NO_TEXT_LAYER" | "NO_TEXT" | "TOO_MANY_PAGES"
  | "CONTAINS_IDENTIFIERS" | "DUPLICATE" | "INVALID" | "SELF_APPROVAL" | "NOT_SUBMITTED" | "NOT_INDEXED"
  | "OLDER_THAN_CURRENT" | "ALREADY_WITHDRAWN" | "NOT_FAILED" | "ORGANIZATION_ADMIN_ONLY" | "WINDOW";

export class KnowledgeError extends Error {
  constructor(readonly status: 400 | 403 | 409, readonly code: KnowledgeErrorCode, message: string, readonly kinds?: readonly string[]) {
    super(message);
    this.name = "KnowledgeError";
  }
}

/** withApiErrors, with a KnowledgeError answered as { error, code, kinds? } at its own status. */
export async function knowledgeApi<T>(fn: () => Promise<T>): Promise<NextResponse> {
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof KnowledgeError) return NextResponse.json({ error: err.message, code: err.code, ...(err.kinds ? { kinds: err.kinds } : {}) }, { status: err.status });
    return withApiErrors(async () => { throw err; });
  }
  return withApiErrors(async () => result);
}
