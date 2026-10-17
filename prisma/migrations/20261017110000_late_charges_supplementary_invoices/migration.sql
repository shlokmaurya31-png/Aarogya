-- Batch 5, decision 2: a charge that arrives after its encounter's invoice is
-- issued is recorded as a normal charge marked late, and collected on a
-- supplementary document linked to the original (issued invoices are never
-- edited). The document type is a facility configuration key
-- (billing.late_charge.document_type: SUPPLEMENTARY_INVOICE | DEBIT_NOTE).
-- Additive: every existing invoice is an INVOICE with no link.

CREATE TYPE "InvoiceDocumentType" AS ENUM ('INVOICE', 'SUPPLEMENTARY_INVOICE', 'DEBIT_NOTE');

ALTER TABLE "Charge" ADD COLUMN "isLate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Invoice"
  ADD COLUMN "documentType" "InvoiceDocumentType" NOT NULL DEFAULT 'INVOICE',
  ADD COLUMN "supplementsInvoiceId" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplementsInvoiceId_fkey"
  FOREIGN KEY ("supplementsInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Invoice_supplementsInvoiceId_idx" ON "Invoice"("supplementsInvoiceId");

-- An original invoice links to nothing; a supplementary document always links to its original.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplement_link_check"
  CHECK (("documentType" = 'INVOICE') = ("supplementsInvoiceId" IS NULL));

-- Bug fix found here: invoice and claim numbers come from a per-(facility,
-- year) sequence (InvoiceSequence) but were unique across ALL facilities, so
-- the first invoice or claim a second facility issued in a year
-- ("INV-2026-000001" again) failed. They are unique per facility. Existing
-- numbers are globally unique, so they satisfy the narrower constraint.
DROP INDEX "Invoice_invoiceNumber_key";
CREATE UNIQUE INDEX "Invoice_facilityId_invoiceNumber_key" ON "Invoice"("facilityId", "invoiceNumber");
DROP INDEX "Claim_claimNumber_key";
CREATE UNIQUE INDEX "Claim_facilityId_claimNumber_key" ON "Claim"("facilityId", "claimNumber");
