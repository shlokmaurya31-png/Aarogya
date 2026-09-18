import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { resolveKeySpec, ConfigError } from "@/lib/config";

/** POST: validate a value against a key's registry spec WITHOUT persisting. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireActorMemberships("configuration:manage");
    const body = await req.json().catch(() => ({}));
    const spec = resolveKeySpec(body?.key);
    if (!spec) throw new BadRequestError(`Unknown configuration key: ${body?.key}`);
    try {
      const normalized = spec.normalize(String(body?.value ?? ""));
      return { valid: true, valueType: spec.valueType, normalized };
    } catch (e) {
      if (e instanceof ConfigError) return { valid: false, error: e.message };
      throw e;
    }
  });
}
