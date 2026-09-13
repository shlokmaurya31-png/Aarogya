import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import {
  resolveAllConfig,
  setOrgConfig,
  setFacilityConfig,
  setDepartmentConfig,
  resetOrgConfig,
  resetFacilityConfig,
  resetDepartmentConfig,
} from "@/lib/enterprise/configuration";

/**
 * Phase D1 — hierarchical configuration.
 * GET resolves every known key for a scope (showing effective value + source);
 * PUT writes an explicit override at a level; DELETE resets a level to inherit.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    const m = await requireActorMemberships("enterprise:config:read");
    const resolved = await resolveAllConfig(m, {
      organizationId,
      facilityId: searchParams.get("facilityId"),
      departmentId: searchParams.get("departmentId"),
    });
    return { config: resolved };
  });
}

const putSchema = z.object({
  level: z.enum(["organization", "facility", "department"]),
  targetId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});

export async function PUT(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("enterprise:config:manage");
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { level, targetId, key, value } = parsed.data;
    const row =
      level === "organization" ? await setOrgConfig(m, targetId, key, value)
      : level === "facility" ? await setFacilityConfig(m, targetId, key, value)
      : await setDepartmentConfig(m, targetId, key, value);
    return { config: row };
  });
}

const deleteSchema = z.object({
  level: z.enum(["organization", "facility", "department"]),
  targetId: z.string().min(1),
  key: z.string().min(1),
});

export async function DELETE(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("enterprise:config:manage");
    const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { level, targetId, key } = parsed.data;
    if (level === "organization") await resetOrgConfig(m, targetId, key);
    else if (level === "facility") await resetFacilityConfig(m, targetId, key);
    else await resetDepartmentConfig(m, targetId, key);
    return { ok: true };
  });
}
