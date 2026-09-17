import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  assertOrganizationAccess,
  assertOrganizationAdmin,
  type ActorMemberships,
} from "@/lib/auth/tenantContext";
import { DEFAULT_BILLING_CURRENCY } from "./money";

type Tx = Prisma.TransactionClient | typeof prisma;

/**
 * Phase D3 — the one canonical SaaS billing account per organization.
 *
 * Tenant-scoped: reads require standing in the organization; contact edits
 * require organization administration; the billing currency is server-controlled
 * and can only be changed by the platform. No card/credential data is ever
 * stored. All mutation is audited in the `commercial.billing.*` namespace.
 */

export interface BillingAccountDefaults {
  billingName: string;
  billingEmail: string;
  currency?: string;
}

/**
 * Idempotent create-or-get, keyed on the unique organizationId via a raw
 * INSERT ... ON CONFLICT DO NOTHING (the codebase idiom that is safe on both
 * SQLite and PostgreSQL and never aborts the surrounding transaction on
 * conflict). Concurrent callers converge to exactly one account row.
 */
export async function getOrCreateBillingAccount(tx: Tx, organizationId: string, defaults: BillingAccountDefaults) {
  const currency = defaults.currency ?? DEFAULT_BILLING_CURRENCY;
  await tx.$executeRaw`
    INSERT INTO "OrganizationBillingAccount" (id, "organizationId", "billingName", "billingEmail", currency)
    VALUES (${randomUUID()}, ${organizationId}, ${defaults.billingName}, ${defaults.billingEmail}, ${currency})
    ON CONFLICT ("organizationId") DO NOTHING
  `;
  return tx.organizationBillingAccount.findUniqueOrThrow({ where: { organizationId } });
}

/** Tenant-scoped read: the caller must have standing in the organization. */
export async function getBillingAccount(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.organizationBillingAccount.findUnique({ where: { organizationId } });
}

export interface BillingAccountPatch {
  billingName?: string;
  billingEmail?: string;
  billingAddress?: string | null;
  taxId?: string | null;
  /** Currency change is platform-only (server-authoritative); ignored for org admins. */
  currency?: string;
}

/**
 * Update the billing account. An organization administrator may edit the benign
 * contact fields of THEIR OWN account (self-service). Changing the billing
 * currency is a platform-only act, because it changes invoice semantics — it is
 * refused for a non-platform caller even if they pass it.
 */
export async function updateBillingAccount(m: ActorMemberships, organizationId: string, patch: BillingAccountPatch) {
  // Contact edits require organization administration; platform admins pass too.
  assertOrganizationAdmin(m, organizationId);

  const account = await getOrCreateBillingAccount(prisma, organizationId, {
    billingName: patch.billingName ?? "",
    billingEmail: patch.billingEmail ?? "",
  });

  const data: Prisma.OrganizationBillingAccountUpdateInput = {};
  if (patch.billingName !== undefined) data.billingName = patch.billingName;
  if (patch.billingEmail !== undefined) data.billingEmail = patch.billingEmail;
  if (patch.billingAddress !== undefined) data.billingAddress = patch.billingAddress;
  if (patch.taxId !== undefined) data.taxId = patch.taxId;
  if (patch.currency !== undefined) {
    if (!m.isPlatformAdmin) throw new BadRequestError("The billing currency is platform-controlled and cannot be changed here.");
    data.currency = patch.currency;
  }

  const updated = await prisma.organizationBillingAccount.update({ where: { id: account.id }, data });
  await recordAuditEvent("commercial.billing.accountUpdated", m.userId, { changed: Object.keys(data) }, { organizationId });
  return updated;
}

/** Platform-only: attach an opaque provider customer reference (never a secret). */
export async function setProviderCustomerRef(
  m: ActorMemberships,
  organizationId: string,
  input: { providerKind: "NONE" | "FAKE"; providerCustomerRef: string | null }
) {
  if (!m.isPlatformAdmin) throw new NotFoundError();
  const account = await prisma.organizationBillingAccount.findUnique({ where: { organizationId } });
  if (!account) throw new NotFoundError();
  const updated = await prisma.organizationBillingAccount.update({
    where: { id: account.id },
    data: { providerKind: input.providerKind, providerCustomerRef: input.providerCustomerRef },
  });
  await recordAuditEvent("commercial.billing.providerMapped", m.userId, { providerKind: input.providerKind }, { organizationId });
  return updated;
}
