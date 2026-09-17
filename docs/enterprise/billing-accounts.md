# Billing accounts (Phase D3)

`OrganizationBillingAccount` is the one canonical SaaS billing identity per
organization (`organizationId` unique). It holds only safe identifiers — billing
name, billing email, address, tax id (GSTIN), currency, status, and an OPAQUE
provider customer reference. It NEVER stores a card number, CVV, bank credential
or provider secret; payment instruments live entirely with the provider.

- Created idempotently (`getOrCreateBillingAccount`, raw `INSERT … ON CONFLICT
  DO NOTHING`) by the billing bootstrap and lazily by invoice generation.
- Currency is server-authoritative (default `INR`); a client can never change it.
  Contact fields are editable by an organization administrator (self-service);
  the currency is platform-only.
- Bootstrap sets `billingEmail` to blank ("not set") rather than inventing one.

Reads are tenant-scoped; a caller must have standing in the organization.
