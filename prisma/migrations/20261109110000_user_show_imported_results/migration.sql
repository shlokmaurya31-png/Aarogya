-- Flagship 4b: "show imported" in the chart timeline, per user. Additive: one column, off for everyone.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showImportedResults" BOOLEAN NOT NULL DEFAULT false;
