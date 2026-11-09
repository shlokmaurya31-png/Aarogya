-- Flagship 3d fix: the bulk lane. A legacy import's row events are dispatched
-- after every waiting live event, so an import never delays a live one (found
-- when a 50,000-row import held back later events in verify:all). Additive:
-- every existing event is in the live lane (false), as before.

-- AlterTable
ALTER TABLE "DomainEventOutbox" ADD COLUMN     "bulk" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "DomainEventOutbox_status_bulk_seq_idx" ON "DomainEventOutbox"("status", "bulk", "seq");
