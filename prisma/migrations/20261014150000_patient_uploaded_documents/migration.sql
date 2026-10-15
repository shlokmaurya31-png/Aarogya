-- DropForeignKey
ALTER TABLE "ClinicalDocument" DROP CONSTRAINT "ClinicalDocument_uploadedByStaffId_fkey";

-- AlterTable
ALTER TABLE "ClinicalDocument" ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "uploadedByUserId" TEXT,
ALTER COLUMN "uploadedByStaffId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_uploadedByStaffId_fkey" FOREIGN KEY ("uploadedByStaffId") REFERENCES "HospitalStaffProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one uploader: a staff member or the patient's own account.
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_one_uploader" CHECK (
  ("uploadedByStaffId" IS NOT NULL AND "uploadedByUserId" IS NULL) OR
  ("uploadedByStaffId" IS NULL AND "uploadedByUserId" IS NOT NULL)
);
