# D5 — security model

Reuses the existing stack: D1 tenant context, D2 commercial permissions
(commercial:read / commercial:platform:manage), C4 authorization, audit. No new
authorization system.

- Authorization happens BEFORE any resource lookup (authenticate → resolve tenant
  → authorize → scope → query), preventing cross-tenant enumeration.
- Tenant isolation: org-scoped views (AR, aging, failures, collection activity,
  org exceptions) require standing in the organization; cross-org requests are
  404-shaped. Verified for org-admin and outsider against another org's data.
- Platform isolation: overview, MRR/ARR, platform collections, reconciliation
  dashboard, leakage, provider health and reports are platform-only (403 for org
  admins).
- Primarily a read/operational layer. D5 endpoints CANNOT fabricate a payment,
  refund, credit, invoice or balance. The only mutations are collection notes and
  exception/finding triage — none of which change canonical money.
- Mass-assignment safe: zod-validated inputs; organizationId, amounts, balances,
  statuses, severity, resolver and provider fields are never client-authoritative.
- No secrets, raw payloads, or provider credentials are ever returned or logged.

Adversarial + concurrency coverage: scripts/verify-postgres-d5-commercial.ts
(tenant isolation, platform authorization, deterministic AR/aging, leakage +
idempotency, triage-without-money-change, concurrent resolution/detection).
