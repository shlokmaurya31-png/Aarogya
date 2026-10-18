/**
 * Week 4a — the document pipeline, end to end on the mock providers
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §12).
 *
 * Part 5 (step 8, conflicts): each rule (lab value, allergy entered in
 * error, medication dose, resolved diagnosis) fires once per pair, through
 * the entry's event and a verified record's later event; the verified value
 * is shown first, to the person and to the treating facility (opt-in and care
 * relationship) only; a clinician acknowledges once; nothing is overwritten.
 *
 * Part 4 (step 7, merge): only confirmed or corrected facts become entries
 * (PATIENT_PROVIDED, with provenance; exact fields equal the source spans);
 * once per fact; the run completes; the treating facility sees entries only
 * with the opt-in AND a care relationship; a confirmed allergy is bridged as
 * UNCONFIRMED (severity never guessed) where shared and reaches the
 * prescribing check; withdrawing the opt-in inactivates it with a
 * content-free notice; a clinician-confirmed one stays; withdrawing an entry
 * or the upload withdraws (and cancels) what came from it.
 *
 * Part 3 (step 6, review): owner only, another Person's fact or document is a
 * 404; a fact is decided once under concurrency; a correction is shown back
 * before it is stored as typed, and refused by the schema when invalid; bulk
 * confirm only for HIGH printed facts (all or nothing); handwritten facts
 * field by field; a fact failing the exact-copy check can't be confirmed;
 * status and pages (a failed translation withheld); reprocess.
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
import { bulkReview, confirmFact, confirmFactField, correctFact, listOwnFacts, rejectFact } from "../src/lib/documents/review";
import { COULD_NOT_READ, pageView, processingStatus, requestReprocess } from "../src/lib/documents/patientView";
import { listOwnRecords, mergeReviewedFact, staffPatientProvidedRecords, withdrawPatientRecord } from "../src/lib/documents/merge";
import { EXACT_FIELDS } from "../src/lib/documents/factSchemas";
import { acknowledgeConflict, checkRecordConflicts, facilityConflicts, listOwnConflicts } from "../src/lib/documents/conflicts";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { decidePersonConsent } from "../src/lib/person/consent";
import { uploadPersonDocument, withdrawPersonDocument } from "../src/lib/person/documents";
import { checkMedicationSafety } from "../src/lib/hospital/clinicalSafety";
import { updateAllergy } from "../src/lib/hospital/clinicalRecords";

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

const refusedP = <T>(p: Promise<T>) => p.then(() => false, () => true);
const notFound = <T>(p: Promise<T>) => p.then(() => false, (e) => e?.constructor?.name === "NotFoundError");
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

  // ── Part 3: the person's review (owner only; compare-and-set) ──
  setDocumentProvidersForTest(null);
  mockControl.reset();
  const rx = fixtureById("rx-mr-printed")!;
  const pr = await person({ language: "en" });
  const dr = await upload(pr.userId, await fixturePdf(rx));
  await drain();
  const rr = await runOf(dr.id);
  const pending = await listOwnFacts(pr.userId);
  report("The review list: the person's PENDING facts, with source text and region", pending.length === rx.expected.length && pending.every((f) => f.sourceText && f.region && f.processingId === rr!.id));
  const lab0 = pending.find((f) => f.factType === "MEDICATION")!;
  const dbl = await Promise.allSettled([confirmFact(pr.userId, lab0.id, { version: lab0.version }), confirmFact(pr.userId, lab0.id, { version: lab0.version })]);
  const conf = await prisma.extractedFact.findUniqueOrThrow({ where: { id: lab0.id } });
  const reviewedEv = await prisma.domainEventOutbox.findMany({ where: { aggregateId: rr!.id, eventType: "ExtractedFactReviewed" } });
  report("Two concurrent confirms of one fact: decided once (one wins, one refused), one event",
    dbl.filter((x) => x.status === "fulfilled").length === 1 && conf.reviewStatus === "CONFIRMED" && conf.reviewedVia === "SELF" && reviewedEv.length === 1);
  report("ExtractedFactReviewed carries ids and codes only", !["Metformin", "500 mg", rx.patientName].some((n) => carries(reviewedEv[0].payload, n)) && (reviewedEv[0].payload as { decision: string }).decision === "CONFIRMED");
  report("A decided fact can't be decided again", await refusedP(rejectFact(pr.userId, lab0.id, { version: conf.version })));

  const other = await person();
  report("Another Person's fact is a 404 (confirm, correct, reject, field)",
    (await Promise.all([confirmFact(other.userId, pending[1].id, { version: pending[1].version }), correctFact(other.userId, pending[1].id, { version: pending[1].version, value: {}, typedValueConfirmed: true }), rejectFact(other.userId, pending[1].id, { version: pending[1].version }), confirmFactField(other.userId, pending[1].id, "text", { version: pending[1].version })].map((p) => p.then(() => "ok", (e) => e?.constructor?.name))))
      .every((n) => n === "NotFoundError"));
  report("…and so are another Person's document status and pages", await notFound(processingStatus(other.userId, dr.id)) && await notFound(pageView(other.userId, dr.id, 1)));

  const diag = pending.find((f) => f.factType === "DIAGNOSIS")!;
  const shown = await correctFact(pr.userId, diag.id, { version: diag.version, value: { text: "Type 2 diabetes mellitus  " } });
  report("A correction is shown back first (not stored until confirmed as typed)", "needsConfirmation" in shown && (await prisma.extractedFact.findUniqueOrThrow({ where: { id: diag.id } })).reviewStatus === "PENDING");
  report("…an invalid correction is refused by the type's schema", await refusedP(correctFact(pr.userId, diag.id, { version: diag.version, value: { text: "" }, typedValueConfirmed: true })) && await refusedP(correctFact(pr.userId, diag.id, { version: diag.version, value: { text: "x", note: "y" }, typedValueConfirmed: true })));
  await correctFact(pr.userId, diag.id, { version: diag.version, value: { text: "Type 2 diabetes mellitus" }, typedValueConfirmed: true });
  const corrected = await prisma.extractedFact.findUniqueOrThrow({ where: { id: diag.id } });
  report("…confirmed as typed: CORRECTED with the value stored exactly", corrected.reviewStatus === "CORRECTED" && (corrected.reviewedValue as { text: string }).text === "Type 2 diabetes mellitus" && (corrected.value as { text: string }).text === "Type 2 Diabetes Mellitus");

  // Bulk: only HIGH printed facts may be confirmed together.
  const now = await listOwnFacts(pr.userId);
  const allergyFact = now.find((f) => f.factType === "ALLERGY")!;
  await prisma.extractedFact.update({ where: { id: allergyFact.id }, data: { confidenceBand: "LOW", version: { increment: 1 } } });
  const fresh = await listOwnFacts(pr.userId);
  report("The review list puts LOW first", fresh[0].confidenceBand === "LOW");
  const before3 = await prisma.extractedFact.count({ where: { processingId: rr!.id, reviewStatus: "PENDING" } });
  report("Bulk confirm including a LOW fact is refused, and nothing is half-applied",
    await refusedP(bulkReview(pr.userId, { decisions: fresh.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) }))
      && (await prisma.extractedFact.count({ where: { processingId: rr!.id, reviewStatus: "PENDING" } })) === before3);
  const highs = fresh.filter((f) => f.bulkConfirmable);
  const low = fresh.find((f) => f.confidenceBand === "LOW")!;
  await bulkReview(pr.userId, { decisions: [...highs.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })), { factId: low.id, version: low.version, decision: "REJECT" }] });
  report("Bulk: HIGH printed facts confirmed and the LOW one rejected, in one go", highs.length > 0 && (await prisma.extractedFact.count({ where: { processingId: rr!.id, reviewStatus: "PENDING" } })) === 0);

  // Handwritten: field by field only.
  const hwFacts = await listOwnFacts(p2.userId);
  const hwMed = hwFacts.find((f) => f.factType === "MEDICATION" && f.exactCopyCheck === "PASSED")!;
  report("A handwritten fact can't be confirmed as a whole, nor in bulk",
    await refusedP(confirmFact(p2.userId, hwMed.id, { version: hwMed.version })) && await refusedP(bulkReview(p2.userId, { decisions: [{ factId: hwMed.id, version: hwMed.version, decision: "CONFIRM" }] })) && !hwMed.bulkConfirmable);
  let v = hwMed.version;
  for (const field of hwMed.fields.slice(0, -1)) v = (await confirmFactField(p2.userId, hwMed.id, field, { version: v })).version;
  const partly = await prisma.extractedFact.findUniqueOrThrow({ where: { id: hwMed.id } });
  report("…each field confirmed one by one; until the last, the fact stays PENDING", partly.reviewStatus === "PENDING" && partly.confirmedFields.length === hwMed.fields.length - 1);
  await confirmFactField(p2.userId, hwMed.id, hwMed.fields[hwMed.fields.length - 1], { version: v });
  const whole = await prisma.extractedFact.findUniqueOrThrow({ where: { id: hwMed.id } });
  report("…and the last field makes it CONFIRMED (every field confirmed)", whole.reviewStatus === "CONFIRMED" && hwMed.fields.every((x) => whole.confirmedFields.includes(x)));
  report("A field the fact doesn't have is refused", await refusedP(confirmFactField(p2.userId, hwFacts.find((f) => f.id !== hwMed.id && f.reviewStatus === "PENDING")!.id, "colour", { version: 1 })));

  // A fact that fails the exact-copy check can't be confirmed as extracted.
  setDocumentProvidersForTest({ ...mocks, extraction: { id: "mock", async extract(page, permit) {
    const r = await mocks.extraction.extract(page, permit);
    return { ...r, facts: r.facts.map((f) => f.factType === "LAB_VALUE" ? { ...f, value: { ...f.value, value: String(Math.round(Number(f.value.value))), numericValue: Math.round(Number(f.value.value)) } } : f) };
  } } });
  const pe = await person();
  const de = await upload(pe.userId, await fixturePdf(hi));
  await drain();
  setDocumentProvidersForTest(null);
  const rounded = (await listOwnFacts(pe.userId)).filter((f) => f.factType === "LAB_VALUE");
  const bad = rounded.find((f) => f.exactCopyCheck === "FAILED");
  report("A model that rounds a lab value: exact-copy FAILED, LOW", !!bad && bad.confidenceBand === "LOW", rounded.map((f) => `${(f.value as { value: string }).value}:${f.exactCopyCheck}`).join(" "));
  report("…it can't be confirmed as extracted (only corrected to the page, or rejected)", !!bad && await refusedP(confirmFact(pe.userId, bad.id, { version: bad.version })) && !bad.confirmable);
  void de;

  // Status and pages.
  const st = await processingStatus(p1.userId, d1.id);
  const pg = await pageView(p1.userId, d1.id, 1);
  report("Status: steps (status only), languages, a translation, fact counts", "steps" in st && st.languages?.join() === "hi" && st.translated === true && (st.facts?.PENDING ?? 0) === hi.expected.length);
  report("A page: the original image (signed URL), the text as read, and the translation, each labelled",
    pg.original.label === "ORIGINAL" && !!pg.original.imageUrl && pg.text?.label === "TEXT_AS_READ" && pg.translation?.label === "TRANSLATION" && "text" in pg.translation && pg.translation.text.includes("Laboratory Report"));
  const pgFailed = await pageView(p6.userId, d6.id, 1);
  report("A translation that failed the exact-copy check is withheld; the original is shown", pgFailed.translation?.label === "TRANSLATION_WITHHELD" && !("text" in (pgFailed.translation ?? {})) && !!pgFailed.text);
  const st5 = await processingStatus(p5.userId, d5.id);
  report("An unreadable document says so, and that it is saved as it is", st5.status === "FAILED" && "message" in st5 && st5.message === COULD_NOT_READ);

  // Reprocess.
  report("Reprocess is refused while the facts await review", await refusedP(requestReprocess(p1.userId, d1.id, "LANGUAGE_CHANGED")));
  const again = await requestReprocess(p5.userId, d5.id, "PATIENT_REQUEST");
  await drain();
  const runs5 = await prisma.documentProcessing.findMany({ where: { documentId: d5.id }, orderBy: { run: "asc" } });
  report("Reprocess after a failure: a second run, through the pipeline again (the original still unreadable: FAILED)",
    again.run === 2 && runs5.length === 2 && runs5[1].status === "FAILED" && (await prisma.domainEventOutbox.count({ where: { aggregateId: again.processingId, eventType: "DocumentReprocessRequested" } })) === 1);
  report("An unknown reason or another Person's document is refused", await refusedP(requestReprocess(p5.userId, d5.id, "MODEL_UPGRADE")) && await notFound(requestReprocess(other.userId, d5.id, "PATIENT_REQUEST")));

  // ── Part 4: confirmed facts into the record ──
  await drain();
  const recs = await prisma.patientProvidedRecord.findMany({ where: { personId: pr.personId } });
  const decided = await prisma.extractedFact.findMany({ where: { processingId: rr!.id } });
  const shouldMerge = decided.filter((f) => (f.reviewStatus === "CONFIRMED" || f.reviewStatus === "CORRECTED") && f.factType !== "DOCUMENT_META");
  report("Only confirmed or corrected facts became entries (never DOCUMENT_META, never a rejected one)",
    recs.length === shouldMerge.length && recs.every((r) => shouldMerge.some((f) => f.id === r.factId)) && !recs.some((r) => decided.find((f) => f.id === r.factId)?.reviewStatus === "REJECTED"));
  report("Each entry: PATIENT_PROVIDED, with provenance (fact, document, page, region) and the date from the document",
    recs.every((r) => r.source === "PATIENT_PROVIDED" && r.documentId === dr.id && r.pageNo === 1 && !!r.region && r.effectiveDate?.toISOString().slice(0, 10) === "2026-01-21"));
  const byFact = new Map(decided.map((f) => [f.id, f]));
  report("Exact fields of confirmed entries equal the source spans byte for byte; a corrected entry holds the correction",
    recs.every((r) => {
      const f = byFact.get(r.factId)!;
      const v = r.value as Record<string, unknown>;
      if (f.reviewStatus === "CORRECTED") return JSON.stringify(v) === JSON.stringify(f.reviewedValue);
      return EXACT_FIELDS[f.factType].every((k) => v[k] === undefined || f.sourceText.includes(String(v[k])));
    }));
  const runDone = await runOf(dr.id);
  const completed = await eventsOf(rr!.id, "DocumentProcessingCompleted");
  report("Every fact decided: the run is COMPLETED (MERGE DONE), DocumentProcessingCompleted with the counts",
    runDone?.status === "COMPLETED" && stepStatus(runDone, "MERGE") === "DONE" && completed.length === 1 && (completed[0].payload as { corrected: number }).corrected === 1);
  const added = await prisma.domainEventOutbox.findMany({ where: { eventType: "PatientProvidedRecordAdded", personId: pr.personId } });
  report("PatientProvidedRecordAdded once per entry, ids and codes only", added.length === recs.length && added.every((e) => !["Metformin", "500 mg", "diabetes"].some((n) => carries(e.payload, n))));
  const factsAfter = await prisma.extractedFact.count({ where: { processingId: rr!.id, recordEntryId: { not: null } } });
  for (const e of await prisma.domainEventOutbox.findMany({ where: { aggregateId: rr!.id, eventType: "ExtractedFactReviewed" } })) {
    await mergeReviewedFact((e.payload as { factId: string }).factId);
  }
  report("Merging again creates nothing (one entry per fact)", (await prisma.patientProvidedRecord.count({ where: { personId: pr.personId } })) === recs.length && (await prisma.extractedFact.count({ where: { processingId: rr!.id, recordEntryId: { not: null } } })) === factsAfter);

  // Visibility: the treating facility sees entries only with the opt-in and a care relationship.
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { personId: pr.personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  const fac = link.patient.facilityId;
  report("Without the opt-in, the treating facility sees no entry (no default)", (await staffPatientProvidedRecords(fac, [link.patientId])).length === 0);
  await decidePersonConsent({ userId: pr.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await drain();
  report("With the opt-in but no care relationship: still nothing", (await staffPatientProvidedRecords(fac, [link.patientId])).length === 0);
  await prisma.encounter.create({ data: { patientId: link.patientId, facilityId: fac, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "pipeline gate" } });
  const seen = await staffPatientProvidedRecords(fac, [link.patientId]);
  report("With both: the entries, labelled PATIENT_PROVIDED", seen.length === recs.length && seen.every((r) => r.source === "PATIENT_PROVIDED"));
  report("The person always sees their own entries", (await listOwnRecords(pr.userId)).length === recs.length);

  // The allergy bridge: a confirmed patient-reported allergy reaches prescribing checks where shared.
  const ax = fixtureById("rx-en-2")!;
  const pa = await person();
  await upload(pa.userId, await fixturePdf(ax));
  await drain();
  const axFacts = await listOwnFacts(pa.userId);
  await bulkReview(pa.userId, { decisions: axFacts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  await drain();
  const aLink = await prisma.personPatientLink.findFirstOrThrow({ where: { personId: pa.personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  const aRec = await prisma.patientProvidedRecord.findFirstOrThrow({ where: { personId: pa.personId, kind: "ALLERGY" } });
  report("A confirmed allergy without the opt-in is not bridged", (await prisma.allergy.count({ where: { patientProvidedRecordId: aRec.id } })) === 0);
  await decidePersonConsent({ userId: pa.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await drain();
  const bridged = await prisma.allergy.findFirst({ where: { patientProvidedRecordId: aRec.id } });
  report("With the opt-in: bridged to the linked record as UNCONFIRMED, PATIENT_PROVIDED, severity not guessed",
    bridged?.patientId === aLink.patientId && bridged.verification === "UNCONFIRMED" && bridged.source === "PATIENT_PROVIDED" && bridged.severity === null && bridged.criticality === "UNABLE_TO_ASSESS" && bridged.substance === "Aspirin");
  const flags = await checkMedicationSafety(aLink.patientId, "Aspirin");
  report("…and the prescribing allergy check sees it (as a danger: severity unknown, patient-reported)", flags.some((f) => f.rule === "allergy-conflict" && f.severity === "danger" && f.sourceId === bridged!.id));
  await decidePersonConsent({ userId: pa.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED" });
  await drain();
  const after = await prisma.allergy.findUniqueOrThrow({ where: { id: bridged!.id } });
  const notice = await prisma.patientAllergyNotice.findFirst({ where: { patientId: aLink.patientId, resolvedAt: null } });
  report("Opt-in withdrawn: the unconfirmed bridged allergy goes INACTIVE, with a content-free notice in its place",
    after.status === "INACTIVE" && notice?.kind === "WITHDRAWN_BY_PATIENT" && notice.facilityId === aLink.patient.facilityId);
  report("…announced as AllergyListUpdated INACTIVATED (source PATIENT_PROVIDED), no substance in the payload",
    (await prisma.domainEventOutbox.findMany({ where: { aggregateId: bridged!.id, eventType: "AllergyListUpdated" } })).some((e) => (e.payload as { action: string; source?: string }).action === "INACTIVATED" && (e.payload as { source?: string }).source === "PATIENT_PROVIDED" && !carries(e.payload, "Aspirin")));
  await decidePersonConsent({ userId: pa.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await drain();
  const back = await prisma.allergy.findUniqueOrThrow({ where: { id: bridged!.id } });
  report("Opt-in given again: the same bridged row is active again (no duplicate)", back.status === "ACTIVE" && (await prisma.allergy.count({ where: { patientProvidedRecordId: aRec.id } })) === 1);
  const clinician = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: aLink.patient.facilityId } }, select: { userId: true } });
  await updateAllergy({ allergyId: back.id, facilityId: aLink.patient.facilityId, verification: "CONFIRMED", byUserId: clinician.userId });
  await withdrawPatientRecord(pa.userId, aRec.id);
  await drain();
  const keptAllergy = await prisma.allergy.findUniqueOrThrow({ where: { id: back.id } });
  const withdrawn = await prisma.patientProvidedRecord.findUniqueOrThrow({ where: { id: aRec.id } });
  report("The person withdraws the entry: WITHDRAWN (PatientProvidedRecordUpdated); a clinician-confirmed allergy stays the facility's",
    withdrawn.status === "WITHDRAWN" && !!withdrawn.withdrawnAt && keptAllergy.status === "ACTIVE" && keptAllergy.verification === "CONFIRMED"
      && (await prisma.domainEventOutbox.count({ where: { aggregateId: aRec.id, eventType: "PatientProvidedRecordUpdated" } })) === 1);
  report("Another Person can't withdraw an entry", await notFound(withdrawPatientRecord(other.userId, recs[0].id)));

  // Withdrawing the upload: its derived entries are withdrawn too.
  await withdrawPersonDocument(pr.userId, dr.id);
  await drain();
  report("Withdrawing the upload withdraws its entries", (await prisma.patientProvidedRecord.count({ where: { documentId: dr.id, status: "ACTIVE" } })) === 0);
  const pw = await person();
  const dw = await upload(pw.userId, await fixturePdf(fixtureById("lab-en-thyroid") ?? hi));
  await drain();
  await withdrawPersonDocument(pw.userId, dw.id);
  await drain();
  const rw = await runOf(dw.id);
  report("…and a run awaiting review is CANCELLED, its PENDING facts discarded", rw?.status === "CANCELLED" && (await prisma.extractedFact.count({ where: { processingId: rw.id } })) === 0);

  // ── Part 5: conflicts with verified records (detected, shown, never overwritten) ──
  const pc = await person();
  const cLink = await prisma.personPatientLink.findFirstOrThrow({ where: { personId: pc.personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  const cFac = cLink.patient.facilityId, cPat = cLink.patientId;
  await decidePersonConsent({ userId: pc.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: cFac } }, select: { id: true, userId: true } });
  const enc = await prisma.encounter.create({ data: { patientId: cPat, facilityId: cFac, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "conflict gate" } });
  const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: cPat, testName: "Creatinine", category: "Biochemistry", orderedByStaffId: staff.id } });
  const verifiedLab = await prisma.labResult.create({ data: { labOrderId: order.id, value: "1.10", unit: "mg/dL", status: "VERIFIED", resultedAt: new Date("2026-02-05T09:00:00Z") } });
  await prisma.allergy.create({ data: { patientId: cPat, substance: "Sulfonamides", severity: "MODERATE", status: "ENTERED_IN_ERROR", verification: "CONFIRMED" } });
  await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: cPat, drugName: "Metformin", dose: "1000 mg", route: "ORAL", frequency: "BD", orderedByStaffId: staff.id, status: "VERIFIED", orderedAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.diagnosis.create({ data: { patientId: cPat, encounterId: enc.id, diagnosis: "Type 2 Diabetes Mellitus", type: "FINAL", status: "RESOLVED", diagnosedByStaffId: staff.id, createdAt: new Date("2025-06-01T00:00:00Z") } });
  for (const id of ["lab-hi-kft", "rx-mr-printed"]) {
    const d = await upload(pc.userId, await fixturePdf(fixtureById(id)!));
    await drain();
    const runId = (await runOf(d.id))!.id;
    const fs = (await listOwnFacts(pc.userId)).filter((f) => f.processingId === runId);
    await bulkReview(pc.userId, { decisions: fs.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
    await drain();
  }
  const conflicts = await prisma.recordConflict.findMany({ where: { personId: pc.personId } });
  const kinds = conflicts.map((c) => c.kind).sort().join(",");
  report("Each rule fires once: lab value, allergy entered in error, medication dose, resolved diagnosis", kinds === "ALLERGY,DIAGNOSIS,LAB_RESULT,MEDICATION_HISTORY", kinds);
  report("…only for the analyte that differs (Creatinine 1.42 vs 1.10; Urea, Sodium, Potassium have no verified result)",
    conflicts.filter((c) => c.kind === "LAB_RESULT").length === 1 && conflicts.find((c) => c.kind === "LAB_RESULT")?.verifiedSourceId === verifiedLab.id);
  const detected = await prisma.domainEventOutbox.findMany({ where: { eventType: "RecordConflictDetected", personId: pc.personId } });
  report("RecordConflictDetected once per conflict, FACILITY-scoped with the personId, no values",
    detected.length === 4 && detected.every((e) => e.facilityId === cFac && !["1.42", "1.10", "Metformin", "Sulfonamides"].some((n) => carries(e.payload, n))));
  for (const r of await prisma.patientProvidedRecord.findMany({ where: { personId: pc.personId } })) await checkRecordConflicts(r.id);
  report("Re-detection is idempotent on the pair", (await prisma.recordConflict.count({ where: { personId: pc.personId } })) === 4);
  report("Nothing was overwritten: the verified result and the entry keep their values",
    (await prisma.labResult.findUniqueOrThrow({ where: { id: verifiedLab.id } })).value === "1.10"
      && ((await prisma.patientProvidedRecord.findFirstOrThrow({ where: { personId: pc.personId, kind: "LAB_RESULT", value: { path: ["analyte"], equals: "Creatinine" } } })).value as { value: string }).value === "1.42");
  const own = await listOwnConflicts(pc.userId);
  const lab = own.find((c) => c.kind === "LAB_RESULT")!;
  report("The person sees each conflict, the verified value first, then 'Your uploaded report says …' with a link to the page",
    own.length === 4 && Object.keys(lab)[Object.keys(lab).indexOf("verified")] === "verified" && Object.keys(lab).indexOf("verified") < Object.keys(lab).indexOf("patientProvided")
      && (lab.verified.value as { value: string }).value === "1.10" && lab.patientProvided?.label === "Your uploaded report says" && !!lab.patientProvided.documentId && lab.patientProvided.pageNo === 1);
  report("The treating facility's clinicians see them (opt-in and care relationship); another facility sees none",
    (await facilityConflicts(cFac, [cPat])).length === 4 && (await facilityConflicts("fac-other-none", [cPat])).length === 0);
  const ack = await acknowledgeConflict({ conflictId: lab.id, facilityId: cFac, staffId: staff.id });
  report("A clinician acknowledges a conflict (RecordConflictAcknowledged); once only; another facility can't",
    ack.status === "ACKNOWLEDGED" && await refusedP(acknowledgeConflict({ conflictId: lab.id, facilityId: cFac, staffId: staff.id })) && await notFound(acknowledgeConflict({ conflictId: lab.id, facilityId: "fac-other-none", staffId: staff.id }))
      && (await prisma.domainEventOutbox.count({ where: { aggregateId: lab.id, eventType: "RecordConflictAcknowledged" } })) === 1);
  // A verified result recorded later is checked against the existing entries (through its event).
  const order2 = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: cPat, testName: "Potassium", category: "Biochemistry", orderedByStaffId: staff.id } });
  const k = await prisma.labResult.create({ data: { labOrderId: order2.id, value: "5.9", unit: "mEq/L", status: "VERIFIED", resultedAt: new Date("2026-02-05T12:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: k.id, facilityId: cFac, payload: { resultId: k.id, orderId: order2.id, patientId: cPat } }));
  await drain();
  report("A verified result released later is checked through its event: a new conflict (Potassium 4.6 vs 5.9)",
    (await prisma.recordConflict.count({ where: { personId: pc.personId, verifiedSourceId: k.id } })) === 1);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
