import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { createPersonForAccount, recordActiveLink } from "./person";
import { routeFor } from "./linking";

type Tx = Prisma.TransactionClient;

/**
 * Phase 0 — moving existing accounts onto Persons
 * (docs/PERSON_IDENTITY_DESIGN.md §10). Refuses rather than guesses.
 *
 * For each PATIENT account without a Person:
 *   - a Person is created (source MIGRATION) with the account as OWNER;
 *   - if the account is linked to a facility record (the retired
 *     Patient.userId), the link's evidence decides:
 *       SELF_CREATED        the account's own sign-up created the record
 *                           (patient.account.registered audit row);
 *       OTP_RECORD_CONTACT  a code sent to the record's phone was entered
 *                           (an OTP-resolved PatientLinkRequest);
 *       anything else       (a front-desk LINK decision, seeded/demo links,
 *                           no evidence) → REVERIFICATION_REQUIRED: no
 *                           person-level access until the person verifies;
 *     and Patient.userId is cleared (the link now carries it);
 *   - the account's uploads get their owning Person and keep their old
 *     visibility at the facility they were uploaded to until the person
 *     makes the sharing choice (legacyFacilityVisible; the approved reversal);
 *   - its open link requests get the Person and are re-routed under the new
 *     rules (an unconsumed old code is discarded).
 * Refused, with nothing written for that account: a linked record that has
 * been merged into another, or a record that already has a live link.
 * Delegations are left as they are (households, 5b).
 */

export type MigrationRefusal = { userId: string; patientId?: string; reason: "MERGED_RECORD" | "RECORD_ALREADY_LINKED" };
export interface MigrationReport {
  dryRun: boolean;
  accountsSeen: number;
  alreadyMigrated: number;
  personsCreated: number;
  linksActive: { SELF_CREATED: number; OTP_RECORD_CONTACT: number };
  linksReverificationRequired: { FRONT_DESK_LINK: number; NO_EVIDENCE: number };
  accountsWithoutRecord: number;
  uploadsOwned: number;
  requestsRerouted: number;
  refusals: MigrationRefusal[];
}

type Plan =
  | { kind: "SKIP" }
  | { kind: "REFUSE"; refusal: MigrationRefusal }
  | { kind: "NO_RECORD" }
  | { kind: "ACTIVE"; patientId: string; facilityId: string; method: "SELF_CREATED" | "OTP_RECORD_CONTACT"; linkRequestId?: string }
  | { kind: "REVERIFY"; patientId: string; facilityId: string; reason: "FRONT_DESK_LINK" | "NO_EVIDENCE" };

/** What the migration would do for one account. Reads only. */
export async function planAccount(userId: string): Promise<Plan> {
  if (await prisma.personAccount.findUnique({ where: { userId } })) return { kind: "SKIP" };
  const patient = await prisma.patient.findUnique({ where: { userId }, select: { id: true, facilityId: true, mergedIntoId: true } });
  if (!patient) return { kind: "NO_RECORD" };
  if (patient.mergedIntoId) return { kind: "REFUSE", refusal: { userId, patientId: patient.id, reason: "MERGED_RECORD" } };
  const live = await prisma.personPatientLink.count({ where: { patientId: patient.id, status: { in: ["ACTIVE", "PENDING_VERIFICATION", "REVERIFICATION_REQUIRED"] } } });
  if (live) return { kind: "REFUSE", refusal: { userId, patientId: patient.id, reason: "RECORD_ALREADY_LINKED" } };

  const selfCreated = await prisma.auditEvent.count({ where: { type: "patient.account.registered", userId, detail: { path: ["patientId"], equals: patient.id } } });
  if (selfCreated) return { kind: "ACTIVE", patientId: patient.id, facilityId: patient.facilityId, method: "SELF_CREATED" };
  const byCode = await prisma.patientLinkRequest.findFirst({ where: { userId, candidatePatientId: patient.id, status: "LINKED", resolvedByUserId: null }, select: { id: true } });
  if (byCode) return { kind: "ACTIVE", patientId: patient.id, facilityId: patient.facilityId, method: "OTP_RECORD_CONTACT", linkRequestId: byCode.id };
  const byDesk = await prisma.patientLinkRequest.count({ where: { userId, candidatePatientId: patient.id, status: "LINKED", resolvedByUserId: { not: null } } });
  return { kind: "REVERIFY", patientId: patient.id, facilityId: patient.facilityId, reason: byDesk ? "FRONT_DESK_LINK" : "NO_EVIDENCE" };
}

async function applyPlan(tx: Tx, user: { id: string; email: string; displayName: string | null }, plan: Plan): Promise<{ uploads: number; rerouted: number }> {
  const person = await createPersonForAccount(tx, { userId: user.id, displayName: user.displayName ?? user.email, email: user.email, source: "MIGRATION" });
  if (plan.kind === "ACTIVE") {
    await tx.patient.update({ where: { id: plan.patientId }, data: { userId: null } });
    await recordActiveLink(tx, { personId: person.id, patientId: plan.patientId, facilityId: plan.facilityId, method: plan.method, linkedByUserId: user.id, linkRequestId: plan.linkRequestId });
  } else if (plan.kind === "REVERIFY") {
    await tx.patient.update({ where: { id: plan.patientId }, data: { userId: null } });
    const link = await tx.personPatientLink.create({ data: { personId: person.id, patientId: plan.patientId, facilityId: plan.facilityId, status: "REVERIFICATION_REQUIRED" } });
    await tx.personAccessLogEntry.create({ data: { personId: person.id, kind: "REVERIFICATION_REQUIRED", accessingFacilityId: plan.facilityId, detail: { linkId: link.id, reason: plan.reason } } });
    await emitFacilityEvent(tx, {
      type: "PersonLinkReverificationRequired", aggregateId: link.id, facilityId: plan.facilityId, personId: person.id,
      payload: { linkId: link.id, personId: person.id, patientId: plan.patientId, reason: plan.reason },
    });
  }
  // The account's uploads are its Person's; old visibility until the person chooses.
  const uploads = await tx.clinicalDocument.updateMany({ where: { uploadedByUserId: user.id, personId: null }, data: { personId: person.id, legacyFacilityVisible: true } });
  // Open requests from before Phase 0: attach the Person and re-route (old codes are discarded).
  const open = await tx.patientLinkRequest.findMany({ where: { userId: user.id, personId: null, status: { in: ["OTP_SENT", "FRONT_DESK_REVIEW"] } } });
  for (const r of open) {
    const cand = r.candidatePatientId ? await tx.patient.findUnique({ where: { id: r.candidatePatientId }, select: { id: true, phone: true, phoneConfirmedAt: true } }) : null;
    const { route, reason } = cand ? await routeFor(cand) : { route: "FRONT_DESK_REVIEW" as const, reason: "no matched record" };
    await tx.patientLinkRequest.update({ where: { id: r.id }, data: { personId: person.id, status: route, reviewReason: reason, otpHash: null, otpExpiresAt: null, otpAttempts: 0 } });
  }
  return { uploads: uploads.count, rerouted: open.length };
}

/**
 * Runs (or, with dryRun, only plans) the migration. One transaction per
 * account, so a failure leaves the others done and itself untouched.
 * Idempotent: an account with a Person is skipped. `onlyUserIds` limits it
 * (gates); otherwise every PATIENT account is considered.
 */
export async function migrateIdentities(opts: { dryRun: boolean; onlyUserIds?: string[] }): Promise<MigrationReport> {
  const report: MigrationReport = {
    dryRun: opts.dryRun, accountsSeen: 0, alreadyMigrated: 0, personsCreated: 0,
    linksActive: { SELF_CREATED: 0, OTP_RECORD_CONTACT: 0 }, linksReverificationRequired: { FRONT_DESK_LINK: 0, NO_EVIDENCE: 0 },
    accountsWithoutRecord: 0, uploadsOwned: 0, requestsRerouted: 0, refusals: [],
  };
  const users = await prisma.user.findMany({
    where: { role: "PATIENT", ...(opts.onlyUserIds ? { id: { in: opts.onlyUserIds } } : {}) },
    select: { id: true, email: true, displayName: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const user of users) {
    report.accountsSeen += 1;
    const plan = await planAccount(user.id);
    if (plan.kind === "SKIP") { report.alreadyMigrated += 1; continue; }
    if (plan.kind === "REFUSE") { report.refusals.push(plan.refusal); continue; }
    if (plan.kind === "NO_RECORD") report.accountsWithoutRecord += 1;
    if (plan.kind === "ACTIVE") report.linksActive[plan.method] += 1;
    if (plan.kind === "REVERIFY") report.linksReverificationRequired[plan.reason] += 1;
    report.personsCreated += 1;
    if (opts.dryRun) {
      report.uploadsOwned += await prisma.clinicalDocument.count({ where: { uploadedByUserId: user.id, personId: null } });
      report.requestsRerouted += await prisma.patientLinkRequest.count({ where: { userId: user.id, personId: null, status: { in: ["OTP_SENT", "FRONT_DESK_REVIEW"] } } });
      continue;
    }
    const done = await prisma.$transaction((tx) => applyPlan(tx, user, plan));
    report.uploadsOwned += done.uploads;
    report.requestsRerouted += done.rerouted;
  }
  return report;
}
