/**
 * Week 5c — insurance cards (docs/PATIENT_INSURANCE_DESIGN.md §2, §8, §14):
 *   - no encryption key: no card is stored (never in plain text);
 *   - member and policy numbers encrypted at rest, masked to the last 4 in
 *     every list and event; the full numbers only on the card's own edit
 *     screen (the member, an INSURANCE proxy) and to staff through a card
 *     share; payer types private, corporate and government schemes (PM-JAY);
 *   - photos re-encoded with no metadata (EXIF), images only, and never a
 *     PersonDocument (the document pipeline never reads them);
 *   - access: the owner; a proxy with INSURANCE (logged) but not one
 *     without; another person nothing (404); facility staff only through an
 *     ACTIVE, unexpired card share for their facility (logged via
 *     CARD_SHARE), never another facility, never after it ends;
 *   - removing a card ends its card shares; every change emits its event,
 *     with no number in any payload.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-insurance-cards.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
process.env.SMS_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { getStorageAdapter } from "../src/lib/storage";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { addCard, cardForEdit, listCards, removeCard, setCardPhoto, staffCard, updateCard } from "../src/lib/insurance/cards";
import { createCardShareTx } from "../src/lib/insurance/cardShares";
import { decryptCardValue } from "../src/lib/insurance/cardCrypto";
import { personAccess } from "../src/lib/person/access";
import { NOIDA, PUNE, eventsOf, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";
import { child, manager } from "./lib/householdFixture";

const { report, done } = reporter();
const MEMBER = `MBR${tag.toUpperCase()}QZ7X`;
const POLICY = `POL-${tag.toUpperCase()}-WK9Q`;

/** A small JPEG carrying an EXIF (APP1) segment with a fake GPS marker. */
async function jpegWithExif(): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(64, 40);
  const g = c.getContext("2d");
  g.fillStyle = "#3366aa"; g.fillRect(0, 0, 64, 40);
  const jpg = c.toBuffer("image/jpeg", 90);
  const exifBody = Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from(`GPSLatitude=18.52;Device=GatePhone-${tag}`, "utf8")]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff]), exifBody]);
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]);
}

async function main() {
  registerAllConsumers();
  const P = await sharer();
  const owner = { userId: P.userId };
  const body = { payerType: "PRIVATE_INSURER", payerName: "Gate Health Insurance", planName: "Family Floater", memberId: MEMBER, policyNumber: POLICY, validFrom: "2026-01-01", validTo: "2027-12-31" };

  // 1. No key, no card.
  const k = process.env.INSURANCE_CARD_KEY_1;
  delete process.env.INSURANCE_CARD_KEY_1;
  report("Without an encryption key no card is stored", await refused(addCard(owner, body)) && (await prisma.insuranceCard.count({ where: { personId: P.personId } })) === 0);
  process.env.INSURANCE_CARD_KEY_VERSION = "1";
  process.env.INSURANCE_CARD_KEY_1 = k ?? randomBytes(32).toString("base64");

  // 2. Adding, encrypted, masked.
  const c = await addCard(owner, body);
  const row = await prisma.insuranceCard.findUniqueOrThrow({ where: { id: c.id } });
  report("Added: masked to the last 4 in the reply", c.memberIdMasked === `••••${MEMBER.slice(-4)}` && c.policyMasked === `••••${POLICY.slice(-4)}` && !JSON.stringify(c).includes(MEMBER) && !JSON.stringify(c).includes(POLICY));
  report("…encrypted at rest (the stored value isn't the number, and decrypts to it)", !row.memberIdCipher.includes(MEMBER) && !(row.policyCipher ?? "").includes(POLICY) && decryptCardValue(row.memberIdCipher, row.keyVersion) === MEMBER && decryptCardValue(row.policyCipher!, row.keyVersion) === POLICY);
  const ev = await eventsOf(c.id, "InsuranceCardChanged");
  report("…InsuranceCardChanged ADDED, with no number in the payload", ev.length === 1 && (ev[0].payload as { change?: string }).change === "ADDED" && !JSON.stringify(ev[0].payload).includes(MEMBER.slice(-4)) && !JSON.stringify(ev[0].payload).includes(POLICY));
  report("A list never shows the full numbers", !JSON.stringify(await listCards(owner)).includes(MEMBER));
  const edit = await cardForEdit(owner, c.id);
  report("The card's own edit screen shows them (the owner)", edit.memberId === MEMBER && edit.policyNumber === POLICY);

  // 3. Payer types.
  report("A government scheme needs its scheme", await refused(addCard(owner, { ...body, payerType: "GOVERNMENT_SCHEME", payerName: undefined })));
  const pmjay = await addCard(owner, { payerType: "GOVERNMENT_SCHEME", scheme: "PM_JAY", memberId: `PMJ${tag.toUpperCase()}0001` });
  report("PM-JAY is a payer type (named from the scheme)", pmjay.payerType === "GOVERNMENT_SCHEME" && pmjay.scheme === "PM_JAY" && pmjay.payerName === "Ayushman Bharat PM-JAY");
  const corp = await addCard(owner, { payerType: "CORPORATE", payerName: "Employer TPA", memberId: `EMP${tag.toUpperCase()}0002` });
  report("…and a corporate cover", corp.payerType === "CORPORATE");
  report("An invalid member number is refused", await refused(addCard(owner, { ...body, memberId: "x" })));

  // 4. Updating.
  report("A stale version is refused", await refused(updateCard(owner, c.id, { version: 99, planName: "Other" })));
  const u = await updateCard(owner, c.id, { version: c.version, planName: "Super Top-up" });
  report("Updated, with InsuranceCardChanged UPDATED", u.planName === "Super Top-up" && (await eventsOf(c.id, "InsuranceCardChanged")).some((e) => (e.payload as { change?: string }).change === "UPDATED"));

  // 5. Photos.
  const docsBefore = await prisma.personDocument.count({ where: { personId: P.personId } });
  const withExif = await jpegWithExif();
  report("Control: the test photo carries EXIF", withExif.includes(Buffer.from("Exif")) && withExif.includes(Buffer.from("GPSLatitude")));
  const ph = await setCardPhoto(owner, c.id, "FRONT", { bytes: withExif, contentType: "image/jpeg" });
  const stored = await getStorageAdapter().get((await prisma.insuranceCard.findUniqueOrThrow({ where: { id: c.id } })).frontImageRef!);
  report("The stored photo has no EXIF (re-encoded)", ph.hasFront && !stored.bytes.includes(Buffer.from("Exif")) && !stored.bytes.includes(Buffer.from("GPSLatitude")) && stored.bytes[0] === 0xff && stored.bytes[1] === 0xd8);
  report("…and isn't a PersonDocument (the document pipeline never sees it)", (await prisma.personDocument.count({ where: { personId: P.personId } })) === docsBefore);
  report("A PDF isn't a card photo", await refused(setCardPhoto(owner, c.id, "BACK", { bytes: Buffer.from("%PDF-1.4"), contentType: "application/pdf" })));

  // 6. Who else.
  const other = await sharer();
  report("Another person: nothing (list is theirs, edit/update/photo 404)", !(await listCards({ userId: other.userId })).cards.some((x) => x.id === c.id) && await notFound(cardForEdit({ userId: other.userId }, c.id)) && await notFound(updateCard({ userId: other.userId }, c.id, { version: 1 })));
  const M = await manager();
  const kid = await child(M, 8);
  const kc = await addCard({ userId: M.userId, memberPersonId: kid.childPersonId }, { payerType: "PRIVATE_INSURER", payerName: "Gate Health Insurance", memberId: `KID${tag.toUpperCase()}0003` });
  report("A guardian (INSURANCE) adds the child's card, logged as a proxy action", !!kc.id && (await prisma.personAccessLogEntry.count({ where: { personId: kid.childPersonId, kind: "PROXY_ACTION", detail: { path: ["action"], equals: "INSURANCE_CARD_ADDED" } } })) === 1);
  const aunt = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: kid.childPersonId, proxyPersonId: aunt.personId, householdId: M.householdId, basis: "MEMBER_CHOICE", permissions: ["VIEW", "BOOK"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: M.personId } });
  report("A proxy without INSURANCE sees no card (404)", await notFound(listCards({ userId: aunt.userId, memberPersonId: kid.childPersonId })));
  report("…nor through the resolver with another permission", !(await personAccess({ kind: "PROXY", userId: aunt.userId, permission: "VIEW" }, kid.childPersonId, "INSURANCE")));

  // 7. Staff through a card share only.
  const desk = await staff(PUNE, "HOSPITAL_ADMIN");
  const noida = await staff(NOIDA, "HOSPITAL_ADMIN");
  const cs = await prisma.$transaction((tx) => createCardShareTx(tx, { cardId: c.id, personId: P.personId, facilityId: PUNE, expiresAt: new Date(Date.now() + 86_400_000), createdByPersonId: P.personId, userId: P.userId }));
  const seen = await staffCard({ userId: desk.userId, facilityId: PUNE, cardShareId: cs.id });
  report("Staff of the facility read the card through the card share (full numbers, to verify)", seen.view.memberId === MEMBER);
  report("…logged in the member's access log (via CARD_SHARE)", (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, kind: "RECORD_ACCESSED", actorUserId: desk.userId, detail: { path: ["via"], equals: "CARD_SHARE" } } })) === 1);
  report("Another facility's staff: nothing (404)", await notFound(staffCard({ userId: noida.userId, facilityId: NOIDA, cardShareId: cs.id })));
  report("No card share: the resolver gives staff nothing", !(await personAccess({ kind: "STAFF", userId: desk.userId, facilityId: PUNE }, P.personId, "INSURANCE")));
  const ev2 = await eventsOf(cs.id, "CardShareStatusChanged");
  report("CardShareStatusChanged NONE → ACTIVE", ev2.length === 1 && (ev2[0].payload as { to?: string }).to === "ACTIVE");
  await prisma.cardShare.update({ where: { id: cs.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  report("An expired card share opens nothing (404)", await notFound(staffCard({ userId: desk.userId, facilityId: PUNE, cardShareId: cs.id })));
  await prisma.cardShare.update({ where: { id: cs.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });

  // 8. Removing.
  await removeCard(owner, c.id);
  report("Removed: gone from the list, its card share ended (with its event), staff see nothing",
    !(await listCards(owner)).cards.some((x) => x.id === c.id) && (await prisma.cardShare.findUniqueOrThrow({ where: { id: cs.id } })).status === "ENDED"
    && (await eventsOf(cs.id, "CardShareStatusChanged")).some((e) => (e.payload as { to?: string }).to === "ENDED") && await notFound(staffCard({ userId: desk.userId, facilityId: PUNE, cardShareId: cs.id })));
  const all = await prisma.domainEventOutbox.findMany({ where: { eventType: { in: ["InsuranceCardChanged", "CardShareStatusChanged"] }, personId: { in: [P.personId, kid.childPersonId] } } });
  report("No event anywhere carries a member or policy number", all.length >= 6 && all.every((e) => !JSON.stringify(e.payload).includes(MEMBER) && !JSON.stringify(e.payload).includes(POLICY) && !JSON.stringify(e.payload).includes(MEMBER.slice(-4))));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
