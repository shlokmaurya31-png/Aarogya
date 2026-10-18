/**
 * Week 4a — the document pipeline, end to end on the mock providers
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §12).
 *
 * Part 2 (step 5, extraction): from the original text (never the
 * translation, never the person's name); every fact PENDING; printed lab
 * values verbatim and HIGH; handwritten facts labelled, at most MEDIUM, a
 * misread line LOW with its value as read; a page with nothing to review
 * completes the run.
 *
 * Part 1 (steps 1–4: page split → OCR → language → translation):
 *   - a synthetic Person's upload runs through the real dispatcher: pages,
 *     text with the detected language, a translation whose protected values
 *     are the original bytes; one event per step, carrying no text;
 *   - the person's identifiers never reach the translator;
 *   - redelivery creates nothing; a step that crashes mid-OCR, or whose
 *     worker is killed (resumed by the runner's sweep once the claim is
 *     stale), resumes without redoing pages; transient failures retry; an unreadable upload fails
 *     the run with the original kept; a planted translation corruption never
 *     becomes a PASSED translation; a same-language page isn't translated;
 *   - a REAL Person is skipped with the switch off, and without consent with
 *     it on; ID proofs are never processed.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-document-pipeline.ts
 */
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { getConsumersFor } from "../src/lib/events/consumers";
import { getStorageAdapter } from "../src/lib/storage";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { mockControl, setDocumentProvidersForTest, getDocumentProviders, type DocumentProviders } from "../src/lib/ai/documents";
import { carries } from "./lib/payloadValues";
import { pageSplitStep, resumeStalledDocumentSteps, runForUpload } from "../src/lib/documents/pipeline";
import { claimStep } from "../src/lib/documents/pipelineState";
import { documentProcessingPermit } from "../src/lib/ai/realData";
import type { ProcessingPermit } from "../src/lib/ai/documents";

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

/** Delivers everything pending, with the clock moved past any retry backoff. */
async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

async function person(opts: { synthetic?: boolean; displayName?: string; language?: string } = {}) {
  seq += 1;
  const a = await registerPatientAccount({ fullName: `Pipeline ${tag} ${seq}`, email: `docpipe-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1985-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: opts.synthetic === false ? "REAL" : "SYNTHETIC", preferredLanguage: opts.language ?? "en", ...(opts.displayName ? { displayName: opts.displayName } : {}) } });
  return { userId: a.userId, personId };
}

async function upload(userId: string, bytes: Buffer, type = "REPORT") {
  return uploadPersonDocument(userId, { bytes, contentType: "application/pdf", originalName: "report.pdf", title: "Report", type });
}

const runOf = (documentId: string) => prisma.documentProcessing.findFirst({ where: { documentId }, include: { steps: true } });
const stepStatus = (r: { steps: { step: string; status: string }[] } | null, step: string) => r?.steps.find((s) => s.step === step)?.status;
const eventsOf = (processingId: string, type: string) => prisma.domainEventOutbox.findMany({ where: { aggregateId: processingId, eventType: type } });

/** Wraps the configured providers to record what each one was sent. */
function recording(inner: DocumentProviders, opts: { crashOnPage?: string } = {}) {
  const sent = { translate: [] as string[], tag: [] as string[], extract: [] as string[], ocrPages: [] as string[], pagesOf: (personId: string) => sent.ocrPages.filter((m) => m.startsWith(`${personId}:`)).map((m) => m.slice(personId.length + 1)).join(",") };
  let crashed = false;
  const p: DocumentProviders = {
    ocr: { id: "mock", async ocrPage(page, hints, permit) {
      const marker = (await PDFDocument.load(page.bytes)).getPage(0).node.toString().match(/AarogyaFixture \(([^)]+)\)/)?.[1] ?? "?";
      if (opts.crashOnPage === marker && !crashed) { crashed = true; throw new Error("worker killed"); }
      // Keyed by person: leftover runs of an earlier gate run (reused database) may be resumed by the sweep too.
      sent.ocrPages.push(`${permit.personId}:${marker}`);
      return inner.ocr.ocrPage(page, hints, permit);
    } },
    translation: { id: "mock", async translate(text, from, to, o, permit) { sent.translate.push(text); return inner.translation.translate(text, from, to, o, permit); } },
    extraction: { id: "mock", async extract(page, permit, o) { sent.extract.push(page.text); return inner.extraction.extract(page, permit, o); } },
    tagging: { id: "mock", async tagMedicines(text, permit) { sent.tag.push(text); return inner.tagging.tagMedicines(text, permit); } },
  };
  return { p, sent };
}

async function main() {
  registerAllConsumers();
  const storage = getStorageAdapter();
  const mocks = getDocumentProviders({});

  // 1. The happy path, through the dispatcher.
  const hi = fixtureById("lab-hi-kft")!;
  const rec = recording(mocks);
  setDocumentProvidersForTest(rec.p);
  const p1 = await person({ displayName: hi.patientName });
  const d1 = await upload(p1.userId, await fixturePdf(hi));
  await drain();
  const r1 = await runOf(d1.id);
  report("A synthetic upload runs page split, OCR and translation", !!r1 && ["PAGE_SPLIT", "OCR", "TRANSLATE"].every((s) => stepStatus(r1, s) === "DONE"), r1?.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  const pages = await prisma.documentPage.findMany({ where: { processingId: r1!.id } });
  const text = await prisma.extractedText.findFirst({ where: { processingId: r1!.id }, include: { translations: true } });
  report("One page, stored as a derived copy; the original is unchanged", pages.length === 1 && pages[0].storageRef !== d1.storageRef && (await prisma.personDocument.findUniqueOrThrow({ where: { id: d1.id } })).sha256 === d1.sha256);
  report("OCR text with the detected language (hi, Deva)", text?.language === "hi" && text.script === "Deva" && text.text.includes("Creatinine 1.42 mg/dL (0.70 - 1.30) H"));
  const tr = text?.translations[0];
  report("A PASSED translation into English, labels translated", tr?.exactCopyCheck === "PASSED" && tr.targetLanguage === "en" && tr.text.includes("Laboratory Report") && !tr.text.includes("जाँच रिपोर्ट"));
  const valueLines = hi.expected.filter((e) => e.factType === "LAB_VALUE").map((e) => e.sourceText!);
  report("Every protected value line comes back byte for byte", valueLines.every((l) => tr!.text.split("\n").includes(l)));
  report("The translator never saw a value or a number", rec.sent.translate.length === 1 && !/\p{Nd}/u.test(rec.sent.translate[0].replace(/⟦P\d+⟧/g, "")) && !rec.sent.translate[0].includes("Creatinine"));
  report("The person's name never reached the translator or the tagger, and is restored", !rec.sent.translate.concat(rec.sent.tag).some((t) => t.includes(hi.patientName)) && tr!.text.includes(hi.patientName));
  const evs = await Promise.all(["DocumentPagesPrepared", "DocumentTextExtracted", "DocumentTranslated"].map((t) => eventsOf(r1!.id, t)));
  report("One event per step, PERSON-scoped", evs.every((e) => e.length === 1 && e[0].personId === p1.personId && e[0].facilityId === null));
  report("Event payloads carry no text, values or names", evs.flat().every((e) => !["Creatinine", "1.42", hi.patientName, "जाँच"].some((n) => carries(e.payload, n))));

  // Part 2: extraction, from the original text.
  const r1b = await runOf(d1.id);
  const facts1 = await prisma.extractedFact.findMany({ where: { processingId: r1!.id } });
  report("Extraction ran: the run awaits the person's review", r1b?.status === "AWAITING_REVIEW" && stepStatus(r1b, "EXTRACT") === "DONE" && stepStatus(r1b, "MERGE") === "PENDING");
  report(`Every printed fact was found (${hi.expected.length}), all PENDING, none merged`, facts1.length === hi.expected.length && facts1.every((f) => f.reviewStatus === "PENDING" && !f.recordEntryId));
  report("The extractor read the original (Hindi) text, never the translation", rec.sent.extract.length === 1 && rec.sent.extract[0].includes("जाँच रिपोर्ट") && !rec.sent.extract[0].includes("Laboratory Report"));
  report("…and never the person's name (a placeholder in its place)", !rec.sent.extract[0].includes(hi.patientName) && rec.sent.extract[0].includes("⟦I1⟧"));
  const labFacts = facts1.filter((f) => f.factType === "LAB_VALUE");
  report("Lab values: exact-copy PASSED, HIGH (printed), source line verbatim on the page, value verbatim in it",
    labFacts.length === 4 && labFacts.every((f) => { const v = f.value as Record<string, string>; return f.exactCopyCheck === "PASSED" && f.confidenceBand === "HIGH" && text!.text.split("\n").includes(f.sourceText) && f.sourceText.includes(v.value) && f.sourceText.includes(v.unit); }));
  const fx1 = await eventsOf(r1!.id, "DocumentFactsExtracted");
  report("DocumentFactsExtracted once, with counts only", fx1.length === 1 && (fx1[0].payload as { factCount: number }).factCount === hi.expected.length && !carries(fx1[0].payload, "Creatinine"));

  // A handwritten prescription: labelled, at most MEDIUM, misread lines LOW.
  setDocumentProvidersForTest(null);
  mockControl.reset();
  const hw = fixtureById("rx-hw-en-1")!;
  const p2 = await person();
  const d2 = await upload(p2.userId, await fixturePdf(hw));
  await drain();
  const r2 = await runOf(d2.id);
  const facts2 = await prisma.extractedFact.findMany({ where: { processingId: r2!.id } });
  report("Handwritten: every fact labelled handwritten, none HIGH", facts2.length > 0 && facts2.every((f) => f.handwritten && f.confidenceBand !== "HIGH"), facts2.map((f) => f.confidenceBand).join(","));
  const amox = facts2.find((f) => f.factType === "MEDICATION" && String((f.value as { name: string }).name).startsWith("Amox"));
  report("…the misread line (OCR confidence 0.62) is LOW, its value verbatim as read (never 'corrected')", amox?.confidenceBand === "LOW" && (amox.value as { name: string }).name === "Amoxicilin");

  // Nothing to review: the run completes on its own.
  setDocumentProvidersForTest({ ...mocks, extraction: { id: "mock", async extract() { return { facts: [], model: "mock-1" }; } } });
  const pz = await person();
  const dz = await upload(pz.userId, await fixturePdf(fixtureById("lab-en-cbc")!));
  await drain();
  const rz = await runOf(dz.id);
  report("No facts on the page: the run is COMPLETED (MERGE SKIPPED) with DocumentProcessingCompleted",
    rz?.status === "COMPLETED" && stepStatus(rz, "MERGE") === "SKIPPED" && (await eventsOf(rz.id, "DocumentProcessingCompleted")).length === 1);
  setDocumentProvidersForTest(rec.p);

  // 2. Redelivery creates nothing.
  const before = { pages: await prisma.documentPage.count(), texts: await prisma.extractedText.count(), trs: await prisma.translation.count(), facts: await prisma.extractedFact.count(), ocr: rec.sent.ocrPages.length, ex: rec.sent.extract.length };
  const uploaded = await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: d1.id, eventType: "PersonDocumentUploaded" } });
  for (const e of [uploaded, ...evs.flat(), ...fx1]) {
    for (const c of getConsumersFor(e.eventType).filter((x) => x.name.startsWith("doc-"))) {
      await c.handle({ eventId: e.id, eventType: e.eventType, eventVersion: e.eventVersion, aggregateType: e.aggregateType, aggregateId: e.aggregateId, organizationId: null, facilityId: null, personId: e.personId, actorUserId: null, correlationId: e.id, causationId: null, occurredAt: e.occurredAt, payload: e.payload as Record<string, unknown> });
    }
  }
  report("Redelivering every event creates nothing and calls no provider",
    (await prisma.documentPage.count()) === before.pages && (await prisma.extractedText.count()) === before.texts && (await prisma.translation.count()) === before.trs && (await prisma.extractedFact.count()) === before.facts && rec.sent.ocrPages.length === before.ocr && rec.sent.extract.length === before.ex
      && (await prisma.documentProcessing.count({ where: { documentId: d1.id } })) === 1);

  // 3a. A step that crashes on page 2: it gives its claim back; the retry resumes at page 2.
  const twoPages = async () => {
    const two = await PDFDocument.create();
    for (const id of ["lab-en-cbc", "lab-hi-kft"]) {
      const src = await PDFDocument.load(await fixturePdf(fixtureById(id)!));
      const [pg] = await two.copyPages(src, [0]);
      two.addPage(pg);
    }
    return Buffer.from(await two.save());
  };
  const crash = recording(mocks, { crashOnPage: "lab-hi-kft#1" });
  setDocumentProvidersForTest(crash.p);
  const p3 = await person();
  const d3 = await upload(p3.userId, await twoPages());
  await drain();
  const r3 = await runOf(d3.id);
  report("A step that crashes on page 2 resumes there: page 1 is OCR'd once, the run goes on",
    stepStatus(r3, "OCR") === "DONE" && stepStatus(r3, "TRANSLATE") === "DONE" && crash.sent.pagesOf(p3.personId) === "lab-en-cbc#1,lab-hi-kft#1" && (await prisma.extractedText.count({ where: { processingId: r3!.id } })) === 2,
    crash.sent.pagesOf(p3.personId));

  // 3b. A worker killed outright (its claim held, page 1 done): the runner's sweep resumes it once the claim is stale.
  const kill = recording(mocks);
  setDocumentProvidersForTest(kill.p);
  const p3b = await person();
  const d3b = await upload(p3b.userId, await twoPages());
  const up3b = await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: d3b.id, eventType: "PersonDocumentUploaded" } });
  await prisma.domainEventOutbox.update({ where: { id: up3b.id }, data: { status: "PROCESSED", processedAt: new Date() } });
  const run3b = (await runForUpload(d3b.id))!;
  await pageSplitStep(run3b.id);
  await prisma.domainEventOutbox.updateMany({ where: { aggregateId: run3b.id, eventType: "DocumentPagesPrepared" }, data: { status: "PROCESSED", processedAt: new Date() } });
  // The "killed" worker: it claimed OCR and stored page 1, then vanished.
  await prisma.$transaction((tx) => claimStep(tx, run3b.id, "OCR"));
  const page1 = await prisma.documentPage.findFirstOrThrow({ where: { processingId: run3b.id, pageNo: 1 } });
  const o1 = await mocks.ocr.ocrPage({ bytes: (await storage.get(page1.storageRef)).bytes, contentType: "application/pdf" }, {}, (await documentProcessingPermit(p3b.personId) as { permit: ProcessingPermit }).permit);
  await prisma.extractedText.create({ data: { processingId: run3b.id, personId: p3b.personId, pageNo: 1, text: o1.text, layout: o1.layout as never, language: o1.language, script: o1.script, confidence: o1.confidence, provider: "mock", model: o1.model } });
  await resumeStalledDocumentSteps();
  const held = await prisma.documentProcessingStep.findFirstOrThrow({ where: { processingId: run3b.id, step: "OCR" } });
  report("A fresh claim held by a killed worker isn't taken over", kill.sent.pagesOf(p3b.personId) === "" && held.status === "RUNNING" && held.attempts === 1, `${kill.sent.pagesOf(p3b.personId)} ${held.status} ${held.attempts}`);
  await prisma.documentProcessingStep.updateMany({ where: { processingId: run3b.id, step: "OCR" }, data: { startedAt: new Date(Date.now() - 11 * 60_000) } });
  const swept = await resumeStalledDocumentSteps();
  await drain();
  const r3b = await runOf(d3b.id);
  report("…once stale, the runner's sweep resumes it: only page 2 is OCR'd, and the run goes on",
    swept.resumed >= 1 && kill.sent.pagesOf(p3b.personId) === "lab-hi-kft#1" && stepStatus(r3b, "OCR") === "DONE" && stepStatus(r3b, "TRANSLATE") === "DONE", kill.sent.pagesOf(p3b.personId));

  // 4. Transient failures retry.
  setDocumentProvidersForTest(null);
  mockControl.reset();
  mockControl.ocrTransientFailures = 2;
  const p4 = await person();
  const d4 = await upload(p4.userId, await fixturePdf(fixtureById("rx-mr-printed")!));
  await drain();
  const r4 = await runOf(d4.id);
  const ocr4 = r4?.steps.find((s) => s.step === "OCR");
  report("Two transient OCR failures, then success (3 attempts)", ocr4?.status === "DONE" && ocr4.attempts === 3 && stepStatus(r4, "TRANSLATE") === "DONE", `${ocr4?.status} ${ocr4?.attempts}`);

  // 5. Unreadable: the run fails, the original is kept.
  const blank = await PDFDocument.create(); blank.addPage([200, 200]);
  const p5 = await person();
  const d5 = await upload(p5.userId, Buffer.from(await blank.save()));
  await drain();
  const r5 = await runOf(d5.id);
  const failed5 = r5 ? await eventsOf(r5.id, "DocumentProcessingFailed") : [];
  report("An unreadable upload: OCR FAILED (UNREADABLE), the run FAILED, one failure event",
    r5?.status === "FAILED" && r5.steps.find((s) => s.step === "OCR")?.lastErrorCode === "UNREADABLE" && failed5.length === 1 && (failed5[0].payload as { errorCode: string }).errorCode === "UNREADABLE");
  const kept = await prisma.personDocument.findUniqueOrThrow({ where: { id: d5.id } });
  report("…and the original is kept, byte for byte", kept.status === "CURRENT" && (await storage.get(kept.storageRef)).bytes.length > 0 && kept.sha256 === d5.sha256);

  // 6. Translation corruption never becomes a PASSED translation.
  mockControl.reset();
  mockControl.translationCorruption = { mode: "drop", times: Number.POSITIVE_INFINITY };
  const p6 = await person();
  const d6 = await upload(p6.userId, await fixturePdf(fixtureById("dc-kn")!));
  await drain();
  const r6 = await runOf(d6.id);
  const t6 = await prisma.translation.findMany({ where: { extractedText: { processingId: r6!.id } } });
  report("A translator that drops a placeholder (even on the strict retry): stored FAILED, never PASSED",
    t6.length === 1 && t6[0].exactCopyCheck === "FAILED" && /⟦P\d+⟧/.test(t6[0].text) && stepStatus(r6, "TRANSLATE") === "DONE");
  const ev6 = r6 ? await eventsOf(r6.id, "DocumentTranslated") : [];
  report("…counted as an exact-copy failure, not a translated page", (ev6[0]?.payload as { translatedPages: number; exactCopyFailures: number })?.exactCopyFailures === 1 && (ev6[0]?.payload as { translatedPages: number }).translatedPages === 0);
  mockControl.reset();
  mockControl.translationCorruption = { mode: "alter", times: 1 };
  const p6b = await person();
  const d6b = await upload(p6b.userId, await fixturePdf(fixtureById("img-mr-usg")!));
  await drain();
  const t6b = await prisma.translation.findMany({ where: { extractedText: { processingId: (await runOf(d6b.id))!.id } } });
  report("A corruption caught once is retried strictly, and the clean retry PASSES", t6b.length === 1 && t6b[0].exactCopyCheck === "PASSED" && !/⟦P\d+⟧/.test(t6b[0].text));
  mockControl.reset();

  // 7. Same language: no translation.
  const p7 = await person();
  const d7 = await upload(p7.userId, await fixturePdf(fixtureById("lab-en-cbc")!));
  await drain();
  const r7 = await runOf(d7.id);
  report("An English page for an English reader: TRANSLATE SKIPPED, no translation row",
    stepStatus(r7, "TRANSLATE") === "SKIPPED" && (await prisma.translation.count({ where: { extractedText: { processingId: r7!.id } } })) === 0 && (await eventsOf(r7!.id, "DocumentTranslated")).length === 1);

  // 8. The real-data switch.
  const prev = process.env.AI_REAL_DATA_ENABLED;
  delete process.env.AI_REAL_DATA_ENABLED;
  const p8 = await person({ synthetic: false });
  const d8 = await upload(p8.userId, await fixturePdf(hi));
  await drain();
  const r8 = await runOf(d8.id);
  report("A REAL Person with the switch off: run SKIPPED (REAL_DATA_DISABLED), nothing read",
    r8?.status === "SKIPPED" && r8.skipReason === "REAL_DATA_DISABLED" && (await prisma.documentPage.count({ where: { processingId: r8.id } })) === 0 && r8.steps.every((s) => s.status === "SKIPPED"));
  process.env.AI_REAL_DATA_ENABLED = "true";
  const p8b = await person({ synthetic: false });
  const d8b = await upload(p8b.userId, await fixturePdf(hi));
  await drain();
  const r8b = await runOf(d8b.id);
  report("A REAL Person with the switch on but no DOCUMENT_PROCESSING consent: SKIPPED (CONSENT_REQUIRED)", r8b?.status === "SKIPPED" && r8b.skipReason === "CONSENT_REQUIRED");
  if (prev === undefined) delete process.env.AI_REAL_DATA_ENABLED; else process.env.AI_REAL_DATA_ENABLED = prev;

  // 9. ID proofs are never processed.
  const p9 = await person();
  const d9 = await upload(p9.userId, await fixturePdf(hi), "ID_PROOF");
  await drain();
  report("An ID proof upload never starts a run", (await prisma.documentProcessing.count({ where: { documentId: d9.id } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
