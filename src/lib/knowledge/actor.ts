import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { requireSession, ForbiddenError } from "@/lib/auth/rbac";
import { roleHasPermission, type Permission } from "@/lib/auth/permissions";
import type { KnowledgeActor } from "./service";

/**
 * RAG Phase 2 — the caller as a knowledge actor: their permission checked,
 * their facility and organisation resolved server-side (never from the
 * request beyond a facility choice the membership allows). "read" is either
 * knowledge permission: administrators and approvers both see the list.
 */
export async function requireKnowledgeActor(mode: "read" | "manage" | "approve", requestedFacilityId?: string): Promise<KnowledgeActor> {
  let permission: Permission;
  if (mode === "read") {
    const s = await requireSession();
    permission = roleHasPermission(s.role, "knowledge:manage") ? "knowledge:manage" : "knowledge:approve";
    if (!roleHasPermission(s.role, permission)) throw new ForbiddenError(permission);
  } else permission = mode === "manage" ? "knowledge:manage" : "knowledge:approve";
  const ctx = await requireFacilityStaff(permission, requestedFacilityId);
  return { userId: ctx.session.userId, role: ctx.session.role, facilityId: ctx.facilityId, organizationId: ctx.organizationId, orgAdmin: ctx.orgAdmin };
}

/** An optional ISO date from a form or JSON field: undefined when absent, null when cleared. */
export function dateField(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return new Date(String(v));
}
