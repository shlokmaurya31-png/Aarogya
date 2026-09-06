# Phase 5 — Financial Invariants, Concurrency, and a Real Bug Found

## Money and rounding

Every amount is an integer minor unit (INR paise). One rounding policy,
round-half-up on integer paise, implemented once in
`src/lib/hospital/billing/money.ts` and never reimplemented per-route.
`computeLineNetAmountMinor` rejects a discount larger than the gross
amount (no negative-amount charge). Unit-tested: `money.test.ts`
(round-trip conversion, sub-paise rounding, percentage discount on odd
paise, quantity×price with fractional quantity, `ceilStayDays` boundary
cases).

## Facility isolation

Every financial route resolves `facilityId` via the existing
`requireFacilityStaff` pattern and scopes every query to it; cross-
facility resource IDs 404 rather than leak. Verified live (Phase 5's
`docs/PHASE_5_...` E2E pass): a Noida-facility admin hitting an AMC
invoice/payment ID by GUID got a clean 404, not an error revealing the
resource exists elsewhere.

## The 6 required concurrency invariants

| # | Race | Mechanism | SQLite vs Postgres |
|---|---|---|---|
| 1 | Charge (duplicate billing of one clinical event) | `@@unique([sourceType, sourceId])` + atomic insert (see below) | Identical both engines |
| 2 | Payment (double-submit / over-allocate) | `idempotencyKey @unique` + atomic insert; allocation CAS on `Payment.allocatedMinor` | Identical both engines |
| 3 | Invoice (double-issue / number collision) | Guarded `updateMany` transition + sequence CAS inside the same guarded transition, `invoiceNumber @unique` backstop | Identical both engines |
| 4 | Refund (double-submit / over-refund) | `idempotencyKey @unique` + atomic insert; CAS on `Payment.refundedMinor` | Identical both engines |
| 5 | Tariff (overlapping active price) | App-level overlap check + Postgres GiST exclusion constraint | **Differs by design** — SQLite has the app-level check only, same documented gap pattern as `ImagingStudy` scheduling (Phase 4.5) before its own Postgres fix |
| 6 | Claim (double-submit) | Guarded `updateMany` on `Claim.status`; `invoiceId @unique` structurally prevents duplicate claims per invoice | Identical both engines |

All 6 verified with genuinely parallel requests (`Promise.all`, not
sequential) via `scripts/verify-postgres-billing-concurrency.ts` against a
real Postgres 16 instance — 8/8 cases passing (races 1–4 and 6 each have
one primary scenario, race 2 and 3 each have two).

## A real bug this phase found and fixed

The original Phase 4 idempotency pattern (`createChargeIfNotExists`,
copied into this phase's `recordPayment`/`requestRefund`) was:

```ts
try {
  const result = await tx.charge.create({ ... });
  return { ...result, alreadyExisted: false };
} catch (err) {
  if (isP2002(err)) {
    const winner = await tx.charge.findFirstOrThrow({ where: {...} }); // <- fails
    return { charge: winner, alreadyExisted: true };
  }
  throw err;
}
```

This had never been stress-tested with genuine concurrency before —
Phase 4/4.5's Postgres validation covered schema/constraints and the
imaging-scheduling exclusion constraint, but not this specific pattern
under a real race. Writing `scripts/verify-postgres-billing-concurrency.ts`
surfaced it immediately: **on Postgres, a failed INSERT inside an
interactive transaction aborts the *entire* transaction** (SQLSTATE
25P02, "current transaction is aborted, commands ignored until end of
transaction block"). The `findFirstOrThrow` fallback — running in the
*same* now-aborted transaction — itself failed, surfacing as an uncaught
500 instead of a clean idempotent response. SQLite doesn't have this
strict abort-the-whole-transaction behavior, which is exactly why it was
never caught before: every previous sequential/SQLite test passed.

**Two candidate fixes were tried and rejected before landing on the
correct one:**

1. `upsert()` with an empty `update: {}` — plausible-looking, but verified
   empirically to still throw P2002 under genuine concurrent load on this
   Prisma version (an empty update apparently doesn't reliably force the
   `ON CONFLICT DO UPDATE` SQL path). Rejected.
2. `createMany({ skipDuplicates: true })` — this *is* Prisma's documented
   mechanism for `INSERT ... ON CONFLICT DO NOTHING`, and it worked
   correctly on Postgres — but `skipDuplicates` **is not supported by
   Prisma's SQLite connector at all** ("Unknown argument `skipDuplicates`"),
   which would have broken every local dev workflow. Rejected.

**The fix that works on both engines**: raw parameterized SQL,
`INSERT ... ON CONFLICT (...) DO NOTHING`, via `tx.$executeRaw`. This
standard-SQL clause is supported identically by SQLite (3.24+) and
Postgres, genuinely never throws on conflict (so a same-transaction
follow-up read is always safe), and the returned row count (1 = we
inserted, 0 = conflict) replaces the old catch-block's role. Applied to
all 5 call sites that had this pattern: `chargeCapture.ts#createChargeIfNotExists`,
`payments.ts#recordPayment`, `refunds.ts#requestRefund`,
`billingAccount.ts#getOrCreateBillingAccount`, `sequence.ts#nextSequence`'s
row-ensure-exists step (the last two don't fail idempotency directly, but
inherited the same "empty upsert can still throw" risk, and a thrown
error there would have surfaced as an uncaught failure on the
invoice/claim-numbering path under load).

**One more subtlety found while fixing this**: `Payment.method` is a
native Postgres enum column. A `${}` bind parameter in `$executeRaw`
carries an explicit type (text), and Postgres refuses to implicitly cast
a *parameter* to a custom enum type in an INSERT (error 42804) — even
though it happily accepts an unqualified string *literal* like `'CASH'`
in the same position. Fixed by injecting `method` via `Prisma.raw()`
instead of `${}`, safe because `input.method: PaymentMethod` is a closed
TypeScript enum (not user-supplied free text), with a runtime
`Object.values(PaymentMethod).includes(...)` check as defense in depth
against a future refactor loosening that type. `Charge.category` is a
plain `String` (not an enum) and doesn't have this issue.

**Verification**: all 3 fixed functions plus the 2 upsert-pattern
call sites were re-verified against both a live Postgres 16 instance
(genuine concurrency, `scripts/verify-postgres-billing-concurrency.ts`,
8/8 passing) and SQLite (sequential live HTTP smoke test — idempotent
retry returns `alreadyExisted: true`, enum values round-trip correctly)
before this phase was considered complete.

## Facility/tenant scoping of shared counters

`InvoiceSequence` is keyed `(facilityId, fiscalYear)` — two facilities
issuing invoices concurrently never contend for the same counter row, and
concurrent issuance of two *different* invoices within the same facility
correctly get distinct numbers (verified in the concurrency script).
