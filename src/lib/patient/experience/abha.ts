import { listExternalIdentifiers } from "@/lib/hospital/interoperability/externalIdentity";
import { getAbdmConfig } from "@/lib/hospital/interoperability/abdm/config";
import type { PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing ABHA status (brief §15, §16).
 *
 * Surfaces the patient's linked ABHA/ABDM identifiers (from the canonical
 * ExternalIdentifier store) and the HONEST connection state of the ABDM
 * integration. Verification is NEVER invented — verificationStatus is whatever
 * the canonical row holds (UNVERIFIED until a real registry response). When the
 * ABDM environment is not configured (sandbox/prod creds are an external
 * blocker), the patient is told exactly that rather than shown a fake "linked
 * & verified" state. Raw identifier values are masked; secrets never leave.
 */

const ABDM_SYSTEMS = ["abdm", "healthid", "abha"];

function isAbdmSystem(system: string): boolean {
  const s = system.toLowerCase();
  return ABDM_SYSTEMS.some((m) => s.includes(m));
}

function maskValue(v: string): string {
  if (v.length <= 4) return "••••";
  return "•".repeat(Math.max(0, v.length - 4)) + v.slice(-4);
}

export interface AbhaStatusDTO {
  integration: {
    configured: boolean;
    environment: string;
    // Patient-facing honest state string.
    connectionState: "AVAILABLE" | "EXTERNAL_CONNECTION_UNAVAILABLE";
    message: string;
  };
  links: {
    valueMasked: string;
    verificationStatus: string; // UNVERIFIED | VERIFIED | FAILED (canonical, never invented)
    status: string;
    linkedAt: string;
  }[];
}

export async function getAbhaStatus(scope: PatientAccessScope): Promise<AbhaStatusDTO> {
  const config = getAbdmConfig();
  const identifiers = await listExternalIdentifiers({
    facilityId: scope.facilityId,
    entityType: "PATIENT",
    entityId: scope.patientId,
  });
  const links = identifiers
    .filter((i) => isAbdmSystem(i.system))
    .map((i) => ({
      valueMasked: maskValue(i.value),
      verificationStatus: i.verificationStatus,
      status: i.status,
      linkedAt: i.createdAt.toISOString(),
    }));

  return {
    integration: {
      configured: config.configured,
      environment: config.environment,
      connectionState: config.configured ? "AVAILABLE" : "EXTERNAL_CONNECTION_UNAVAILABLE",
      message: config.configured
        ? `Connected to ABDM ${config.environment}.`
        : "ABHA linkage and health-information sharing are not available yet — the ABDM connection is not configured for this deployment.",
    },
    links,
  };
}
