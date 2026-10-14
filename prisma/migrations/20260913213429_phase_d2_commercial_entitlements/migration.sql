-- Phase D2 — SaaS commercial layer (PostgreSQL).
-- Mirrors prisma/migrations/20260913213429_phase_d2_commercial_entitlements.
--
-- Strictly additive: seven new tables + five new enum types. No DROP, no
-- DELETE, no TRUNCATE, no retype, no change to any existing table. On
-- PostgreSQL, Prisma enums are native enum TYPES (the SQLite tree uses TEXT,
-- correct for SQLite); they are created before the columns that use them.
--
-- Longest identifier is OrgEntitlementOverride_org_ent_key (explicitly named in
-- the schema because the generated name would be 64 chars, over the 63-char
-- limit). Every other name is comfortably under 63.
--
-- No business data is seeded here. Every organization is given an explicit
-- commercial state by the idempotent ensureCommercialBootstrap() function
-- (src/lib/commercial/bootstrap.ts), documented in docs/enterprise/commercial-model.md.
-- Foreign keys are declared after every table exists so a replay from zero is safe.

-- CreateEnum
CREATE TYPE "SubscriptionPlanStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'RETIRED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY', 'NONE');
CREATE TYPE "EntitlementType" AS ENUM ('BOOLEAN', 'LIMIT', 'NUMBER');
CREATE TYPE "EntitlementScope" AS ENUM ('ORGANIZATION', 'FACILITY');

-- CreateTable
CREATE TABLE "EntitlementDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "EntitlementType" NOT NULL,
    "scope" "EntitlementScope" NOT NULL,
    "defaultBool" BOOLEAN,
    "defaultNumber" INTEGER,
    "defaultUnlimited" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "SubscriptionPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanEntitlement" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "numberValue" INTEGER,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "trialStartedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEntitlement" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "numberValue" INTEGER,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationEntitlementOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "numberValue" INTEGER,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationEntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityEntitlementOverride" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "boolValue" BOOLEAN,
    "numberValue" INTEGER,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityEntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EntitlementDefinition_key_key" ON "EntitlementDefinition"("key");
CREATE INDEX "EntitlementDefinition_scope_idx" ON "EntitlementDefinition"("scope");
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");
CREATE INDEX "SubscriptionPlan_status_idx" ON "SubscriptionPlan"("status");
CREATE INDEX "PlanEntitlement_entitlementId_idx" ON "PlanEntitlement"("entitlementId");
CREATE UNIQUE INDEX "PlanEntitlement_planId_entitlementId_key" ON "PlanEntitlement"("planId", "entitlementId");
CREATE UNIQUE INDEX "OrganizationSubscription_organizationId_key" ON "OrganizationSubscription"("organizationId");
CREATE INDEX "OrganizationSubscription_status_idx" ON "OrganizationSubscription"("status");
CREATE INDEX "OrganizationSubscription_planId_idx" ON "OrganizationSubscription"("planId");
CREATE INDEX "SubscriptionEntitlement_entitlementId_idx" ON "SubscriptionEntitlement"("entitlementId");
CREATE UNIQUE INDEX "SubscriptionEntitlement_subscriptionId_entitlementId_key" ON "SubscriptionEntitlement"("subscriptionId", "entitlementId");
CREATE INDEX "OrganizationEntitlementOverride_entitlementId_idx" ON "OrganizationEntitlementOverride"("entitlementId");
CREATE UNIQUE INDEX "OrgEntitlementOverride_org_ent_key" ON "OrganizationEntitlementOverride"("organizationId", "entitlementId");
CREATE INDEX "FacilityEntitlementOverride_entitlementId_idx" ON "FacilityEntitlementOverride"("entitlementId");
CREATE UNIQUE INDEX "FacilityEntitlementOverride_facilityId_entitlementId_key" ON "FacilityEntitlementOverride"("facilityId", "entitlementId");

-- AddForeignKey
ALTER TABLE "PlanEntitlement" ADD CONSTRAINT "PlanEntitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanEntitlement" ADD CONSTRAINT "PlanEntitlement_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EntitlementDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EntitlementDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationEntitlementOverride" ADD CONSTRAINT "OrganizationEntitlementOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationEntitlementOverride" ADD CONSTRAINT "OrganizationEntitlementOverride_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EntitlementDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FacilityEntitlementOverride" ADD CONSTRAINT "FacilityEntitlementOverride_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FacilityEntitlementOverride" ADD CONSTRAINT "FacilityEntitlementOverride_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EntitlementDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
