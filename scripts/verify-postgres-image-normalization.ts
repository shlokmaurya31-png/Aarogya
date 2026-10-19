/**
 * Week 4b (4a follow-up a) — page images are normalized before OCR
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §4.1 `doc-page-split`; pre-launch item 13),
 * through the real dispatcher on the mock providers:
 *   - a phone photo stored sideways (EXIF orientation 6) and tilted 5° comes
 *     out upright and level, as a JPEG with no metadata, deterministically;
 *   - an oversized scan is brought down to the maximum edge;
 *   - the upload itself is never touched (same bytes, same sha256), and the
 *     normalized page is stored alongside it with a record of what was done;
 *   - OCR is sent the normalized page, never the original;
 *   - redelivery creates no second page;
 *   - a decompression bomb fails the run (TOO_LARGE) with the original kept;
 *   - a scanned PDF page keeps its single-page copy and gains a normalized
 *     raster alongside, which is what OCR reads (Week 4c; the scanned-pdf
 *     gate covers text layers and mixed PDFs).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-image-normalization.ts
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { getStorageAdapter } from "../src/lib/storage";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { getDocumentProviders, mockControl, setDocumentProvidersForTest, type DocumentProviders } from "../src/lib/ai/documents";
import { pageSplitStep } from "../src/lib/documents/pipeline";
import { NORMALIZATION, normalizePageImage, type Normalization } from "../src/lib/documents/normalize";
import { uploadPersonDocument } from "../src/lib/person/documents";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const tag = Date.now().toString(36);
let seq = 0;
let clock = Date.now();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

async function person() {
  seq += 1;
  const a = await registerPatientAccount({ fullName: `Normalize ${tag} ${seq}`, email: `docnorm-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1985-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
  return { userId: a.userId, personId };
}

/** A page of dark bars where text lines would be. */
async function barsPage(w: number, h: number): Promise<Buffer> {
  const rows = Math.floor((h - 200) / 45);
  const rects = Array.from({ length: rows }, (_, i) => `<rect x="${100 + (i % 3) * 40}" y="${120 + i * 45}" width="${Math.min(w - 300, 700 + ((i * 37) % 250))}" height="14" fill="#222"/>`).join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/>${rects}</svg>`)).png().toBuffer();
}

const runOf = (documentId: string) => prisma.documentProcessing.findFirst({ where: { documentId }, include: { steps: true, pages: true } });
const stepStatus = (r: { steps: { step: string; status: string }[] } | null, step: string) => r?.steps.find((s) => s.step === step)?.status;

async function main() {
  registerAllConsumers();
  const storage = getStorageAdapter();
  const mocks = getDocumentProviders({});
  const seen: { contentType: string; sha: string }[] = [];
  const recording: DocumentProviders = {
    ...mocks,
    ocr: { id: "mock", async ocrPage(page, hints, permit) { seen.push({ contentType: page.contentType, sha: sha(page.bytes) }); return mocks.ocr.ocrPage(page, hints, permit); } },
  };
  setDocumentProvidersForTest(recording);

  // 1. A phone photo: stored sideways (EXIF 6) and tilted 5°.
  const p1 = await person();
  const upright = await barsPage(1200, 1600);
  const tilted = await sharp(upright).rotate(5, { background: "white" }).toBuffer();
  const photo = await sharp(await sharp(tilted).rotate(-90).toBuffer()).jpeg({ quality: 90 }).withMetadata({ orientation: 6, exif: { IFD0: { Make: "SyntheticCam", Model: "Gate" } } }).toBuffer();
  const expected = await normalizePageImage(photo);
  if (typeof expected === "string") throw new Error(`normalize: ${expected}`);
  // The OCR mock reads this page as the fixture rx-en-1 (looked up by the normalized page's sha256).
  mockControl.imagePages.set(sha(expected.bytes), "rx-en-1#1");
  const d1 = await uploadPersonDocument(p1.userId, { bytes: photo, contentType: "image/jpeg", originalName: "photo.jpg", title: "Prescription photo", type: "REPORT" });
  await drain();
  const r1 = await runOf(d1.id);
  const page1 = r1?.pages[0];
  const n1 = page1?.normalization as unknown as Normalization | null;
  report("The photo runs through page split and OCR to review", stepStatus(r1, "PAGE_SPLIT") === "DONE" && stepStatus(r1, "OCR") === "DONE" && r1?.status === "AWAITING_REVIEW", r1?.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  report("One page, a JPEG stored alongside the original (a different object)", r1?.pages.length === 1 && page1?.contentType === "image/jpeg" && page1.storageRef !== d1.storageRef);
  report("EXIF orientation 6 applied: the page is upright (portrait)", n1?.exifOrientation === 6 && n1.output.height > n1.output.width, JSON.stringify(n1?.output));
  report("The 5° tilt measured and undone", !!n1 && Math.abs(n1.deskewDegrees + 5) <= 0.5, `deskew ${n1?.deskewDegrees}`);
  const pageBytes = page1 ? (await storage.get(page1.storageRef)).bytes : Buffer.alloc(0);
  const pageMeta = await sharp(pageBytes).metadata();
  report("The stored page carries no metadata (no camera, time or GPS tags)", pageMeta.exif === undefined && pageMeta.orientation === undefined && pageMeta.format === "jpeg");
  report("Normalization is deterministic: the stored page is exactly the expected bytes", page1?.sha256 === sha(expected.bytes) && sha(pageBytes) === page1?.sha256);
  const original = await storage.get(d1.storageRef);
  const doc1 = await prisma.personDocument.findUniqueOrThrow({ where: { id: d1.id } });
  report("The upload is untouched: same bytes, same sha256, still CURRENT", sha(original.bytes) === sha(photo) && doc1.sha256 === sha(photo) && doc1.status === "CURRENT");
  report("OCR was sent the normalized page, never the original", seen.length >= 1 && seen.every((s) => s.contentType === "image/jpeg" && s.sha === page1?.sha256) && !seen.some((s) => s.sha === sha(photo)));
  report("Page split recorded sharp as its provider", r1?.steps.find((s) => s.step === "PAGE_SPLIT")?.provider === "sharp");
  const facts = await prisma.extractedFact.count({ where: { processingId: r1!.id } });
  report("Facts were extracted from the normalized page", facts > 0, `${facts} facts`);
  await pageSplitStep(r1!.id);
  report("Redelivery creates no second page", (await prisma.documentPage.count({ where: { processingId: r1!.id } })) === 1);

  // 2. An oversized scan.
  const big = await sharp(await barsPage(1200, 1600)).resize(4800, 6400).png({ compressionLevel: 9 }).toBuffer();
  const d2 = await uploadPersonDocument(p1.userId, { bytes: big, contentType: "image/png", originalName: "scan.png", title: "Big scan", type: "REPORT" });
  await drain();
  const r2 = await runOf(d2.id);
  const n2 = r2?.pages[0]?.normalization as unknown as Normalization | null;
  report("An oversized scan (4800×6400) is brought down to the 2,400 px edge, as a smaller JPEG",
    !!n2 && n2.resized && Math.max(n2.output.width, n2.output.height) === NORMALIZATION.maxEdge && n2.input.width === 4800 && r2?.pages[0].contentType === "image/jpeg" && n2.output.bytes < big.length,
    JSON.stringify(n2?.output));
  report("…its upload is untouched", sha((await storage.get(d2.storageRef)).bytes) === sha(big));

  // 3. A decompression bomb: refused, the original kept.
  const bomb = await sharp({ create: { width: 10000, height: 10000, channels: 3, background: "white" } }).png({ compressionLevel: 9 }).toBuffer();
  const d3 = await uploadPersonDocument(p1.userId, { bytes: bomb, contentType: "image/png", originalName: "bomb.png", title: "Huge", type: "REPORT" });
  await drain();
  const r3 = await runOf(d3.id);
  const failed = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: r3?.id, eventType: "DocumentProcessingFailed" } });
  report("A 100-megapixel image fails page split with TOO_LARGE", r3?.status === "FAILED" && r3.steps.find((s) => s.step === "PAGE_SPLIT")?.lastErrorCode === "TOO_LARGE" && (failed?.payload as { errorCode?: string })?.errorCode === "TOO_LARGE");
  report("…no page stored, the original kept as uploaded", r3?.pages.length === 0 && (await prisma.personDocument.findUniqueOrThrow({ where: { id: d3.id } })).status === "CURRENT" && sha((await storage.get(d3.storageRef)).bytes) === sha(bomb));

  // 4. A scanned PDF page: split page by page, then rasterized and normalized for OCR.
  const pdf = await fixturePdf(fixtureById("lab-en-cbc")!);
  const d4 = await uploadPersonDocument(p1.userId, { bytes: pdf, contentType: "application/pdf", originalName: "r.pdf", title: "PDF", type: "REPORT" });
  await drain();
  const r4 = await runOf(d4.id);
  const p4 = r4?.pages[0];
  const n4 = p4?.normalization as unknown as Normalization | null;
  const raster4 = p4?.rasterRef ? (await storage.get(p4.rasterRef)).bytes : Buffer.alloc(0);
  report("A scanned PDF page is a single-page PDF with a normalized JPEG raster alongside",
    r4?.pages.length === 1 && p4?.contentType === "application/pdf" && p4.textLayer === "EMPTY" && !!p4.rasterRef && p4.rasterRef !== p4.storageRef
      && sha(raster4) === p4.rasterSha256 && (await sharp(raster4).metadata()).format === "jpeg" && !!n4 && n4.output.height > n4.output.width
      && r4?.steps.find((s) => s.step === "PAGE_SPLIT")?.provider === "pdf-lib+pdf.js",
    JSON.stringify({ textLayer: p4?.textLayer, raster: !!p4?.rasterRef, out: n4?.output }));
  report("…OCR was sent the raster", seen.some((s) => s.contentType === "image/jpeg" && s.sha === p4?.rasterSha256));

  setDocumentProvidersForTest(null);
  mockControl.reset();
  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
