import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { getAbdmConfig, checkEnvironmentSafety, describeAbdmConfig } from "../config";
import { ABDM_CONTRACT_SOURCE } from "../abdm/contract";
import { getExchangeAdapter } from "../adapters/abdm";
import {
  getNhcxConfig, describeNhcxConfig, checkNhcxEnvironmentSafety,
} from "@/lib/hospital/nhcx/config";
import { getNhcxAdapter } from "@/lib/hospital/nhcx/adapter";
import { NHCX_CONTRACT_SOURCE, isTransportContractVerified } from "@/lib/hospital/nhcx/contract";
import { evaluateReadiness, canDispatch, type ReadinessEvidence, type ReadinessAssessment } from "./readiness";

/**
 * Phase C6 — the integration registry.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * This is a REGISTRY OVER EXISTING ADAPTERS, not a new integration engine.
 *
 * The per-facility configuration row is the C1 `InteropConnection`, extended
 * with control-plane columns rather than replaced. The runtime truth comes from
 * the C1/C3 ABDM adapter and the C5 NHCX adapter by asking them directly. This
 * module composes those two sources; it never invents a third.
 *
 * Only three integrations are registered, because only three adapters exist.
 * There is deliberately no "Payer API" or "External EMR" entry: an integration
 * that cannot be dispatched has no business appearing in an operator's list of
 * integrations.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const INTEGRATION_SYSTEMS = ["ABDM", "FHIR", "NHCX"] as const;
export type IntegrationSystem = (typeof INTEGRATION_SYSTEMS)[number];

/**
 * The full capability vocabulary. An integration advertises only the subset its
 * adapter can genuinely perform — see CAPABILITY_SUPPORT below, where several
 * are deliberately marked unsupported.
 */
export const INTEGRATION_CAPABILITIES = [
  "DISCOVERY",
  "AUTHENTICATION",
  "CONSENT",
  "HEALTH_INFORMATION_REQUEST",
  "HEALTH_INFORMATION_RESPONSE",
  "FHIR_EXPORT",
  "FHIR_IMPORT",
  "CLAIM_SUBMISSION",
  "PREAUTH",
  "CLAIM_QUERY",
  "CLAIM_RESPONSE",
  "SETTLEMENT",
] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

/** What a capability's implementation status actually is. */
export type CapabilitySupport =
  /** Implemented against a verified contract and callable when configured. */
  | "IMPLEMENTED"
  /** Domain logic complete; transport cannot be built without external material. */
  | "DOMAIN_ONLY"
  /** Boundary exists, nothing behind it. */
  | "NOT_IMPLEMENTED"
  | "NOT_APPLICABLE";

export interface CapabilityDescriptor {
  capability: IntegrationCapability;
  support: CapabilitySupport;
  /** Why, when it is not IMPLEMENTED. Operator-facing. */
  note?: string;
}

/**
 * Per-system capability truth.
 *
 * These values are claims about OUR code, and each one is checked against the
 * adapter at runtime (see `describeIntegration`): if an adapter advertises no
 * operations, nothing here is reported as live regardless of what it says.
 */
const CAPABILITY_SUPPORT: Record<IntegrationSystem, CapabilityDescriptor[]> = {
  ABDM: [
    {
      capability: "DISCOVERY", support: "IMPLEMENTED",
      note: "Gateway OpenID discovery and JWKS were reached live against the sandbox in C3.",
    },
    {
      capability: "AUTHENTICATION", support: "IMPLEMENTED",
      note: "Session endpoint verified live; rejected with ABDM-9999 for invalid credentials, which proves the contract.",
    },
    { capability: "CONSENT", support: "IMPLEMENTED", note: "Consent v3 request/notify paths verified against M3 v2.5." },
    { capability: "HEALTH_INFORMATION_REQUEST", support: "IMPLEMENTED", note: "Data-flow v3 request path verified against M3 v2.5." },
    {
      capability: "HEALTH_INFORMATION_RESPONSE", support: "DOMAIN_ONLY",
      note: "ECDH key exchange and payload encryption are not implemented; crypto parameters are pinned but no key agreement is performed.",
    },
    { capability: "FHIR_EXPORT", support: "IMPLEMENTED", note: "DocumentBundle composition from canonical records (C1)." },
    { capability: "FHIR_IMPORT", support: "IMPLEMENTED", note: "Staged into ImportedResource; never written directly to clinical tables." },
    { capability: "CLAIM_SUBMISSION", support: "NOT_APPLICABLE" },
    { capability: "PREAUTH", support: "NOT_APPLICABLE" },
    { capability: "CLAIM_QUERY", support: "NOT_APPLICABLE" },
    { capability: "CLAIM_RESPONSE", support: "NOT_APPLICABLE" },
    { capability: "SETTLEMENT", support: "NOT_APPLICABLE" },
  ],
  FHIR: [
    { capability: "DISCOVERY", support: "NOT_APPLICABLE" },
    { capability: "AUTHENTICATION", support: "NOT_APPLICABLE" },
    { capability: "CONSENT", support: "NOT_APPLICABLE" },
    { capability: "HEALTH_INFORMATION_REQUEST", support: "NOT_APPLICABLE" },
    { capability: "HEALTH_INFORMATION_RESPONSE", support: "NOT_APPLICABLE" },
    {
      capability: "FHIR_EXPORT", support: "IMPLEMENTED",
      note: "R4 4.0.1 structural composition from canonical records. Profile validation against ABDM StructureDefinitions is NOT performed.",
    },
    {
      capability: "FHIR_IMPORT", support: "IMPLEMENTED",
      note: "Structural validation and staging only. Conflicts are flagged, never auto-merged.",
    },
    { capability: "CLAIM_SUBMISSION", support: "NOT_APPLICABLE" },
    { capability: "PREAUTH", support: "NOT_APPLICABLE" },
    { capability: "CLAIM_QUERY", support: "NOT_APPLICABLE" },
    { capability: "CLAIM_RESPONSE", support: "NOT_APPLICABLE" },
    { capability: "SETTLEMENT", support: "NOT_APPLICABLE" },
  ],
  NHCX: [
    { capability: "DISCOVERY", support: "NOT_IMPLEMENTED", note: "No verified transport contract." },
    { capability: "AUTHENTICATION", support: "NOT_IMPLEMENTED", note: "No verified transport contract." },
    { capability: "CONSENT", support: "IMPLEMENTED", note: "Reuses the C1/C4 consent engine; INSURANCE purpose is enforced locally." },
    { capability: "HEALTH_INFORMATION_REQUEST", support: "NOT_APPLICABLE" },
    { capability: "HEALTH_INFORMATION_RESPONSE", support: "NOT_APPLICABLE" },
    { capability: "FHIR_EXPORT", support: "IMPLEMENTED", note: "R4 collection ClaimBundle, verified against the NRCeS implementation guide." },
    { capability: "FHIR_IMPORT", support: "NOT_APPLICABLE" },
    {
      capability: "CLAIM_SUBMISSION", support: "DOMAIN_ONLY",
      note: "Packaging, versioning, idempotency and audit are complete. Transport is not implemented: the HCX specification hosts return HTTP 403.",
    },
    { capability: "PREAUTH", support: "DOMAIN_ONLY", note: "Pre-auth records exist in billing; no external transport." },
    { capability: "CLAIM_QUERY", support: "DOMAIN_ONLY", note: "Query workflow complete; inbound arrives only via the callback ledger." },
    { capability: "CLAIM_RESPONSE", support: "DOMAIN_ONLY", note: "Callback handling complete; no verified inbound contract." },
    { capability: "SETTLEMENT", support: "DOMAIN_ONLY", note: "Settlement recording and reconciliation complete; no external transport." },
  ],
};

export interface IntegrationDescriptor {
  system: IntegrationSystem;
  name: string;
  /** What protocol/spec version this speaks, when one is verified. */
  protocolVersion: string | null;
  /** The published source the contract was verified against, if any. */
  contractSource: { document: string; version?: string; verifiedOn: string; url?: string } | null;
  contractVerified: boolean;
  contractBlockedReason: string | null;
  capabilities: CapabilityDescriptor[];
  /** Whether this integration performs external transport at all. */
  transportImplemented: boolean;
}

/**
 * Static, code-level truth about each integration. Nothing facility-specific
 * and nothing secret.
 */
export function describeSystem(system: IntegrationSystem): IntegrationDescriptor {
  switch (system) {
    case "ABDM":
      return {
        system, name: "ABDM (Ayushman Bharat Digital Mission)",
        protocolVersion: `M3 v${ABDM_CONTRACT_SOURCE.version}`,
        contractSource: {
          document: ABDM_CONTRACT_SOURCE.document,
          version: ABDM_CONTRACT_SOURCE.version,
          verifiedOn: ABDM_CONTRACT_SOURCE.verifiedOn,
          url: ABDM_CONTRACT_SOURCE.url,
        },
        contractVerified: true,
        contractBlockedReason: null,
        capabilities: CAPABILITY_SUPPORT.ABDM,
        transportImplemented: true,
      };
    case "FHIR":
      return {
        system, name: "FHIR R4 representation",
        protocolVersion: "4.0.1",
        contractSource: {
          document: "ABDM FHIR Implementation Guide (NRCeS)",
          verifiedOn: ABDM_CONTRACT_SOURCE.verifiedOn,
          url: "https://nrces.in/ndhm/fhir/r4/",
        },
        contractVerified: true,
        contractBlockedReason: null,
        capabilities: CAPABILITY_SUPPORT.FHIR,
        // FHIR is a representation layer composed in-process. It has no
        // transport of its own; ABDM and NHCX carry its output.
        transportImplemented: false,
      };
    case "NHCX":
      return {
        system, name: "NHCX (National Health Claims Exchange)",
        protocolVersion: "FHIR 4.0.1 claim bundle; transport version unknown",
        contractSource: {
          document: NHCX_CONTRACT_SOURCE.document,
          verifiedOn: NHCX_CONTRACT_SOURCE.verifiedOn,
        },
        contractVerified: isTransportContractVerified(),
        contractBlockedReason: NHCX_CONTRACT_SOURCE.transportBlockedReason,
        capabilities: CAPABILITY_SUPPORT.NHCX,
        transportImplemented: false,
      };
  }
}

export function listSystems(): IntegrationDescriptor[] {
  return INTEGRATION_SYSTEMS.map(describeSystem);
}

/** Runtime configuration truth for a system. Redacted; contains no secret. */
async function runtimeFor(system: IntegrationSystem) {
  if (system === "ABDM") {
    const config = getAbdmConfig();
    const safety = checkEnvironmentSafety(config);
    const caps = await getExchangeAdapter("ABDM").capabilities();
    return {
      described: describeAbdmConfig(config),
      environment: config.environment,
      configured: config.configured,
      missing: config.missing,
      safe: safety.safe,
      warning: safety.warning,
      liveOperations: caps.operations ?? [],
    };
  }
  if (system === "NHCX") {
    const config = getNhcxConfig();
    const safety = checkNhcxEnvironmentSafety(config);
    const caps = await getNhcxAdapter().capabilities();
    return {
      described: describeNhcxConfig(config),
      environment: config.environment,
      configured: config.configured,
      missing: config.missing,
      safe: safety.safe,
      warning: safety.warning,
      liveOperations: caps.operations ?? [],
    };
  }
  // FHIR composes in-process: it needs no endpoint, no credential and no
  // network, so it is always "configured" and never has live transport.
  return {
    described: { environment: "LOCAL", credentialsConfigured: true, missing: [] as string[] },
    environment: "LOCAL",
    configured: true,
    missing: [] as string[],
    safe: true,
    warning: null as string | null,
    liveOperations: ["export", "import"],
  };
}

export interface IntegrationView {
  descriptor: IntegrationDescriptor;
  connection: {
    id: string | null;
    environment: string;
    enabled: boolean;
    status: string;
    baseUrl: string | null;
    configRevision: number;
    disabledAt: Date | null;
    disabledReason: string | null;
    productionApprovedAt: Date | null;
    sandboxVerifiedAt: Date | null;
    productionVerifiedAt: Date | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureCategory: string | null;
    lastHealthCheckAt: Date | null;
    lastHealthState: string | null;
  };
  /** Redacted configuration description. Never a secret value. */
  runtime: Record<string, unknown>;
  readiness: ReadinessAssessment;
  dispatch: { allowed: boolean; reason: string | null };
}

/**
 * The operator's view of one integration at one facility.
 *
 * Note which environment wins: the STORED connection row says what an operator
 * intended, and the PROCESS configuration says what can actually happen. When
 * they disagree, dispatch is decided by the process — a row saying PRODUCTION
 * against an unconfigured process dispatches nothing.
 */
export async function describeIntegration(
  facilityId: string, system: IntegrationSystem
): Promise<IntegrationView> {
  const descriptor = describeSystem(system);
  const row = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId, system } },
  });
  const runtime = await runtimeFor(system);

  // An adapter that advertises nothing is treated as having nothing live, even
  // if the descriptor lists implemented capabilities.
  const liveOperations = runtime.liveOperations;

  const evidence: ReadinessEvidence = {
    architectureComplete: true,
    contractVerified: descriptor.contractVerified,
    contractBlockedReason: descriptor.contractBlockedReason,
    // Configuration validity is the PROCESS's answer, not the row's.
    configurationValid: runtime.configured && runtime.safe,
    configurationMissing: runtime.safe ? runtime.missing : [...runtime.missing, runtime.warning ?? "unsafe environment"],
    testsPresent: true,
    environment: row?.environment ?? "DISABLED",
    enabled: row?.enabled ?? false,
    sandboxVerifiedAt: row?.sandboxVerifiedAt ?? null,
    productionVerifiedAt: row?.productionVerifiedAt ?? null,
    productionApprovedAt: row?.productionApprovedAt ?? null,
    liveOperations,
  };

  return {
    descriptor,
    connection: {
      id: row?.id ?? null,
      environment: row?.environment ?? "DISABLED",
      enabled: row?.enabled ?? false,
      status: row?.status ?? "NOT_CONFIGURED",
      baseUrl: row?.baseUrl ?? null,
      configRevision: row?.configRevision ?? 0,
      disabledAt: row?.disabledAt ?? null,
      disabledReason: row?.disabledReason ?? null,
      productionApprovedAt: row?.productionApprovedAt ?? null,
      sandboxVerifiedAt: row?.sandboxVerifiedAt ?? null,
      productionVerifiedAt: row?.productionVerifiedAt ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastFailureAt: row?.lastFailureAt ?? null,
      lastFailureCategory: row?.lastFailureCategory ?? null,
      lastHealthCheckAt: row?.lastHealthCheckAt ?? null,
      lastHealthState: row?.lastHealthState ?? null,
    },
    runtime: runtime.described as Record<string, unknown>,
    readiness: evaluateReadiness(evidence),
    dispatch: canDispatch(evidence),
  };
}

export async function listIntegrations(facilityId: string): Promise<IntegrationView[]> {
  return Promise.all(INTEGRATION_SYSTEMS.map((s) => describeIntegration(facilityId, s)));
}

export function assertKnownSystem(system: string): IntegrationSystem {
  if (!(INTEGRATION_SYSTEMS as readonly string[]).includes(system)) {
    throw new NotFoundError("Unknown integration.");
  }
  return system as IntegrationSystem;
}
