-- Week 4b (4a follow-up a): image pages are normalized before OCR. The record
-- of what was done (EXIF orientation, deskew, resize, compression) is kept on
-- the derived page. Additive: existing pages keep NULL (they were copies).

-- AlterTable
ALTER TABLE "DocumentPage" ADD COLUMN "normalization" JSONB;
