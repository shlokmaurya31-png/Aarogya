# SaaS billing — architecture overview (Phase D3)

The commercial billing domain: how Aarogya charges an organization for its
subscription and keeps its commercial truth. Aarogya owns all domain state; an
external payment provider only executes payment and maps back via opaque
references.

## The canonical model

```
Organization
  └─ OrganizationBillingAccount        (one per org; billing identity + currency)
SubscriptionPlan ─ PlanPrice           (authoritative, effective-dated pricing)
OrganizationSubscription (D2)
  └─ BillingPeriod                      (one per cycle; unique per period start)
       └─ BillingInvoice                (one per period; server-computed amounts)
            ├─ BillingInvoiceLine[]     (immutable after finalize)
            ├─ BillingPaymentAttempt[]  (may fail)
            │    └─ BillingPayment      (succeeded money; idempotent)
            │         └─ BillingRefund[](bounded, idempotent)
            └─ BillingCredit[]          (platform-granted; applied to DRAFT)
BillingWebhookEvent                     (verified, idempotent provider events)
BillingReconciliationException          (detected Aarogya↔provider divergences)
```

Every amount is an integer minor unit (paise). Money is defined in
`src/lib/billing/money.ts`, deliberately separate from the hospital revenue
cycle's identical-but-independent `money.ts`.

## Strict domain separation

D3 never touches the hospital revenue cycle (`BillingAccount` / `Invoice` /
`Payment` / `Refund` / `Payer` / `Claim`), which bills patients and insurers.
Every SaaS model is prefixed (`Billing*` / `OrganizationBilling*` / `PlanPrice`)
and lives under `src/lib/billing/`. Permissions are the D2 `commercial:*` set;
no `billing:*` (hospital) permission is reused.

## Authorization

- Reads: `commercial:read`, tenant-scoped (`assertOrganizationAccess`) — an org
  admin sees only their own billing state.
- Contact edits on the billing account: organization administrator (self-service),
  but the billing **currency** is platform-only.
- Every other financial mutation (renew, finalize/void invoice, record payment,
  refund, issue/apply credit, map provider, process webhook, reconcile) is
  **platform-only** (`commercial:platform:manage`). No self-charge, self-credit,
  self-refund or self-void.

## Integration with D1 / D2

- **D1**: every billing object is tenant-scoped; the organization is server-
  resolved, never taken from the client.
- **D2**: D2 remains authoritative for commercial state. Renewal advances the
  subscription period and cures dunning through the explicit
  `applyPaidRenewal` service boundary; a failed payment moves the subscription
  along D2's declared transitions. D3 never mutates `OrganizationSubscription`
  from a route directly.

See: [billing-accounts](billing-accounts.md), [invoicing](invoicing.md),
[payments](payments.md), [refunds](refunds.md),
[provider-boundary](provider-boundary.md), [webhooks](webhooks.md),
[reconciliation](reconciliation.md), [d3-security-model](d3-security-model.md),
[d3-readiness](d3-readiness.md).
