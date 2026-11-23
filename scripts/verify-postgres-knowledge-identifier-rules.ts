/**
 * Decisions before Phase 3 (docs/RAG_IMPLEMENTATION_PLAN.md §13.4 B and C), on
 * a fresh database, mock embeddings, synthetic documents only. Every refusal
 * or absence has a positive control beside it.
 *
 *   C1  a 12-digit number that passes the Aadhaar checksum (and starts 2–9)
 *       refuses the file, with nothing kept: no version, no stored file, no
 *       highlight, and the audit names only the kind;
 *   C2  any other 12-digit number (checksum fails, or starts 0 or 1) is kept
 *       and highlighted; the excerpt masks it to its last four digits, and no
 *       row of the database holds the full number outside the stored file;
 *   C3  a mobile on the facility's published list is allowed; another mobile
 *       is highlighted; another facility's list doesn't help a facility
 *       document; an organisation-wide document may print any facility's;
 *   C4  the list: added and removed by the hospital administrator, each
 *       audited and emitted; a duplicate is refused; a removed number keeps
 *       its row and is highlighted again; another facility's number is not
 *       found;
 *   C5  approval: refused without every highlight acknowledged (none, some,
 *       or one of another version's); with all, approved, each highlight
 *       records who acknowledged it and when, the audit lists them; the
 *       database refuses an approved, highlighted version with no
 *       acknowledgement;
 *   C6  ABHA, UHID/MRN and names with ages are still refused outright;
 *   B   withdrawing the version in force never restores the one before it;
 *       an older, once-published version can be proposed again as the next
 *       version (two-person approval: the proposer can't approve), never the
 *       version in force or one never published, never twice at once; it is
 *       ingested from the cache and, once approved, is the one in force.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { readdirSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { RetryableEventError } from "../src/lib/events/types";
import { approveKnowledgeVersion, reproposeKnowledgeVersion, uploadKnowledge, withdrawKnowledgeVersion, type KnowledgeActor } from "../src/lib/knowledge/service";
import { addFacilityContact, listFacilityContacts, removeFacilityContact } from "../src/lib/knowledge/contacts";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { KnowledgeError } from "../src/lib/knowledge/errors";
import { searchKnowledge } from "../src/lib/rag/knowledgeSearch";
import { NOIDA, PUNE, staffUser } from "./lib/knowledgeGate";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);
const word = (s: string) => `${s}${tag}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
const utf8 = (s: string) => Buffer.from(s, "utf8");
const ALL = ["ALL_STAFF", "CLINICAL", "PHARMACY", "BILLING", "ADMIN"] as const;

// Synthetic: checksum-valid (234567890124, 345678901238) and checksum-failing (234567890123) twelve-digit numbers.
const AADHAAR_VALID = "2345 6789 0124";
const AADHAAR_VALID_PLAIN = "345678901238";
const TWELVE_INVALID = "2345 6789 0123";
// Checksum-valid but starting 1: never Aadhaar.
const TWELVE_STARTS_1 = Array.from({ length: 10 }, (_, k) => `12345678901${k}`).find((n) => {
  const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  let c = 0; [...n].reverse().forEach((d, i) => { c = D[c][P[i % 8][Number(d)]]; }); return c === 0;
})!;
// Mobiles, made distinct per run so earlier runs' contact lists don't interfere.
const suffix = String(Date.now() % 100000).padStart(5, "0");
const MOBILE_LISTED = `98${suffix}111`;
const MOBILE_OTHER = `91${suffix}222`;
const MOBILE_NOIDA = `88${suffix}333`;

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof KnowledgeError ? e.code : (e as Error).message; }
}
async function md(actor: KnowledgeActor, name: string, body: string, extra: Partial<Parameters<typeof uploadKnowledge>[1]> = {}) {
  return uploadKnowledge(actor, { title: `${name} ${tag}`, documentType: "SOP", accessClass: "CLINICAL", fileName: `${name.replace(/\s/g, "-")}-${tag}.md`, declaredType: "text/markdown", bytes: utf8(body), ...extra });
}
async function ingest(versionId: string) {
  return ingestKnowledgeVersion(versionId).catch((e) => { if (!(e instanceof RetryableEventError)) throw e; return "RETRY"; });
}
/** The last four digits of the highlighted number itself (the excerpt brackets it). */
const bracketed = (excerpt: string) => excerpt.match(/\[•*(\d{4})\]/)?.[1];
const highlightsOf = (versionId: string) => prisma.knowledgeIdentifierHighlight.findMany({ where: { versionId }, orderBy: { ordinal: "asc" } });
const has = async (a: KnowledgeActor, canary: string) => (await searchKnowledge({ organizationId: a.organizationId, facilityId: a.facilityId, accessClasses: [...ALL] }, canary, { limit: 20 })).some((h) => h.text.toLowerCase().includes(canary));

async function main() {
  registerAllConsumers();
  const admin = await staffUser(`kir-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE, { orgAdmin: true });
  const facilityAdmin = await staffUser(`kir-fadmin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE);
  const superintendent = await staffUser(`kir-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE);
  const quality = await staffUser(`kir-quality-${tag}@verify.aarogya`, "QUALITY_LEAD", PUNE);
  const noidaAdmin = await staffUser(`kir-noida-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", NOIDA);
  for (let i = 0; i < 20; i++) if (!(await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 30_000 })).claimed) break;

  const storeDir = path.resolve(__dirname, "..", ".data", "object-store", "knowledge-documents");
  const files = () => { try { return readdirSync(storeDir, { recursive: true }).length; } catch { return 0; } };
  const versionsByTag = () => prisma.knowledgeDocumentVersion.count({ where: { document: { title: { contains: tag } } } });

  // ── C1: a checksum-valid Aadhaar number refuses the file; nothing kept ──
  const nFiles = files(), nVersions = await versionsByTag(), nHighlights = await prisma.knowledgeIdentifierHighlight.count();
  const auditBefore = await prisma.auditEvent.count({ where: { type: "knowledge.upload.refused" } });
  report("C1: a 12-digit number passing the Aadhaar checksum is refused (grouped)", (await codeOf(md(facilityAdmin, "ID policy", `# ID\n\nExample card ${AADHAAR_VALID} must be masked.\n`))) === "CONTAINS_IDENTIFIERS");
  report("C1: … and written as one run of digits", (await codeOf(md(facilityAdmin, "ID policy two", `# ID\n\nCard ${AADHAAR_VALID_PLAIN}.\n`))) === "CONTAINS_IDENTIFIERS");
  report("C1: nothing kept — no version, no stored file, no highlight", (await versionsByTag()) === nVersions && files() === nFiles && (await prisma.knowledgeIdentifierHighlight.count()) === nHighlights);
  const refusedAudit = await prisma.auditEvent.findFirst({ where: { type: "knowledge.upload.refused" }, orderBy: { createdAt: "desc" } });
  report("C1: the audit names the kind only, never the number", (await prisma.auditEvent.count({ where: { type: "knowledge.upload.refused" } })) === auditBefore + 2
    && JSON.stringify(refusedAudit?.detail).includes("AADHAAR_NUMBER") && !/2345|3456|7890/.test(JSON.stringify(refusedAudit?.detail)));

  // ── C2: any other 12-digit number is highlighted, masked ──
  const c2 = word("twelvecanary");
  const u2 = await md(facilityAdmin, "Lot register", `# Lot register\n\nLot ${TWELVE_INVALID} for ${c2}.\n\nGTIN ${TWELVE_STARTS_1} on the carton.\n`);
  const h2 = await highlightsOf(u2.versionId);
  report("C2: a checksum-failing 12-digit number and one starting 1 are kept and highlighted", h2.length === 2 && h2.every((h) => h.kind === "TWELVE_DIGIT_NUMBER" && h.location === "TEXT"), h2.map((h) => h.kind).join());
  report("C2: each excerpt shows the last four digits only", h2[0]?.excerpt.includes("[••••••••0123]") && h2[1]?.excerpt.includes(`[••••••••${TWELVE_STARTS_1.slice(-4)}]`) && !h2.some((h) => /\d{5}/.test(h.excerpt)), h2[0]?.excerpt);
  const v2 = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: u2.versionId } });
  report("C2: the version counts its highlights", v2.highlightCount === 2 && v2.highlightsAcknowledgedAt === null);
  const leak = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "KnowledgeIdentifierHighlight" WHERE "excerpt" LIKE ${"%234567890123%"} OR "excerpt" LIKE ${"%2345 6789 0123%"} OR "excerpt" LIKE ${`%${TWELVE_STARTS_1}%`}`;
  report("C2: no highlight row holds a full number", Number(leak[0].n) === 0);
  report("C2: the database refuses an excerpt with seven digits in a row", await prisma.knowledgeIdentifierHighlight.create({ data: { versionId: u2.versionId, ordinal: 99, kind: "TWELVE_DIGIT_NUMBER", location: "TEXT", excerpt: "Lot 2345678 x" } }).then(() => false, () => true));

  // ── C4 (first half): the published list ──
  const listed = await addFacilityContact(facilityAdmin, { kind: "AMBULANCE", label: `Ambulance ${tag}`, number: `+91 ${MOBILE_LISTED.slice(0, 5)} ${MOBILE_LISTED.slice(5)}` });
  report("C4: the administrator adds a number; stored as ten digits", listed.number === MOBILE_LISTED && (await listFacilityContacts(facilityAdmin)).some((c) => c.id === listed.id));
  report("C4: the addition is audited and emitted in the same transaction",
    (await prisma.auditEvent.count({ where: { type: "knowledge.contact.added", userId: facilityAdmin.userId } })) === 1
      && (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityContactPublished", payload: { path: ["contactId"], equals: listed.id } } })) === 1);
  report("C4: the same number again is refused", (await codeOf(addFacilityContact(facilityAdmin, { kind: "HELPLINE", label: "Again", number: `0${MOBILE_LISTED}` }))) === "CONTACT_EXISTS");
  report("C4: a landline or toll-free number isn't accepted (they never need listing)", (await codeOf(addFacilityContact(facilityAdmin, { kind: "HELPLINE", label: "Toll free", number: "1800116117" }))) === "INVALID");
  const noidaListed = await addFacilityContact(noidaAdmin, { kind: "SWITCHBOARD", label: `Noida board ${tag}`, number: MOBILE_NOIDA });
  report("C4: another facility's number is not found (Pune can't remove Noida's)", /Not found/.test((await codeOf(removeFacilityContact(facilityAdmin, noidaListed.id))) ?? ""));
  report("C4: each facility lists only its own", !(await listFacilityContacts(facilityAdmin)).some((c) => c.id === noidaListed.id));

  // ── C3: mobiles ──
  const c3 = word("mobilecanary");
  const u3 = await md(facilityAdmin, "Ambulance SOP", `# Ambulance\n\nCall the ambulance on ${MOBILE_LISTED} or +91 ${MOBILE_LISTED}. ${c3}.\n\nThe ward phone ${MOBILE_OTHER} is not public.\n\nNoida's board is ${MOBILE_NOIDA}.\n`);
  const h3 = await highlightsOf(u3.versionId);
  report("C3: a listed mobile is allowed, in any written form; another is highlighted; another facility's list doesn't help a facility document",
    h3.length === 2 && h3.every((h) => h.kind === "MOBILE_NUMBER") && bracketed(h3[0].excerpt) === MOBILE_OTHER.slice(-4) && bracketed(h3[1].excerpt) === MOBILE_NOIDA.slice(-4), h3.map((h) => h.excerpt).join(" | "));
  const u3o = await md(admin, "Group ambulance SOP", `# Ambulance\n\nPune ${MOBILE_LISTED}; Noida ${MOBILE_NOIDA}. ${word("orgwide")}.\n`, { scope: "ORGANIZATION" });
  report("C3: an organisation-wide document may print any facility's published number", (await highlightsOf(u3o.versionId)).length === 0);
  const u3m = await md(facilityAdmin, "Number in title", "# Title\n\nPlain text.\n", { title: `Call ${MOBILE_OTHER} ${tag}` });
  const h3m = await highlightsOf(u3m.versionId);
  report("C3: a mobile in the title is highlighted as in the details", h3m.length === 1 && h3m[0].location === "DETAILS");

  // ── C4 (second half): removal ──
  await removeFacilityContact(facilityAdmin, listed.id);
  const removed = await prisma.facilityPublishedContact.findUniqueOrThrow({ where: { id: listed.id } });
  report("C4: a removed number keeps its row, with who removed it and when", removed.removedAt !== null && removed.removedByUserId === facilityAdmin.userId);
  report("C4: the removal is audited and emitted",
    (await prisma.auditEvent.count({ where: { type: "knowledge.contact.removed", userId: facilityAdmin.userId } })) === 1
      && (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityContactRemoved", payload: { path: ["contactId"], equals: listed.id } } })) === 1);
  const u4 = await md(facilityAdmin, "Ambulance SOP again", `# Ambulance\n\nCall ${MOBILE_LISTED}. ${word("afterremoval")}.\n`);
  report("C4: once removed, the number is highlighted again", (await highlightsOf(u4.versionId)).length === 1);

  // ── C5: approval needs every highlight acknowledged ──
  report("C5 setup: the highlighted version is indexed", (await ingest(u3.versionId)) === "INDEXED");
  report("C5: approval with no acknowledgement is refused", (await codeOf(approveKnowledgeVersion(superintendent, u3.versionId))) === "HIGHLIGHTS_NOT_ACKNOWLEDGED");
  report("C5: … with some of them", (await codeOf(approveKnowledgeVersion(superintendent, u3.versionId, { acknowledgedHighlightIds: [h3[0].id] }))) === "HIGHLIGHTS_NOT_ACKNOWLEDGED");
  report("C5: … with another version's highlight in their place", (await codeOf(approveKnowledgeVersion(superintendent, u3.versionId, { acknowledgedHighlightIds: [h3[0].id, h2[0].id] }))) === "HIGHLIGHTS_NOT_ACKNOWLEDGED");
  report("C5: … and with all of them plus another version's", (await codeOf(approveKnowledgeVersion(superintendent, u3.versionId, { acknowledgedHighlightIds: [...h3.map((h) => h.id), h2[0].id] }))) === "HIGHLIGHTS_NOT_ACKNOWLEDGED");
  report("C5: a refused approval changed nothing", (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: u3.versionId } })).approvalStatus === "SUBMITTED" && !(await has(superintendent, c3)));
  const before = new Date();
  const ap3 = await approveKnowledgeVersion(superintendent, u3.versionId, { acknowledgedHighlightIds: h3.map((h) => h.id) });
  const h3a = await highlightsOf(u3.versionId);
  const v3 = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: u3.versionId } });
  report("C5: with every highlight acknowledged, approved and published", ap3.published === true && (await has(superintendent, c3)));
  report("C5: each highlight records who acknowledged it and when; so does the version",
    h3a.every((h) => h.acknowledgedByUserId === superintendent.userId && h.acknowledgedAt && h.acknowledgedAt >= before) && v3.highlightsAcknowledgedAt !== null);
  const apAudit = await prisma.auditEvent.findFirst({ where: { type: "knowledge.version.approved", userId: superintendent.userId }, orderBy: { createdAt: "desc" } });
  report("C5: the approval audit lists the acknowledged highlights", h3.every((h) => JSON.stringify(apAudit?.detail).includes(h.id)));
  report("C5 control: a version with no highlights is approved with none named", (await ingest(u3o.versionId)) === "INDEXED" && (await approveKnowledgeVersion(superintendent, u3o.versionId)).published === true);
  report("C5 setup: the twelve-digit version is indexed", (await ingest(u2.versionId)) === "INDEXED");
  report("C5: the database refuses an approved, highlighted version with no acknowledgement",
    await prisma.knowledgeDocumentVersion.update({ where: { id: u2.versionId }, data: { approvalStatus: "APPROVED", approvedByUserId: quality.userId, approvedAt: new Date() } }).then(() => false, () => true));

  // ── C6: the outright refusals stand ──
  const nV6 = await versionsByTag(), nF6 = files();
  for (const [kind, body] of [["ABHA", "ABHA 91-2345-6789-0123 linked."], ["UHID", "Patient UHID-AMCP-7Q2XKD admitted."], ["MRN", "MRN: 00451234 on the wristband."], ["name with age", "Mr. Ramesh Kumar, 45 years, reviewed."]] as const) {
    report(`C6: ${kind} still refuses the file`, (await codeOf(md(facilityAdmin, `Refused ${kind}`, `# Case\n\n${body}\n`))) === "CONTAINS_IDENTIFIERS");
  }
  report("C6: nothing of a refused file is kept", (await versionsByTag()) === nV6 && files() === nF6);

  // ── B: withdrawal never restores; re-proposal under two-person approval ──
  const old = word("oldprotocol"), next = word("newprotocol");
  const b1 = await md(facilityAdmin, "Protocol", `# Protocol\n\nGive fluids. ${old}.\n\n## Monitoring\n\nCheck every 4 hours.\n`);
  await ingest(b1.versionId);
  await approveKnowledgeVersion(superintendent, b1.versionId);
  const b2 = await md(facilityAdmin, "Protocol", `# Protocol\n\nGive fluids and oxygen. ${next}.\n`, { documentId: b1.documentId });
  await ingest(b2.versionId);
  await approveKnowledgeVersion(quality, b2.versionId);
  report("B setup: version 2 in force, version 1 superseded", (await has(superintendent, next)) && !(await has(superintendent, old)));
  report("B: the version in force can't be proposed again", (await codeOf(reproposeKnowledgeVersion(facilityAdmin, b2.versionId))) === "NOT_REPROPOSABLE");
  report("B: a version never in force can't be proposed again", (await codeOf(reproposeKnowledgeVersion(facilityAdmin, u4.versionId))) === "NOT_REPROPOSABLE");
  await withdrawKnowledgeVersion(facilityAdmin, b2.versionId, "Wrong oxygen target");
  const docB = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: b1.documentId } });
  const v1After = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: b1.versionId } });
  report("B: withdrawing the version in force leaves no version in force; the one before is not restored",
    docB.currentVersionId === null && v1After.supersededByVersionId === b2.versionId && !(await has(superintendent, old)) && !(await has(superintendent, next)));
  report("B: Noida's administrator can't propose Pune's version (not found)", /Not found/.test((await codeOf(reproposeKnowledgeVersion(noidaAdmin, b1.versionId))) ?? ""));
  const rp = await reproposeKnowledgeVersion(facilityAdmin, b1.versionId);
  const vr = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: rp.versionId } });
  report("B: re-proposed as the next version number, waiting for approval, with the proposer as its uploader",
    rp.version === 3 && vr.approvalStatus === "SUBMITTED" && vr.reproposedFromVersionId === b1.versionId && vr.reproposalSeq === 1 && vr.uploadedByUserId === facilityAdmin.userId && vr.sha256 === v1After.sha256 && vr.storageRef === v1After.storageRef);
  report("B: the re-proposal is emitted and audited, with the ingestion event on the bulk lane",
    (await prisma.domainEventOutbox.count({ where: { eventType: "KnowledgeDocumentVersionReproposed", aggregateId: b1.documentId } })) === 1
      && (await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "KnowledgeDocumentVersionUploaded", payload: { path: ["versionId"], equals: rp.versionId } } })).bulk === true
      && (await prisma.auditEvent.count({ where: { type: "knowledge.version.reproposed", userId: facilityAdmin.userId } })) === 1);
  report("B: it is not in force before approval", !(await has(superintendent, old)));
  report("B: it can't be proposed twice at once", (await codeOf(reproposeKnowledgeVersion(facilityAdmin, b1.versionId))) === "REPROPOSAL_PENDING");
  report("B: ingested, every passage from the embedding cache", (await ingest(rp.versionId)) === "INDEXED" && await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: rp.versionId } }).then((v) => v.embeddedCount === 0 && v.cacheHitCount === v.chunkCount));
  const proposerAsApprover = { ...facilityAdmin, role: "MEDICAL_SUPERINTENDENT" as const };
  report("B: the proposer can't approve it, even holding the approve permission", (await codeOf(approveKnowledgeVersion(proposerAsApprover, rp.versionId))) === "SELF_APPROVAL");
  report("B: the database refuses it too", await prisma.knowledgeDocumentVersion.update({ where: { id: rp.versionId }, data: { approvalStatus: "APPROVED", approvedByUserId: facilityAdmin.userId, approvedAt: new Date() } }).then(() => false, () => true));
  const apR = await approveKnowledgeVersion(superintendent, rp.versionId);
  const docB2 = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: b1.documentId } });
  report("B: a second person approves; the re-proposed version is in force with the old text", apR.published === true && docB2.currentVersionId === rp.versionId && (await has(superintendent, old)) && !(await has(superintendent, next)));
  report("B: the old version's own row is untouched (still superseded by version 2)", (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: b1.versionId } })).supersededByVersionId === b2.versionId);
  const b1Bytes = `# Protocol\n\nGive fluids. ${old}.\n\n## Monitoring\n\nCheck every 4 hours.\n`;
  report("B: uploading the same bytes again as a new upload is still a duplicate", (await codeOf(md(facilityAdmin, "Protocol", b1Bytes, { documentId: b1.documentId }))) === "DUPLICATE");
  report("B: the database allows one upload of the same bytes per document", await prisma.knowledgeDocumentVersion.create({
    data: { documentId: b1.documentId, version: 99, storageRef: v1After.storageRef, sha256: v1After.sha256, contentType: "text/markdown", byteSize: 1, uploadedByUserId: facilityAdmin.userId },
  }).then(() => false, () => true));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
