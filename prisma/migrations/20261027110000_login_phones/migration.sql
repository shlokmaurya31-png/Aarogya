-- Week 5b follow-up: verified phones for staff and doctor logins, so the
-- same-human check (a doctor's own record) matches phones as well as the
-- login email. Additive: a new table and enum; nothing existing changes.
-- CreateEnum
CREATE TYPE "LoginPhoneStatus" AS ENUM ('PENDING', 'VERIFIED', 'REMOVED');

-- CreateTable
CREATE TABLE "LoginPhone" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "LoginPhoneStatus" NOT NULL DEFAULT 'PENDING',
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginPhone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginPhone_userId_status_idx" ON "LoginPhone"("userId", "status");

-- CreateIndex
CREATE INDEX "LoginPhone_phone_status_idx" ON "LoginPhone"("phone", "status");
