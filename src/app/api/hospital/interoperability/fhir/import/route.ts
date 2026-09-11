import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { importFhirPayload, listImportedResources, reviewImportedResource } from "@/lib/hospital/interoperability/fhir/import";
import { MAX_PAYLOAD_BYTES } from "@/lib/hospital/interoperability/fhir/validate";

/**
 * Phase C1 — controlled FHIR import.
 *
 * The body is read as RAW TEXT so the size ceiling is enforced before any JSON
 * parsing happens; handing an unbounded external payload to JSON.parse first
 * would be the denial-of-service the limit exists to prevent.
 *
 * Nothing imported here reaches a clinical table. Resources are STAGED for
 * review — see src/lib/hospital/interoperability/fhir/import.ts.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { session, facilityId, staff } = await requireFacilityStaff(
      "interop:fhir:import",
      searchParams.get("facilityId") ?? undefined
    );

    // Reject on the declared length before reading the stream at all.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared && declared > MAX_PAYLOAD_BYTES) {
      throw new BadRequestError(`Payload exceeds the ${MAX_PAYLOAD_BYTES} byte limit.`);
    }

    const rawBody = await req.text();
    const sourceSystem = searchParams.get("sourceSystem") ?? req.headers.get("x-source-system");
    if (!sourceSystem) {
      throw new BadRequestError("A sourceSystem is required so imported data can be attributed.");
    }

    const result = await importFhirPayload({
      facilityId,
      rawBody,
      sourceSystem,
      // A caller-asserted patient is still verified against the facility before
      // any resource is attached to it.
      patientId: searchParams.get("patientId") ?? null,
      exchangeId: searchParams.get("exchangeId") ?? null,
      correlationId: req.headers.get("x-correlation-id"),
      actorStaffId: staff?.id ?? null,
      byUserId: session.userId,
    });

    return result;
  });
}

/** Review queue: staged, conflicting and rejected inbound resources. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:import:review", searchParams.get("facilityId") ?? undefined);
    const resources = await listImportedResources({
      facilityId,
      status: searchParams.get("status") ?? undefined,
    });
    return { resources };
  });
}

/** Record a human decision on a staged or conflicting resource. */
export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("interop:import:review", body?.facilityId);
    if (!body?.importedResourceId || !body?.decision) {
      throw new BadRequestError("importedResourceId and decision are required.");
    }
    const resource = await reviewImportedResource({
      facilityId,
      importedResourceId: body.importedResourceId,
      decision: body.decision,
      reviewedByStaffId: staff?.id,
      note: body.note,
      byUserId: session.userId,
    });
    return { resource };
  });
}
