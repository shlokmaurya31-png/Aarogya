/**
 * Week 4b, RAG step 7 — the leak gate (docs/RAG_DESIGN.md §10.3), zero
 * tolerance. A canary word is planted in a record behind each access limit;
 * the actor that limit excludes asks for it by name, and the canary must
 * never appear in what retrieval returns (chunks and live facts), nor in any
 * row the scope admits at the SQL level. A positive control proves each
 * canary is findable by someone allowed to see it, so a pass means "filtered",
 * not "missing".
 *
 *   1  another patient                     7  an expired share
 *   2  a Noida patient                     8  a proxy (no USE_AI yet)
 *   3  a patient whose AI consent was      9  a nurse's unassigned patient
 *      withdrawn                          10  Person B's uploads and facts: a
 *   4  a category outside the share           treating facility without B's
 *      (uploads)                              opt-in; outside the care window;
 *   5  an entry outside the requested         after B unlinked; Person A's own
 *      period (the timeline's range; the      account
 *      share's own date range comes with  11  a same-organization facility
 *      4c)                                    without consent (and with one:
 *   6  a sensitive category not opted in      only its scopes)
 *      (HIV)                              12  an unconfirmed extracted fact
 *
 * 13 (Week 4c, docs/CONSENT_SHARING_DESIGN.md §10) — real visit codes,
 *    issued with a share and redeemed: a category outside the share (a note,
 *    never shareable; a live medicine without PRESCRIPTIONS), an entry outside
 *    the share's own period, uploads without UPLOADS, a sensitive category not
 *    opted in, a share the patient ended, another doctor holding the code's
 *    id; each with its positive control (a share that admits it).
 * 14 (4c fix, §15) — the new categories and the default share: a condition
 *    without CONDITIONS, vitals without VITALS, a note without CLINICAL_NOTES
 *    (the default leaves notes out), a patient-provided condition without
 *    UPLOADS or without CONDITIONS, a sensitive diagnosis in the default share;
 *    each with its control (the default share, or the category ticked).
 *
 * Every allowed request also goes through POST /api/ai/ask's service
 * (askAi, the mock model, which echoes its sources): the canary must be in
 * none of the prompt's sources, the answer, the citations, the interaction's
 * retrieved and cited chunks, or its stored text (decrypted).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-leaks.ts
 */
import "./lib/gateBootstrap";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { createNote } from "../src/lib/hospital/clinicalNote";
import { decidePersonConsent } from "../src/lib/person/consent";
import { unlinkByPerson } from "../src/lib/person/linking";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { bulkReview, listOwnFacts } from "../src/lib/documents/review";
import { AiAccessError, resolveAiAccess, type AiActor, type AccessRequest } from "../src/lib/rag/access";
import { retrieve } from "../src/lib/rag/retrieve";
import { scopeSql } from "../src/lib/rag/search";
import type { AiMode } from "../src/lib/rag/modes";
import { randomBytes } from "node:crypto";
import { askAi } from "../src/lib/rag/ask";
import { issueAccessCode, redeemAccessCode } from "../src/lib/patient/accessSession";
import { DEFAULT_SHARE_CATEGORIES, parseShareChoice } from "../src/lib/sharing/categories";
import { reindexPerson } from "../src/lib/rag/indexer";
import { endOwnShare } from "../src/lib/sharing/shares";
import { decryptText } from "../src/lib/rag/textCrypto";
import { getRecordAnswerProvider, setRecordAnswerProviderForTest, type AnswerRequest } from "../src/lib/ai/record";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, "");
const canary = (k: string) => `canary${k}${tag}`;
let seq = 0;
let clock = Date.now();
const PUNE = "fac-amc-pune", NOIDA = "fac-amc-noida";

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

/** A staff member of that role at the facility (one is created if the seed has none, e.g. a nurse). */
async function staffOf(facilityId: string, role: "DOCTOR" | "NURSE") {
  let s = await prisma.hospitalStaffProfile.findFirst({ where: { department: { facilityId }, user: { role } }, select: { id: true, userId: true } });
  if (!s) {
    const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
    const user = await prisma.user.create({ data: { email: `rag-leak-${role.toLowerCase()}-${facilityId}-${tag}@verify.aarogya`, passwordHash: "x", role, displayName: `Leak ${role}` } });
    s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role === "NURSE" ? "Ward Nurse" : "Physician" }, select: { id: true, userId: true } });
  }
  return { ...s, actor: { kind: "STAFF", userId: s.userId, role, facilityId } as AiActor };
}

async function person(opts: { facilityId?: string; encounter?: "OPEN" | "OLD" | "NONE" } = {}) {
  seq += 1;
  const a = await registerPatientAccount({ facilityId: opts.facilityId ?? PUNE, fullName: `Leak ${tag} ${seq}`, email: `rag-leak-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1982-02-02") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  const enc = opts.encounter === "NONE" ? null : await prisma.encounter.create({ data: { patientId: link.patientId, facilityId: link.patient.facilityId, type: "OPD", status: opts.encounter === "OLD" ? "CLOSED" : "IN_CONSULTATION", chiefComplaint: "leak gate", ...(opts.encounter === "OLD" ? { registeredAt: new Date("2025-01-01"), closedAt: new Date("2025-01-02") } : {}) } });
  return { userId: a.userId, personId, patientId: link.patientId, facilityId: link.patient.facilityId, linkId: link.id, encounterId: enc?.id ?? null };
}

/** A signed note (through the service, so the indexer sees its event); an old one is written and announced directly. */
async function note(p: { encounterId: string | null; patientId: string; facilityId: string }, text: string, opts: { signedAt?: Date } = {}) {
  const author = await staffOf(p.facilityId, "DOCTOR");
  const encounterId = p.encounterId ?? (await prisma.encounter.create({ data: { patientId: p.patientId, facilityId: p.facilityId, type: "OPD", status: "CLOSED", chiefComplaint: "x", registeredAt: new Date("2025-01-01"), closedAt: new Date("2025-01-02") } })).id;
  if (opts.signedAt) {
    const n = await prisma.clinicalNote.create({ data: { encounterId, authorStaffId: author.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: text }, status: "SIGNED", signedAt: opts.signedAt, createdAt: opts.signedAt } });
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "ClinicalNoteSigned", aggregateId: n.id, facilityId: p.facilityId, encounterId, payload: { entryId: n.id, encounterId, patientId: p.patientId, entryType: "PROGRESS" } }));
    return n.id;
  }
  return (await createNote({ encounterId, authorStaffId: author.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: text }, sign: true, byUserId: author.userId })).id;
}

async function lab(p: { encounterId: string | null; patientId: string; facilityId: string }, testName: string, value: string, resultedAt = new Date()) {
  const author = await staffOf(p.facilityId, "DOCTOR");
  const order = await prisma.labOrder.create({ data: { encounterId: p.encounterId!, patientId: p.patientId, testName, category: "Serology", orderedByStaffId: author.id } });
  const r = await prisma.labResult.create({ data: { labOrderId: order.id, value, status: "VERIFIED", resultedAt } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: r.id, facilityId: p.facilityId, payload: { resultId: r.id, orderId: order.id, patientId: p.patientId } }));
}

type Outcome = { refused: string | null; texts: string; scopeRows: (word: string) => Promise<number> };

/** Everything the provider was sent in this run (the prompt's sources), recorded. */
const sent: AnswerRequest[] = [];
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;

/** The full request through askAi: the prompt, the answer, the citations and the interaction (its text decrypted), as one string. */
async function askThrough(actor: AiActor, req: Omit<AccessRequest, "mode"> & { mode: AiMode }, word: string): Promise<string> {
  await cool(actor.userId);
  const from = sent.length;
  const r = await askAi(actor, { mode: req.mode, patientId: req.patientId, shareId: req.shareId, ...(req.mode === "CHART_QA" ? { question: `${word} details` } : {}), ...(req.period ? { period: { from: req.period.from?.toISOString().slice(0, 10), to: req.period.to?.toISOString().slice(0, 10) } } : {}) });
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });
  const ids = [...row.retrievedChunkIds, ...row.citedChunkIds];
  const chunkTexts = (await prisma.ragChunk.findMany({ where: { id: { in: ids } }, select: { text: true, context: true } })).map((c) => `${c.context}\n${c.text}`);
  // The asker's own question names the canary; what the system added must not: the prompt's sources,
  // the answer, the citations, the interaction's chunks and its stored answer.
  const stored = row.answerCiphertext ? decryptText(row.answerCiphertext, row.keyVersion!) : "";
  return [JSON.stringify(sent.slice(from).map((x) => x.sources)), JSON.stringify(r.sentences), JSON.stringify(r.citations), ...chunkTexts, stored].join("\n");
}

/** Asks as `actor` for `word`: what retrieval returns (all text) and everything the full request touched, or the refusal. */
async function ask(actor: AiActor, req: Omit<AccessRequest, "mode"> & { mode?: AiMode }, word: string): Promise<Outcome> {
  try {
    const mode = req.mode ?? (actor.kind === "PATIENT" ? "HEALTH_TIMELINE" : "CHART_QA");
    const access = await resolveAiAccess(actor, { mode, ...req });
    const r = await retrieve(access, { question: `${word} details` });
    const r2 = await retrieve(access, {});
    const through = await askThrough(actor, { ...req, mode }, word);
    const texts = [...r.chunks, ...r2.chunks].map((c) => `${c.context}\n${c.text}`).concat([...r.live, ...r2.live].map((l) => `${l.context}\n${l.text}`)).join("\n") + "\n" + through;
    const scopeRows = async (w: string) => Number((await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "RagChunk" c WHERE ${scopeSql(access.scope)} AND (c."text" ILIKE ${`%${w}%`} OR c."context" ILIKE ${`%${w}%`})`))[0].n);
    return { refused: null, texts, scopeRows };
  } catch (err) {
    if (err instanceof AiAccessError) return { refused: `${err.status} ${err.code}`, texts: "", scopeRows: async () => 0 };
    throw err;
  }
}

/** The canary is absent: refused, or neither retrieved nor admitted by the scope at the SQL level. */
async function absent(o: Outcome, word: string): Promise<boolean> {
  return !o.texts.toLowerCase().includes(word) && (await o.scopeRows(word)) === 0;
}
const present = (o: Outcome, word: string) => o.refused === null && o.texts.toLowerCase().includes(word);

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  // The gate's own text key (staff text is kept, so the stored text is checked too), and a recording provider.
  process.env.AI_TEXT_KEY_VERSION = "1";
  process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");
  const mock = getRecordAnswerProvider({});
  setRecordAnswerProviderForTest({ id: "mock", async answerFromRecord(req, permit) { sent.push(req); return mock.answerFromRecord(req, permit); } });
  const dP = await staffOf(PUNE, "DOCTOR");
  const nP = await staffOf(PUNE, "NURSE");
  const dN = await staffOf(NOIDA, "DOCTOR");

  // The main patient: treated at Pune now.
  const P = await person({ encounter: "OPEN" });
  await note(P, `Seen today; baseline${tag} recorded.`);

  // 1. Another patient of the same facility.
  const O = await person({ encounter: "NONE" });
  await note(O, `Other patient ${canary("other")}.`);
  // 2. A Noida patient.
  const NP = await person({ facilityId: NOIDA, encounter: "OPEN" });
  await note(NP, `Noida patient ${canary("noida")}.`);
  // 3. AI consent withdrawn.
  const W = await person({ encounter: "OPEN" });
  await note(W, `Withdrawn patient ${canary("withdrawn")}.`);
  // 4, 6, 7. A patient who shares a visit code; an upload and an HIV result behind the share's limits.
  const S = await person({ encounter: "OPEN" });
  // The control is a lab result: notes aren't a shareable category (Week 4c), and a code's default share is the four record categories.
  await lab(S, "Haemoglobin", `11.9 visible${tag}`);
  await lab(S, "HIV 1/2 antibody", `Non-reactive ${canary("hiv")}`);
  await uploadPersonDocument(S.userId, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "u.pdf", title: `Upload ${canary("shareupload")}`, type: "REPORT" });
  await decidePersonConsent({ userId: S.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  // 5. An old entry, outside the period asked about.
  await note(P, `Old entry ${canary("old")}.`, { signedAt: new Date("2020-01-15T10:00:00Z") });
  // 10. Person B (no opt-in), B2 (opt-in, outside the care window), B3 (opt-in, then unlinked).
  const B = await person({ encounter: "OPEN" });
  await uploadPersonDocument(B.userId, { bytes: await fixturePdf(fixtureById("lab-en-thyroid")!), contentType: "application/pdf", originalName: "b.pdf", title: `B upload ${canary("bupload")}`, type: "REPORT" });
  const B2 = await person({ encounter: "OLD" });
  await decidePersonConsent({ userId: B2.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await uploadPersonDocument(B2.userId, { bytes: await fixturePdf(fixtureById("lab-en-thyroid")!), contentType: "application/pdf", originalName: "b2.pdf", title: `B2 upload ${canary("bwindow")}`, type: "REPORT" });
  const B3 = await person({ encounter: "OPEN" });
  await decidePersonConsent({ userId: B3.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await uploadPersonDocument(B3.userId, { bytes: await fixturePdf(fixtureById("lab-en-thyroid")!), contentType: "application/pdf", originalName: "b3.pdf", title: `B3 upload ${canary("bunlinked")}`, type: "REPORT" });
  // 12. P's own upload, read but not yet confirmed: its values must never be indexed.
  await uploadPersonDocument(P.userId, { bytes: await fixturePdf(fixtureById("lab-hi-kft")!), contentType: "application/pdf", originalName: "p.pdf", title: "P report", type: "REPORT" });
  await drain();
  await decidePersonConsent({ userId: W.userId, purpose: "AI_ASSISTANCE", decision: "DECLINED" });
  await unlinkByPerson(B3.userId, B3.linkId);
  await drain();
  report("Fixtures indexed (the canaries are in the index, behind their limits)", (await prisma.ragChunk.count({ where: { text: { contains: tag } } })) >= 6);

  // 1. Another patient.
  const o1 = await ask(dP.actor, { patientId: P.patientId }, canary("other"));
  report("1 Another patient's canary never reaches the doctor asking about P", o1.refused === null && await absent(o1, canary("other")));
  report("1 …and asking about that patient (no care relationship) is a 404", (await ask(dP.actor, { patientId: O.patientId }, canary("other"))).refused === "404 NOT_FOUND");
  const o1c = await prisma.ragChunk.count({ where: { patientId: O.patientId, text: { contains: canary("other") } } });
  report("1 (control: the canary is in the index, as O's)", o1c >= 1);

  // 2. Noida.
  report("2 A Pune doctor asking about a Noida patient: 404", (await ask(dP.actor, { patientId: NP.patientId }, canary("noida"))).refused === "404 NOT_FOUND");
  report("2 …and Noida's canary is never in Pune's scope", await absent(o1, canary("noida")));
  const n2 = await ask(dN.actor, { patientId: NP.patientId }, canary("noida"));
  report("2 (control: Noida's own doctor finds it)", present(n2, canary("noida")));

  // 3. AI consent withdrawn.
  const w3 = await ask(dP.actor, { patientId: W.patientId }, canary("withdrawn"));
  report("3 AI consent withdrawn: refused (403), and the record is out of the index", w3.refused === "403 AI_AI_DECLINED" && (await prisma.ragChunk.count({ where: { text: { contains: canary("withdrawn") } } })) === 0);

  // 4, 6, 7. The visit code.
  const now = Date.now();
  const share = await prisma.patientAccessSession.create({ data: { patientId: S.patientId, codeHash: `leak-${tag}-1`, status: "ACTIVE", doctorUserId: dP.userId, doctorStaffId: dP.id, facilityId: PUNE, expiresAt: new Date(now + 600_000), activeExpiresAt: new Date(now + 900_000), redeemedAt: new Date() } });
  const s4 = await ask(dP.actor, { patientId: S.patientId, shareId: share.id }, canary("shareupload"));
  report("4 Through the visit code: the record is there, the patient's uploads (a category outside it) are not", s4.refused === null && s4.texts.includes(`visible${tag}`) && await absent(s4, canary("shareupload")));
  report("6 …nor the HIV result (a sensitive category not opted in)", await absent(await ask(dP.actor, { patientId: S.patientId, shareId: share.id }, canary("hiv")), canary("hiv")));
  const t6 = await ask(dP.actor, { patientId: S.patientId }, canary("hiv"));
  report("6 (control: the treating path, where the chart permission decides, finds the HIV result and, with the opt-in, the upload)", present(t6, canary("hiv")) && present(await ask(dP.actor, { patientId: S.patientId }, canary("shareupload")), canary("shareupload")));
  const expired = await prisma.patientAccessSession.create({ data: { patientId: S.patientId, codeHash: `leak-${tag}-2`, status: "ACTIVE", doctorUserId: dN.userId, doctorStaffId: dN.id, facilityId: NOIDA, expiresAt: new Date(now - 3_600_000), activeExpiresAt: new Date(now - 60_000), redeemedAt: new Date(now - 3_600_000) } });
  report("7 An expired visit code: 404", (await ask(dN.actor, { patientId: S.patientId, shareId: expired.id }, `visible${tag}`)).refused === "404 NOT_FOUND");
  report("7 …and someone else's code: 404", (await ask(dN.actor, { patientId: S.patientId, shareId: share.id }, `visible${tag}`)).refused === "404 NOT_FOUND");

  // 5. The period.
  const p5 = await ask(dP.actor, { patientId: P.patientId, mode: "HEALTH_TIMELINE", period: { from: new Date("2026-01-01"), to: new Date("2027-12-31") } }, canary("old"));
  report("5 An entry outside the period asked about never comes back", p5.refused === null && await absent(p5, canary("old")));
  report("5 (control: without a period it does)", present(await ask(dP.actor, { patientId: P.patientId, mode: "HEALTH_TIMELINE" }, canary("old")), canary("old")));

  // 8. A proxy.
  const proxy = await prisma.user.create({ data: { email: `rag-leak-proxy-${tag}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "Proxy" } });
  await prisma.patientDelegation.create({ data: { patientId: P.patientId, delegateUserId: proxy.id, relationship: "PARENT", status: "ACTIVE", acceptedAt: new Date(), scopes: { create: [{ scope: "RECORDS" }, { scope: "REPORTS" }] } } });
  report("8 A family member (a delegate; no USE_AI permission yet): 404", (await ask({ kind: "PATIENT", userId: proxy.id }, { patientId: P.patientId }, `baseline${tag}`)).refused === "404 NOT_FOUND");

  // 9. The nurse.
  report("9 A nurse asking about a patient not assigned to them: 404", (await ask(nP.actor, { patientId: P.patientId }, `baseline${tag}`)).refused === "404 NOT_FOUND");
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nP.id, patientId: P.patientId, assignedByStaffId: dP.id, startAt: new Date(now - 3_600_000) } });
  const n9 = await ask(nP.actor, { patientId: P.patientId }, canary("other"));
  report("9 Assigned: allowed, and another patient's canary still absent", n9.refused === null && n9.texts.includes(`baseline${tag}`) && await absent(n9, canary("other")));
  report("9 …a nurse can't use the visit brief", (await ask(nP.actor, { patientId: P.patientId, mode: "VISIT_BRIEF" }, "x")).refused === "403 MODE_NOT_ALLOWED");

  // 10. Person B's uploads and facts.
  const b10 = await ask(dP.actor, { patientId: B.patientId }, canary("bupload"));
  report("10 A treating facility without B's opt-in: B's own upload is never a candidate", b10.refused === null && await absent(b10, canary("bupload")));
  report("10 Outside the care window (B2 opted in, last seen long ago): 404", (await ask(dP.actor, { patientId: B2.patientId }, canary("bwindow"))).refused === "404 NOT_FOUND");
  const b3 = await ask(dP.actor, { patientId: B3.patientId }, canary("bunlinked"));
  report("10 After B3 unlinked: B3's uploads are unreachable from the facility", (b3.refused !== null) || await absent(b3, canary("bunlinked")), b3.refused ?? "allowed, absent");
  const a10 = await ask({ kind: "PATIENT", userId: P.userId }, { patientId: P.patientId }, canary("bupload"));
  report("10 Person A's own account never sees B's", a10.refused === null && await absent(a10, canary("bupload")) && await absent(a10, canary("other")));
  report("10 (control: B sees their own upload)", present(await ask({ kind: "PATIENT", userId: B.userId }, { patientId: B.patientId }, canary("bupload")), canary("bupload")));

  // 11. Another facility of the same organization.
  report("11 A Noida doctor asking about a Pune patient without consent: 404", (await ask(dN.actor, { patientId: P.patientId }, `baseline${tag}`)).refused === "404 NOT_FOUND");
  const org = await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { organizationId: true } });
  await lab(P, "Serum ferritin", `42 ${canary("orglab")}`);
  await drain();
  await prisma.interopConsent.create({ data: { facilityId: PUNE, patientId: P.patientId, purpose: "TREATMENT", status: "GRANTED", recipientType: "ORGANIZATION", recipientIdentifier: org.organizationId, grantedAt: new Date(), grantedBy: "PATIENT", scopes: { create: [{ scope: "LAB" }] } } });
  const c11 = await ask(dN.actor, { patientId: P.patientId }, canary("orglab"));
  report("11 With the patient's consent to the organization (labs only): the lab result, and no note", present(c11, canary("orglab")) && await absent(c11, `baseline${tag}`));

  // 12. The unconfirmed extracted fact.
  const p12 = await ask({ kind: "PATIENT", userId: P.userId }, { patientId: P.patientId }, "creatinine");
  report("12 Values read from an upload but not yet confirmed are never retrieved (nor indexed)", p12.refused === null && await absent(p12, "ganga pathology") && await absent(p12, "1.42")
    && (await prisma.ragChunk.count({ where: { personId: P.personId, text: { contains: "1.42" } } })) === 0);
  const facts = await listOwnFacts(P.userId);
  await bulkReview(P.userId, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  await drain();
  report("12 (control: once confirmed, they are)", present(await ask({ kind: "PATIENT", userId: P.userId }, { patientId: P.patientId }, "creatinine"), "1.42"));

  // 13. Week 4c: shares with categories, a period and sensitive opt-ins, through real codes.
  const C = await person({ encounter: "OPEN" });
  await decidePersonConsent({ userId: C.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await lab(C, "Haemoglobin", `12.1 ${canary("c4lab")}`);
  await lab(C, "Serum creatinine", `0.9 ${canary("c4old")}`, new Date("2020-03-03T09:00:00Z"));
  await lab(C, "HIV 1/2 antibody", `Non-reactive ${canary("c4hiv")}`);
  await note(C, `Consult note ${canary("c4note")}.`);
  const cDoc = await staffOf(PUNE, "DOCTOR");
  await prisma.medicationOrder.create({ data: { encounterId: C.encounterId!, patientId: C.patientId, drugName: `Drug${canary("c4rx")}`, dose: "1 tab", route: "ORAL", frequency: "OD", orderedByStaffId: cDoc.id, status: "ACTIVE" } });
  await uploadPersonDocument(C.userId, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "c.pdf", title: `Upload ${canary("c4up")}`, type: "REPORT" });
  await drain();
  const code = async (choice: Parameters<typeof parseShareChoice>[0]) => {
    const issued = await issueAccessCode(C.patientId, C.userId, "leak gate", { choice: parseShareChoice(choice) });
    const s = await redeemAccessCode({ code: issued.code, doctorUserId: dP.userId, doctorStaffId: dP.id, doctorName: "Leak doctor", facilityId: PUNE });
    if (!s) throw new Error("redeem");
    return s;
  };
  const viaCode = (sessionId: string, word: string) => ask(dP.actor, { patientId: C.patientId, shareId: sessionId }, word);
  const a13 = await code({ categories: ["LABS"] });
  report("13 A LABS-only code: the lab result is there (control)", present(await viaCode(a13.id, canary("c4lab")), canary("c4lab")));
  report("13 …a note doesn't come through a share without CLINICAL_NOTES", await absent(await viaCode(a13.id, canary("c4note")), canary("c4note")));
  report("13 (control: the treating path, without a share, finds the note)", present(await ask(dP.actor, { patientId: C.patientId }, canary("c4note")), canary("c4note")));
  report("13 …nor an active medicine without PRESCRIPTIONS (live facts follow the categories)", await absent(await viaCode(a13.id, canary("c4rx")), canary("c4rx")));
  report("13 …nor the patient's upload without UPLOADS", await absent(await viaCode(a13.id, canary("c4up")), canary("c4up")));
  report("13 …nor the HIV result without its opt-in", await absent(await viaCode(a13.id, canary("c4hiv")), canary("c4hiv")));
  report("13 …and with no period, the 2020 result is there (control for the period)", present(await viaCode(a13.id, canary("c4old")), canary("c4old")));
  const b13 = await code({ categories: ["LABS", "PRESCRIPTIONS", "UPLOADS"], period: { from: "2026-01-01" } });
  report("13 A share from 2026 on: the 2020 result never comes back", await absent(await viaCode(b13.id, canary("c4old")), canary("c4old")));
  report("13 …with PRESCRIPTIONS the active medicine does (control)", present(await viaCode(b13.id, canary("c4rx")), canary("c4rx")));
  report("13 …with UPLOADS the upload does (control)", present(await viaCode(b13.id, canary("c4up")), canary("c4up")));
  report("13 …and still not the HIV result", await absent(await viaCode(b13.id, canary("c4hiv")), canary("c4hiv")));
  const c13 = await code({ categories: ["LABS"], sensitiveCategories: ["HIV"] });
  report("13 With the HIV opt-in, the HIV result is there (control)", present(await viaCode(c13.id, canary("c4hiv")), canary("c4hiv")));
  report("13 Another doctor holding the code's id: 404", (await ask(dN.actor, { patientId: C.patientId, shareId: c13.id }, canary("c4lab"))).refused === "404 NOT_FOUND");
  report("13 The first code, superseded when the next was issued: 404", (await viaCode(a13.id, canary("c4lab"))).refused === "404 NOT_FOUND");
  await endOwnShare(C.userId, c13.shareId!);
  report("13 Once the patient ends the share: 404, at once", (await viaCode(c13.id, canary("c4lab"))).refused === "404 NOT_FOUND");

  // 14. The 4c fix: CONDITIONS, VITALS, CLINICAL_NOTES and the default share.
  const D = await person({ encounter: "OPEN" });
  const dAuthor = await staffOf(PUNE, "DOCTOR");
  await prisma.diagnosis.create({ data: { patientId: D.patientId, encounterId: D.encounterId!, diagnosis: `Gonarthrosis ${canary("c5dx")}`, type: "FINAL", diagnosedByStaffId: dAuthor.id } });
  await prisma.problem.create({ data: { patientId: D.patientId, diagnosis: `Hypertension ${canary("c5pl")}`, status: "ACTIVE" } });
  await prisma.diagnosis.create({ data: { patientId: D.patientId, encounterId: D.encounterId!, diagnosis: `Bipolar affective disorder ${canary("c5sdx")}`, code: "F31.9", codeSystem: "ICD-10", type: "FINAL", diagnosedByStaffId: dAuthor.id } });
  await prisma.vital.create({ data: { encounterId: D.encounterId!, recordedByStaffId: dAuthor.id, sbp: 211, dbp: 133 } });
  await note(D, `Knee review ${canary("c5note")}.`);
  await prisma.$transaction(async (tx) => {
    const doc = await tx.personDocument.create({ data: { personId: D.personId, type: "REPORT", title: "D old report", storageRef: `patient-uploads/${D.personId}/00000000000000d1-d.pdf`, sha256: "2".repeat(64), contentType: "application/pdf", uploadedByUserId: D.userId } });
    await tx.patientProvidedRecord.create({ data: { personId: D.personId, kind: "DIAGNOSIS", value: { text: `Meniscus tear ${canary("c5ppd")}` }, factId: `leak-fact-${tag}`, documentId: doc.id, pageNo: 1, effectiveDate: new Date() } });
  });
  await uploadPersonDocument(D.userId, { bytes: await fixturePdf(fixtureById("lab-en-cbc")!), contentType: "application/pdf", originalName: "d.pdf", title: `MRI knee ${canary("c5up")}`, type: "REPORT" });
  await drain();
  await reindexPerson(D.personId);
  const VITALS = "211/133";
  const codeD = async (choice: Parameters<typeof parseShareChoice>[0], defaults = false) => {
    const issued = await issueAccessCode(D.patientId, D.userId, "leak gate", { choice: parseShareChoice(choice, defaults ? { categories: DEFAULT_SHARE_CATEGORIES } : {}) });
    const s = await redeemAccessCode({ code: issued.code, doctorUserId: dP.userId, doctorStaffId: dP.id, doctorName: "Leak doctor", facilityId: PUNE });
    if (!s) throw new Error("redeem");
    return s;
  };
  const viaD = (sessionId: string, word: string) => ask(dP.actor, { patientId: D.patientId, shareId: sessionId }, word);
  const d14 = await codeD({}, true);
  report("14 The default share: the diagnosis and the problem list are there (control for CONDITIONS)", present(await viaD(d14.id, canary("c5dx")), canary("c5dx")) && present(await viaD(d14.id, canary("c5pl")), canary("c5pl")));
  report("14 …the vitals (control for VITALS)", present(await viaD(d14.id, VITALS), VITALS));
  report("14 …the upload and the confirmed patient-provided condition (control for UPLOADS + CONDITIONS)", present(await viaD(d14.id, canary("c5up")), canary("c5up")) && present(await viaD(d14.id, canary("c5ppd")), canary("c5ppd")));
  report("14 …but no clinical note (the default leaves notes out)", await absent(await viaD(d14.id, canary("c5note")), canary("c5note")));
  report("14 …and no sensitive (psychiatric) diagnosis without its opt-in", await absent(await viaD(d14.id, canary("c5sdx")), canary("c5sdx")));
  const e14 = await codeD({ categories: ["LABS"] });
  report("14 Without CONDITIONS: no diagnosis, no problem", await absent(await viaD(e14.id, canary("c5dx")), canary("c5dx")) && await absent(await viaD(e14.id, canary("c5pl")), canary("c5pl")));
  report("14 Without VITALS: no vitals", await absent(await viaD(e14.id, VITALS), VITALS));
  const f14 = await codeD({ categories: ["CONDITIONS"] });
  report("14 CONDITIONS without UPLOADS: the diagnosis yes, the patient-provided condition no", present(await viaD(f14.id, canary("c5dx")), canary("c5dx")) && await absent(await viaD(f14.id, canary("c5ppd")), canary("c5ppd")));
  const g14 = await codeD({ categories: ["UPLOADS", "LABS"] });
  report("14 UPLOADS without CONDITIONS: the upload yes, the patient-provided condition no", present(await viaD(g14.id, canary("c5up")), canary("c5up")) && await absent(await viaD(g14.id, canary("c5ppd")), canary("c5ppd")));
  const h14 = await codeD({ categories: ["CLINICAL_NOTES", "CONDITIONS"], sensitiveCategories: ["MENTAL_HEALTH"] });
  report("14 CLINICAL_NOTES ticked: the note is there (control)", present(await viaD(h14.id, canary("c5note")), canary("c5note")));
  report("14 The MENTAL_HEALTH opt-in: the psychiatric diagnosis is there (control)", present(await viaD(h14.id, canary("c5sdx")), canary("c5sdx")));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
