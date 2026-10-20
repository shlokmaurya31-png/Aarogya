-- 4c answers: what the person is told about access to their record (daily summary,
-- break-glass, a waiting request). Additive; nothing is backfilled.
-- CreateEnum
CREATE TYPE "PersonNotificationKind" AS ENUM ('ACCESS_SUMMARY', 'BREAK_GLASS_ACCESS', 'ACCESS_REQUESTED');

-- CreateEnum
CREATE TYPE "PersonNotificationStatus" AS ENUM ('PENDING', 'SENT', 'NO_CHANNEL', 'FAILED');

-- CreateTable
CREATE TABLE "PersonNotification" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "PersonNotificationKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "detail" JSONB,
    "status" "PersonNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "channel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PersonNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonNotification_dedupeKey_key" ON "PersonNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "PersonNotification_personId_createdAt_idx" ON "PersonNotification"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "PersonNotification_status_idx" ON "PersonNotification"("status");

-- AddForeignKey
ALTER TABLE "PersonNotification" ADD CONSTRAINT "PersonNotification_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

