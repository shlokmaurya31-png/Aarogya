import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { assertKnownSystem } from "./registry";

/**
 * Phase C6 — external participant registry.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IDENTITY IS NOT TRUST.
 *
 * `externalId` says who a counterparty CLAIMS to be. `trustStatus` says whether
 * this facility has decided to rely on that claim. They are separate columns
 * because conflating them is how a spoofed participant code becomes an
 * authorised data recipient.
 *
 * Three consequences, all enforced below:
 *   - a participant is born UNVERIFIED, and nothing but an explicit, audited,
 *     step-up-gated operator action can change that
 *   - an import can create a participant but can never verify one
 *   - SUSPENDED and REVOKED are reachable from anywhere; REVOKED is terminal,
 *     because un-revoking should force a deliberate new record
 *
 * Participants are facility-scoped, and a sandbox participant is a different
 * row from a production one with the same code — the unique key includes the
 * environment so a sandbox counterparty can never be silently reused live.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const PARTICIPANT_TYPES = [
  "HIP", "HIU", "PAYER", "PROVIDER", "EXTERNAL_LAB", "EXTERNAL_FACILITY",
] as const;
export type ParticipantType = (typeof PARTICIPANT_TYPES)[number];

export const TRUST_STATUSES = ["UNVERIFIED", "VERIFIED", "SUSPENDED", "REVOKED"] as const;
export type TrustStatus = (typeof TRUST_STATUSES)[number];

/** REVOKED is terminal on purpose: re-trusting requires a new, deliberate record. */
const TRUST_TRANSITIONS: Record<TrustStatus, TrustStatus[]> = {
  UNVERIFIED: ["VERIFIED", "SUSPENDED", "REVOKED"],
  VERIFIED: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["VERIFIED", "REVOKED"],
  REVOKED: [],
};

export function isTrustTransitionAllowed(from: string, to: string): boolean {
  return TRUST_TRANSITIONS[from as TrustStatus]?.includes(to as TrustStatus) ?? false;
}

/** Only a VERIFIED participant may receive or be believed by an exchange. */
export function isParticipantUsable(p: { status: string; trustStatus: string }): boolean {
  return p.status === "ACTIVE" && p.trustStatus === "VERIFIED";
}

export async function registerParticipant(input: {
  facilityId: string;
  actor: AuthorizationActor;
  system: string;
  type: string;
  name: string;
  externalId: string;
  externalIdSystem?: string | null;
  environment?: string;
  payerId?: string | null;
  /** Set when a participant arrives from an inbound message rather than an operator. */
  fromImport?: boolean;
}) {
  const system = assertKnownSystem(input.system);
  if (!(PARTICIPANT_TYPES as readonly string[]).includes(input.type)) {
    throw new BadRequestError(`type must be one of ${PARTICIPANT_TYPES.join(", ")}.`);
  }
  if (!input.name?.trim()) throw new BadRequestError("A participant name is required.");
  if (!input.externalId?.trim()) throw new BadRequestError("An external identifier is required.");

  const environment = input.environment ?? "SANDBOX";
  if (!["LOCAL", "SANDBOX", "PRODUCTION"].includes(environment)) {
    throw new BadRequestError("environment must be LOCAL, SANDBOX or PRODUCTION.");
  }

  // A linked payer must be a real Payer. Payer is global, so there is no
  // facility column to compare; the participant row itself is facility-scoped,
  // which is what preserves tenant isolation.
  if (input.payerId) {
    const payer = await prisma.payer.findUnique({ where: { id: input.payerId }, select: { id: true } });
    if (!payer) throw new NotFoundError("Payer not found.");
  }

  try {
    const participant = await prisma.externalParticipant.create({
      data: {
        facilityId: input.facilityId,
        system,
        type: input.type,
        name: input.name.trim().slice(0, 200),
        externalId: input.externalId.trim().slice(0, 200),
        externalIdSystem: input.externalIdSystem?.slice(0, 200) ?? null,
        environment,
        status: "ACTIVE",
        // Always. There is no argument, imported or otherwise, that can make
        // this VERIFIED at creation.
        trustStatus: "UNVERIFIED",
        payerId: input.payerId ?? null,
      },
    });

    await recordAuditEvent(
      "hospital.interop.participantRegistered",
      input.actor.userId,
      {
        system, type: input.type, environment,
        externalId: participant.externalId, fromImport: !!input.fromImport,
      },
      { facilityId: input.facilityId }
    );
    return participant;
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      throw new ConflictError("That participant is already registered for this system and environment.");
    }
    throw e;
  }
}

/**
 * Change a participant's trust status.
 *
 * The note is mandatory for every transition, not just the punitive ones: a
 * VERIFIED participant with no recorded reason is an audit finding waiting to
 * happen.
 */
export async function setParticipantTrust(input: {
  facilityId: string; participantId: string; to: string; note: string; actor: AuthorizationActor;
}) {
  if (!(TRUST_STATUSES as readonly string[]).includes(input.to)) {
    throw new BadRequestError(`trustStatus must be one of ${TRUST_STATUSES.join(", ")}.`);
  }
  if (!input.note?.trim()) throw new BadRequestError("A note is required to change participant trust.");

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.externalParticipant.findUnique({ where: { id: input.participantId } });
    if (!p || p.facilityId !== input.facilityId) throw new NotFoundError("Participant not found.");
    if (!isTrustTransitionAllowed(p.trustStatus, input.to)) {
      throw new BadRequestError(`Illegal trust transition ${p.trustStatus} -> ${input.to}.`);
    }
    const r = await tx.externalParticipant.updateMany({
      where: { id: p.id, trustStatus: p.trustStatus, version: p.version },
      data: {
        trustStatus: input.to,
        verificationNote: input.note.trim().slice(0, 500),
        ...(input.to === "VERIFIED"
          ? { verifiedAt: new Date(), verifiedByUserId: input.actor.userId, suspendedAt: null, suspendedReason: null }
          : {}),
        ...(input.to === "SUSPENDED"
          ? { suspendedAt: new Date(), suspendedReason: input.note.trim().slice(0, 500) }
          : {}),
        ...(input.to === "REVOKED" ? { status: "INACTIVE" } : {}),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That participant changed concurrently.");
    return tx.externalParticipant.findUniqueOrThrow({ where: { id: p.id } });
  });

  await recordAuditEvent(
    input.to === "VERIFIED" ? "hospital.interop.participantVerified" : "hospital.interop.participantTrustChanged",
    input.actor.userId,
    { participantId: updated.id, system: updated.system, to: input.to, externalId: updated.externalId },
    { facilityId: input.facilityId }
  );
  return updated;
}

/**
 * Resolve an inbound participant claim to a registered participant.
 *
 * Returns null rather than creating one: an unknown counterparty must be a
 * visible operational decision, not a silent auto-registration that then looks
 * like a known party on the next message.
 */
export async function resolveParticipant(args: {
  facilityId: string; system: string; environment: string; externalId: string;
}) {
  if (!args.externalId) return null;
  return prisma.externalParticipant.findUnique({
    where: {
      facilityId_system_environment_externalId: {
        facilityId: args.facilityId,
        system: args.system,
        environment: args.environment,
        externalId: args.externalId,
      },
    },
  });
}

export async function listParticipants(args: {
  facilityId: string; system?: string; type?: string; trustStatus?: string;
}) {
  return prisma.externalParticipant.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.system ? { system: args.system } : {}),
      ...(args.type ? { type: args.type } : {}),
      ...(args.trustStatus ? { trustStatus: args.trustStatus } : {}),
    },
    orderBy: [{ system: "asc" }, { name: "asc" }],
    take: 300,
  });
}
