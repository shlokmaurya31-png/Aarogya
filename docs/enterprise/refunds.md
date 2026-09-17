# Refunds (Phase D3)

`BillingRefund` references the original `BillingPayment` and never mutates it in
place. Platform-only.

- **Bounded**: a refund cannot exceed the payment's un-refunded balance. The
  payment `refundedMinor` is a guarded running total, incremented by an atomic
  conditional `UPDATE` (`refundedMinor + amt <= amountMinor`). Concurrent full
  refunds with different keys → exactly one applies, never over-refunded (proven).
- **Idempotent** on `idempotencyKey` (raw `INSERT … ON CONFLICT DO NOTHING`);
  the same key twice yields one refund row and applies once.
- **Tenant-safe**: the refund's `organizationId` is taken from the payment, and
  the payment is looked up by id — a cross-tenant refund is not expressible.
- Full and partial refunds are supported; the payment status moves to
  `PARTIALLY_REFUNDED` or `REFUNDED` accordingly.
