import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";
import { getDocumentForDownload } from "@/lib/patient/experience/reports";

/**
 * Authorized document retrieval. Re-verifies ownership + release + classification
 * server-side; never exposes a raw storage URL or accepts a client path. Object
 * storage is not configured (external blocker), so this returns the authorized
 * reference/metadata rather than streaming bytes — no unrestricted blob access.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    const result = await getDocumentForDownload(scope, id);
    if (!result.available) {
      return { available: false, reason: result.reason, message: "This document has no downloadable file attached yet." };
    }
    return { available: true, title: result.title, storageRef: result.storageRef, note: "Object storage is not configured; secure streaming is not available yet (EXTERNAL_STORAGE_NOT_CONFIGURED)." };
  });
}
