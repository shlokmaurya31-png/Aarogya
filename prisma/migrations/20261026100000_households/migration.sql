-- Week 5b: households (docs/HOUSEHOLD_DESIGN.md §14). Additive: new person-scoped
-- models, Person.managedByHousehold and PatientProvidedRecord.confirmedByProxy
-- (false for every existing row), new enum values.
-- CreateEnum
CREATE TYPE "HouseholdStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "HouseholdMemberType" AS ENUM ('SELF', 'MANAGED_MINOR', 'DEPENDENT_ADULT', 'LINKED_ADULT');

-- CreateEnum
CREATE TYPE "HouseholdRole" AS ENUM ('MANAGER', 'MEMBER');

-- CreateEnum
CREATE TYPE "HouseholdMemberStatus" AS ENUM ('INVITED', 'PENDING_CONSENT', 'ACTIVE', 'AWAITING_CLAIM', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "ProxyBasis" AS ENUM ('GUARDIAN', 'RECORDED_CONSENT', 'MEMBER_CHOICE');

-- CreateEnum
CREATE TYPE "ProxyPermission" AS ENUM ('VIEW', 'UPLOAD', 'BOOK', 'SHARE', 'INSURANCE', 'USE_AI');

-- CreateEnum
CREATE TYPE "ProxyGrantStatus" AS ENUM ('PENDING_CONFIRMATION', 'ACTIVE', 'REVOKED', 'LAPSED');

-- CreateEnum
CREATE TYPE "DependentConsentMethod" AS ENUM ('OWN_CODE', 'TWO_STAFF_IN_PERSON', 'LEGAL_DOCUMENT');

-- CreateEnum
CREATE TYPE "DependentConsentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REFUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MemberClaimMethod" AS ENUM ('OWN_CONTACT', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "MemberClaimStatus" AS ENUM ('OPEN', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PersonAccessLogKind" ADD VALUE 'PROXY_GRANT_CHANGED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'PROXY_ACTION';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCOUNT_CLAIMED';

-- AlterEnum
ALTER TYPE "PersonNotificationKind" ADD VALUE 'COMING_OF_AGE';

-- AlterTable
ALTER TABLE "PatientProvidedRecord" ADD COLUMN     "confirmedByProxy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "managedByHousehold" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByPersonId" TEXT NOT NULL,
    "status" "HouseholdStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMember" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "memberType" "HouseholdMemberType" NOT NULL,
    "role" "HouseholdRole" NOT NULL,
    "status" "HouseholdMemberStatus" NOT NULL,
    "relationship" TEXT,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyGrant" (
    "id" TEXT NOT NULL,
    "memberPersonId" TEXT NOT NULL,
    "proxyPersonId" TEXT NOT NULL,
    "householdId" TEXT,
    "basis" "ProxyBasis" NOT NULL,
    "permissions" "ProxyPermission"[],
    "categories" "ShareCategory"[],
    "sensitiveCategories" "RagSensitiveCategory"[] DEFAULT ARRAY[]::"RagSensitiveCategory"[],
    "status" "ProxyGrantStatus" NOT NULL,
    "grantedByPersonId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "validUntil" TIMESTAMP(3),
    "lapsedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ProxyGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependentConsent" (
    "id" TEXT NOT NULL,
    "memberPersonId" TEXT NOT NULL,
    "proxyPersonId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "method" "DependentConsentMethod" NOT NULL,
    "status" "DependentConsentStatus" NOT NULL DEFAULT 'PENDING',
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "firstStaffUserId" TEXT,
    "secondStaffUserId" TEXT,
    "facilityId" TEXT,
    "documentId" TEXT,
    "reviewedByUserId" TEXT,
    "documentKind" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DependentConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParentalConsent" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "parentPersonId" TEXT NOT NULL,
    "minorPersonId" TEXT,
    "minorDisplayName" TEXT NOT NULL,
    "minorDateOfBirth" TIMESTAMP(3) NOT NULL,
    "minorSex" TEXT,
    "relationship" TEXT NOT NULL,
    "phoneLast4" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "declarationText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentalConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberClaim" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "method" "MemberClaimMethod" NOT NULL,
    "status" "MemberClaimStatus" NOT NULL DEFAULT 'OPEN',
    "contactKind" TEXT,
    "contactValue" TEXT,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "verifiedByStaffUserId" TEXT,
    "claimedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemberClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HouseholdMember_personId_status_idx" ON "HouseholdMember"("personId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdMember_householdId_personId_key" ON "HouseholdMember"("householdId", "personId");

-- CreateIndex
CREATE INDEX "ProxyGrant_memberPersonId_status_idx" ON "ProxyGrant"("memberPersonId", "status");

-- CreateIndex
CREATE INDEX "ProxyGrant_proxyPersonId_status_idx" ON "ProxyGrant"("proxyPersonId", "status");

-- CreateIndex
CREATE INDEX "DependentConsent_memberPersonId_status_idx" ON "DependentConsent"("memberPersonId", "status");

-- CreateIndex
CREATE INDEX "ParentalConsent_parentPersonId_idx" ON "ParentalConsent"("parentPersonId");

-- CreateIndex
CREATE INDEX "MemberClaim_personId_status_idx" ON "MemberClaim"("personId", "status");

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A grant names at least one permission and one category; a proxy never acts for themselves.
ALTER TABLE "ProxyGrant" ADD CONSTRAINT "ProxyGrant_permissions_check" CHECK (cardinality("permissions") >= 1);
ALTER TABLE "ProxyGrant" ADD CONSTRAINT "ProxyGrant_categories_check" CHECK (cardinality("categories") >= 1);
ALTER TABLE "ProxyGrant" ADD CONSTRAINT "ProxyGrant_not_self_check" CHECK ("memberPersonId" <> "proxyPersonId");
-- One live grant per member and proxy.
CREATE UNIQUE INDEX "ProxyGrant_one_live" ON "ProxyGrant"("memberPersonId", "proxyPersonId") WHERE "status" IN ('ACTIVE', 'PENDING_CONFIRMATION');
