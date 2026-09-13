import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import {
  setOrganizationOverride, removeOrganizationOverride,
  setFacilityOverride, removeFacilityOverride,
} from "@/lib/commercial/overrides";

/**
 * Commercial entitlement overrides (PLATFORM-only). An organization admin can
 * never grant themselves an override — the service asserts platform, and the
 * route gates commercial:platform:manage.
 */
const putSchema = z.object({
  scope: z.enum(["organization", "facility"]),
  targetId: z.string().min(1),
  key: z.string().min(1),
  boolValue: z.boolean().optional().nullable(),
  numberValue: z.number().int().optional().nullable(),
  unlimited: z.boolean().optional(),
  reason: z.string().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export async function PUT(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { scope, targetId, key, boolValue, numberValue, unlimited, reason, expiresAt } = parsed.data;
    const value = { key, boolValue, numberValue, unlimited, reason, expiresAt: expiresAt ? new Date(expiresAt) : null };
    const row = scope === "organization"
      ? await setOrganizationOverride(m, targetId, value)
      : await setFacilityOverride(m, targetId, value);
    return { override: row };
  });
}

const deleteSchema = z.object({
  scope: z.enum(["organization", "facility"]),
  targetId: z.string().min(1),
  key: z.string().min(1),
});

export async function DELETE(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { scope, targetId, key } = parsed.data;
    if (scope === "organization") await removeOrganizationOverride(m, targetId, key);
    else await removeFacilityOverride(m, targetId, key);
    return { ok: true };
  });
}
