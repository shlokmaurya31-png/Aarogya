-- Week 4c (4b follow-up a): PDF pages are read from their embedded text layer
-- when it is usable, and rasterized (then OCR'd) when it is empty or garbage.
-- Additive: existing pages keep NULL (they predate the check and are OCR'd as
-- before); nothing is guessed for them.

-- CreateEnum
CREATE TYPE "PdfTextLayer" AS ENUM ('USABLE', 'EMPTY', 'GARBAGE');

-- AlterTable
ALTER TABLE "DocumentPage" ADD COLUMN "textLayer" "PdfTextLayer",
ADD COLUMN "rasterRef" TEXT,
ADD COLUMN "rasterSha256" TEXT;
