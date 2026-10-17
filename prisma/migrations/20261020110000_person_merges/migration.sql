-- Phase 0, part 2 (b): merges. A facility merge carries or refuses Person
-- links and records them (linkSnapshot) so an unmerge restores them exactly.
-- A Person merge needs proof of control of both accounts (the other
-- account's password, then a code to each account's email); staff can never
-- merge Persons. Additive.

CREATE TYPE "PersonMergeRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'FAILED');
CREATE TYPE "PersonMergeMethod" AS ENUM ('BOTH_ACCOUNTS_PROVEN');
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'PERSON_MERGED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'LINK_SUPERSEDED';
ALTER TABLE "PatientMergeRecord" ADD COLUMN     "linkSnapshot" JSONB;
CREATE TABLE "PersonMergeRequest" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "sourcePersonId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "targetCodeHash" TEXT NOT NULL,
    "sourceCodeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "PersonMergeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PersonMergeRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PersonMergeRecord" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "sourcePersonId" TEXT NOT NULL,
    "method" "PersonMergeMethod" NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    CONSTRAINT "PersonMergeRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PersonMergeRequest_personId_status_idx" ON "PersonMergeRequest"("personId", "status");
CREATE UNIQUE INDEX "PersonMergeRecord_requestId_key" ON "PersonMergeRecord"("requestId");
CREATE INDEX "PersonMergeRecord_sourcePersonId_idx" ON "PersonMergeRecord"("sourcePersonId");
ALTER TABLE "PersonMergeRequest" ADD CONSTRAINT "PersonMergeRequest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PersonMergeRequest" ADD CONSTRAINT "PersonMergeRequest_sourcePersonId_fkey" FOREIGN KEY ("sourcePersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PersonMergeRecord" ADD CONSTRAINT "PersonMergeRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PersonMergeRecord" ADD CONSTRAINT "PersonMergeRecord_sourcePersonId_fkey" FOREIGN KEY ("sourcePersonId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One pending merge request per surviving Person at a time.
CREATE UNIQUE INDEX "PersonMergeRequest_one_pending" ON "PersonMergeRequest"("personId") WHERE "status" = 'PENDING';
-- A Person never merges into itself.
ALTER TABLE "PersonMergeRequest" ADD CONSTRAINT "PersonMergeRequest_distinct_check" CHECK ("personId" <> "sourcePersonId");
ALTER TABLE "PersonMergeRecord" ADD CONSTRAINT "PersonMergeRecord_distinct_check" CHECK ("personId" <> "sourcePersonId");
