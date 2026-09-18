# D5 — financial reporting

Server-generated, platform-only, canonical-data reports (JSON + CSV export):

- revenue — per (organization, currency): invoiced, collected, refunded,
  credited, outstanding.
- ar_aging — per open invoice: organization, invoice, currency, outstanding, age
  (days since dueAt), bucket, dueAt.
- payments — per payment in period: organization, invoice, amount, refunded,
  currency, status, provider, succeededAt.
- reconciliation — per exception: kind, severity, status, source, provider,
  detected/resolved timestamps.

Date semantics (all reports): UTC, half-open [from, to); invoices by finalizedAt,
payments by succeededAt, refunds/credits by createdAt, outstanding is current.
Amounts are integer minor units with an explicit currency column — currencies are
never merged. CSV escaping is deterministic. No secrets, no raw webhook payloads,
no card data. Report generation is audited. Ranges are bounded server-side.
