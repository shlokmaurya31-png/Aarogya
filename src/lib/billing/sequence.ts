import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ConflictError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

const SCOPE = "SAAS";

/**
 * Phase D3 — platform-wide SaaS invoice numbering.
 *
 * Per-fiscal-year atomic counter, CAS-based (raw INSERT ... ON CONFLICT DO
 * NOTHING to materialise the row, then a guarded updateMany retry loop) — the
 * same engine-agnostic idiom as the hospital InvoiceSequence, so it is safe on
 * SQLite and PostgreSQL alike. Must run inside the caller's transaction so the
 * number and the invoice that consumes it commit or roll back together.
 */
export async function nextInvoiceSequence(tx: Tx, fiscalYear: number): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO "BillingInvoiceSequence" (id, scope, "fiscalYear", "nextValue")
    VALUES (${randomUUID()}, ${SCOPE}, ${fiscalYear}, 1)
    ON CONFLICT (scope, "fiscalYear") DO NOTHING
  `;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await tx.billingInvoiceSequence.findUniqueOrThrow({
      where: { scope_fiscalYear: { scope: SCOPE, fiscalYear } },
    });
    const result = await tx.billingInvoiceSequence.updateMany({
      where: { scope: SCOPE, fiscalYear, nextValue: current.nextValue },
      data: { nextValue: current.nextValue + 1 },
    });
    if (result.count === 1) return current.nextValue;
  }
  throw new ConflictError("Could not allocate an invoice number — too much concurrent contention. Please retry.");
}

/** "AAR-SAAS-2026-000042" — deterministic, zero-padded, audit-legible. */
export function formatInvoiceNumber(fiscalYear: number, value: number): string {
  return `AAR-SAAS-${fiscalYear}-${String(value).padStart(6, "0")}`;
}
