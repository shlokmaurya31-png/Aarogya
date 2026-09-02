-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "city" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InstitutionDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    CONSTRAINT "InstitutionDomain_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cohort_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CohortMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cohortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CohortMembership_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CohortMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StudentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fullLegalName" TEXT NOT NULL,
    "preferredName" TEXT,
    "institutionId" TEXT,
    "institutionNameFreeText" TEXT,
    "course" TEXT NOT NULL,
    "learningTrack" TEXT NOT NULL,
    "specialization" TEXT,
    "academicYear" INTEGER NOT NULL,
    "enrollmentYear" INTEGER NOT NULL,
    "expectedGraduation" INTEGER NOT NULL,
    "studentIdentifier" TEXT,
    "institutionEmail" TEXT,
    "currentRotation" TEXT,
    "clinicalInterests" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verificationMethod" TEXT,
    "verifiedAt" DATETIME,
    "expiresAt" DATETIME,
    "streakDays" INTEGER NOT NULL DEFAULT 0,
    "clinicalXp" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StudentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StudentProfile_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentProfileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,
    CONSTRAINT "VerificationDocument_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClinicalCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "subspecialty" TEXT,
    "difficulty" TEXT NOT NULL,
    "acuity" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'SYNTHETIC',
    "learnerTracks" TEXT NOT NULL,
    "patientName" TEXT NOT NULL,
    "patientAgeBand" TEXT NOT NULL,
    "patientAgeExact" INTEGER,
    "patientSex" TEXT NOT NULL,
    "chiefComplaint" TEXT NOT NULL,
    "learningObjectives" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "referenceDx" TEXT NOT NULL,
    "rubric" JSONB NOT NULL,
    "viva" JSONB NOT NULL,
    "authorId" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClinicalCase_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaseAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'PRACTICE',
    "stage" TEXT NOT NULL DEFAULT 'TRIAGE',
    "revealedState" JSONB NOT NULL,
    "differential" JSONB,
    "diagnosis" TEXT,
    "managementPlan" JSONB,
    "prescriptions" JSONB,
    "hintsUsed" INTEGER NOT NULL DEFAULT 0,
    "score" JSONB,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    CONSTRAINT "CaseAttempt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClinicalCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CaseAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaseAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scoreDelta" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseAction_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CaseAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StudentCompetency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StudentCompetency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "StudentAchievement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StudentAchievement_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "Achievement" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotebookEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "specialty" TEXT,
    "caseId" TEXT,
    "tags" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotebookEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearningRecommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "caseIds" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cohortId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "dueAt" DATETIME,
    "minScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Assignment_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Assignment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ClinicalCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssignmentSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptId" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssignmentSubmission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AssignmentSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionDomain_domain_key" ON "InstitutionDomain"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "CohortMembership_cohortId_userId_key" ON "CohortMembership"("cohortId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_userId_key" ON "StudentProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalCase_slug_key" ON "ClinicalCase"("slug");

-- CreateIndex
CREATE INDEX "ClinicalCase_specialty_idx" ON "ClinicalCase"("specialty");

-- CreateIndex
CREATE INDEX "ClinicalCase_difficulty_idx" ON "ClinicalCase"("difficulty");

-- CreateIndex
CREATE INDEX "CaseAttempt_studentId_idx" ON "CaseAttempt"("studentId");

-- CreateIndex
CREATE INDEX "CaseAttempt_caseId_idx" ON "CaseAttempt"("caseId");

-- CreateIndex
CREATE INDEX "CaseAction_attemptId_idx" ON "CaseAction"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentCompetency_userId_domain_key" ON "StudentCompetency"("userId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "Achievement_code_key" ON "Achievement"("code");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAchievement_userId_achievementId_key" ON "StudentAchievement"("userId", "achievementId");

-- CreateIndex
CREATE INDEX "AuditEvent_type_idx" ON "AuditEvent"("type");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_idx" ON "AuditEvent"("userId");
