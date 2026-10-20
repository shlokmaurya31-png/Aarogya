/**
 * Week 4c (4b follow-up a) — scanned and mixed PDFs (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §15.4; pre-launch item 13), through the real dispatcher on the mock providers:
 *   - a scanned-only PDF: every page has no text layer, is rendered with
 *     pdf.js, normalized, stored alongside its single-page PDF, and OCR is
 *     sent that image (never the PDF);
 *   - a mixed PDF (page 1 digital, page 2 scanned): page 1 is read from its
 *     own text layer with no provider call, page 2 is rasterized and OCR'd,
 *     and facts come from both;
 *   - a digital-only PDF calls no OCR at all;
 *   - a page with a garbage text layer (mis-decoded font) is rasterized and
 *     OCR'd instead of trusted;
 *   - the upload is untouched; redelivery adds no page or raster; one
 *     DocumentPagesPrepared per run;
 *   - the account purge removes the derived page objects and rasters too.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-scanned-pdf.ts
 */
import "./lib/gateBootstrap";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { getStorageAdapter } from "../src/lib/storage";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { getDocumentProviders, mockControl, setDocumentProvidersForTest, type DocumentProviders } from "../src/lib/ai/documents";
import { pageSplitStep } from "../src/lib/documents/pipeline";
import { TEXT_LAYER_PROVIDER } from "../src/lib/documents/pdfPages";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { closePersonAccount, purgeClosedPersons } from "../src/lib/person/closure";

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
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

async function person() {
  seq += 1;
  const a = await registerPatientAccount({ fullName: `Scanned ${tag} ${seq}`, email: `scanpdf-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1985-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
  return { userId: a.userId, personId };
}

/** One PDF from the first page of each part (each a fixture PDF, scan-like or digital). */
async function combine(parts: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const b of parts) {
    const [pg] = await out.copyPages(await PDFDocument.load(b), [0]);
    out.addPage(pg);
  }
  return Buffer.from(await out.save());
}

const runOf = (documentId: string) => prisma.documentProcessing.findFirst({ where: { documentId }, include: { steps: true, pages: { orderBy: { pageNo: "asc" } }, texts: { orderBy: { pageNo: "asc" } } } });
const step = (r: { steps: { step: string; status: string; provider: string | null }[] } | null, s: string) => r?.steps.find((x) => x.step === s);

async function main() {
  registerAllConsumers();
  const storage = getStorageAdapter();
  const mocks = getDocumentProviders({});
  const sent: { personId: string; contentType: string; sha: string; hasSource: boolean }[] = [];
  const recording: DocumentProviders = {
    ...mocks,
    ocr: { id: "mock", async ocrPage(page, hints, permit) {
      sent.push({ personId: permit.personId, contentType: page.contentType, sha: sha(page.bytes), hasSource: !!page.sourcePdf });
      return mocks.ocr.ocrPage(page, hints, permit);
    } },
  };
  setDocumentProvidersForTest(recording);
  const sentFor = (personId: string) => sent.filter((s) => s.personId === personId);
  const upload = (userId: string, bytes: Buffer, title: string) => uploadPersonDocument(userId, { bytes, contentType: "application/pdf", originalName: `${title}.pdf`, title, type: "REPORT" });

  const lab = fixtureById("lab-en-cbc")!;
  const rx = fixtureById("rx-en-1")!;

  // 1. A scanned-only PDF (two pages, no text layer).
  const p1 = await person();
  const scanned = await combine([await fixturePdf(lab), await fixturePdf(rx)]);
  const d1 = await upload(p1.userId, scanned, "Scanned");
  await drain();
  const r1 = await runOf(d1.id);
  report("A scanned-only PDF runs through to review", r1?.status === "AWAITING_REVIEW", r1?.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  report("…both pages: no text layer, a single-page PDF plus a raster stored alongside",
    r1?.pages.length === 2 && r1.pages.every((p) => p.textLayer === "EMPTY" && p.contentType === "application/pdf" && !!p.rasterRef && p.rasterRef !== p.storageRef && !!p.normalization));
  let rastersOk = true;
  for (const p of r1?.pages ?? []) {
    const b = (await storage.get(p.rasterRef!)).bytes;
    const m = await sharp(b).metadata();
    rastersOk &&= sha(b) === p.rasterSha256 && m.format === "jpeg" && m.exif === undefined && Math.max(m.width!, m.height!) <= 2400 && m.height! > m.width!;
  }
  report("…each raster is a portrait JPEG within the 2,400 px edge, with no metadata, matching its recorded sha256", rastersOk);
  const s1 = sentFor(p1.personId);
  report("…OCR was sent each page's raster (an image, never the PDF)",
    s1.length === 2 && s1.every((s) => s.contentType === "image/jpeg" && s.hasSource) && r1!.pages.every((p) => s1.some((s) => s.sha === p.rasterSha256)), JSON.stringify(s1.map((s) => s.contentType)));
  report("…page split names pdf.js; texts and the OCR step name the OCR provider",
    step(r1, "PAGE_SPLIT")?.provider === "pdf-lib+pdf.js" && step(r1, "OCR")?.provider === "mock" && r1!.texts.length === 2 && r1!.texts.every((t) => t.provider === "mock"));
  const facts1 = await prisma.extractedFact.findMany({ where: { processingId: r1!.id }, select: { factType: true } });
  report("…facts were extracted from both scanned pages (labs and medicines)", facts1.some((f) => f.factType === "LAB_VALUE") && facts1.some((f) => f.factType === "MEDICATION"), `${facts1.length} facts`);
  const doc1 = await prisma.personDocument.findUniqueOrThrow({ where: { id: d1.id } });
  report("…the upload is untouched", sha((await storage.get(d1.storageRef)).bytes) === sha(scanned) && doc1.sha256 === sha(scanned) && doc1.status === "CURRENT");
  const before = { pages: await prisma.documentPage.count({ where: { processingId: r1!.id } }), sent: sent.length };
  await pageSplitStep(r1!.id);
  await drain();
  report("Redelivery adds no page, no raster and no OCR call",
    (await prisma.documentPage.count({ where: { processingId: r1!.id } })) === before.pages && sent.length === before.sent
      && (await prisma.domainEventOutbox.count({ where: { aggregateId: r1!.id, eventType: "DocumentPagesPrepared" } })) === 1);

  // 2. A mixed PDF: page 1 digital (text layer), page 2 scanned.
  const p2 = await person();
  const mixed = await combine([await fixturePdf(lab, { textLayer: true }), await fixturePdf(rx)]);
  const d2 = await upload(p2.userId, mixed, "Mixed");
  await drain();
  const r2 = await runOf(d2.id);
  const [m1, m2] = r2?.pages ?? [];
  report("A mixed PDF runs through to review", r2?.status === "AWAITING_REVIEW", r2?.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  report("…page 1 uses its text layer (no raster); page 2 has none and is rasterized",
    m1?.textLayer === "USABLE" && m1.rasterRef === null && m1.normalization === null && m2?.textLayer === "EMPTY" && !!m2.rasterRef);
  const s2 = sentFor(p2.personId);
  report("…only page 2 went to OCR, as its raster", s2.length === 1 && s2[0].contentType === "image/jpeg" && s2[0].sha === m2?.rasterSha256);
  const [t1, t2] = r2?.texts ?? [];
  report("…page 1's text is the PDF's own, line for line, recorded as the text layer",
    t1?.provider === TEXT_LAYER_PROVIDER && t1.handwritten === false && t1.text === lab.pages[0].lines.map((l) => l.text).join("\n") && t2?.provider === "mock");
  report("…the OCR step names the OCR provider (a page went to it)", step(r2, "OCR")?.provider === "mock");
  const facts2 = await prisma.extractedFact.findMany({ where: { processingId: r2!.id }, select: { factType: true, value: true, pageNo: true } });
  const hb = facts2.find((f) => f.factType === "LAB_VALUE" && (f.value as { analyte?: string }).analyte === "Hemoglobin");
  report("…facts come from both pages: the digital page's labs, exactly, and the scanned page's medicines",
    hb?.pageNo === 1 && (hb.value as { value?: string }).value === "11.2" && (hb.value as { unit?: string }).unit === "g/dL" && facts2.some((f) => f.factType === "MEDICATION" && f.pageNo === 2), `${facts2.length} facts`);
  const plt = facts2.find((f) => f.factType === "LAB_VALUE" && (f.value as { analyte?: string }).analyte === "Platelet Count");
  report("…a micro-sign unit survives the text layer exactly (µL, not Greek mu)", (plt?.value as { unit?: string } | undefined)?.unit === "x10^3/µL", JSON.stringify(plt?.value));

  // 3. A digital-only PDF: no OCR call.
  const p3 = await person();
  const d3 = await upload(p3.userId, await fixturePdf(lab, { textLayer: true }), "Digital");
  await drain();
  const r3 = await runOf(d3.id);
  report("A digital-only PDF reaches review with no OCR call; the OCR step names the text layer",
    r3?.status === "AWAITING_REVIEW" && sentFor(p3.personId).length === 0 && step(r3, "PAGE_SPLIT")?.provider === "pdf-lib" && step(r3, "OCR")?.provider === TEXT_LAYER_PROVIDER && r3.pages[0]?.rasterRef === null);

  // 4. A garbage text layer (mis-decoded font): not trusted; rasterized and OCR'd.
  const p4 = await person();
  const d4 = await upload(p4.userId, await fixturePdf(lab, { garbageTextLayer: true }), "Garbage");
  await drain();
  const r4 = await runOf(d4.id);
  report("A garbage text layer is recognised, and the page is rasterized and OCR'd instead",
    r4?.status === "AWAITING_REVIEW" && r4.pages[0]?.textLayer === "GARBAGE" && !!r4.pages[0].rasterRef && sentFor(p4.personId).length === 1 && r4.texts[0]?.provider === "mock"
      && !r4.texts[0].text.includes("Ã"));

  // 5. A PDF that won't open fails page split, original kept.
  const p5 = await person();
  const broken = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 0x41)]);
  const d5 = await upload(p5.userId, broken, "Broken").catch(() => null);
  if (d5) {
    await drain();
    const r5 = await runOf(d5.id);
    report("A PDF that won't open fails page split as UNREADABLE, nothing stored, the upload kept",
      r5?.status === "FAILED" && step(r5, "PAGE_SPLIT")?.status === "FAILED" && r5.pages.length === 0 && (await prisma.personDocument.findUniqueOrThrow({ where: { id: d5.id } })).status === "CURRENT");
  } else report("A PDF that won't open is refused at upload", true);

  // 6. The account purge removes the derived objects (page PDFs and rasters).
  const refs = (r1?.pages ?? []).flatMap((p) => [p.storageRef, p.rasterRef!]);
  await closePersonAccount(p1.userId, "CLOSE");
  await prisma.person.update({ where: { id: p1.personId }, data: { purgeAfter: new Date(Date.now() - 1000) } });
  await purgeClosedPersons({});
  let gone = refs.length === 4;
  for (const ref of refs) gone &&= await refused(storage.get(ref));
  report("Purging the account deletes its page copies and rasters from storage, not just the upload", gone && (await refused(storage.get(d1.storageRef))));

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
