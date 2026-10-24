import type { InsuranceCard, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { getStorageAdapter } from "@/lib/storage";
import { personAccess, ownedPersonId } from "@/lib/person/access";
import { currentCardKey, decryptCardValue, encryptCardValue, maskLast4 } from "./cardCrypto";
import { GOVERNMENT_SCHEMES, PAYER_TYPE_LABEL, SCHEME_LABEL } from "./vocab";

/**
 * Week 5c — insurance cards (docs/PATIENT_INSURANCE_DESIGN.md §2, §14).
 * A card is patient-provided and belongs to the member's Person: the member,
 * or a household proxy with INSURANCE, adds and edits it. Every read decides
 * in personAccess (purpose INSURANCE): OWNER, PROXY (INSURANCE) or a
 * facility's CARD_SHARE for that one card. Member and policy numbers are
 * encrypted at rest and shown masked to the last 4, except on the card's own
 * edit screen (the member or their proxy) and to the facility staff verifying
 * it through a card share (logged in the member's access log). Photos are
 * re-encoded (no metadata) and stored like uploads, but never as a
 * PersonDocument: the document pipeline never reads them.
 * Every change emits InsuranceCardChanged in its transaction.
 */
const PAYER_TYPES = ["PRIVATE_INSURER", "CORPORATE", "GOVERNMENT_SCHEME"] as const;
const SIGNED_URL_SECONDS = 300;

export interface CardActorRef { userId: string; memberPersonId?: string }

/** Whose card: the caller's own Person, or a member they hold INSURANCE for (logged as a proxy action). */
async function cardOwner(a: CardActorRef): Promise<{ personId: string; actorPersonId: string; via: "OWNER" | "PROXY" }> {
  if (a.memberPersonId) {
    const g = await personAccess({ kind: "PROXY", userId: a.userId, permission: "INSURANCE" }, a.memberPersonId, "INSURANCE");
    if (!g?.proxy) throw new NotFoundError();
    return { personId: a.memberPersonId, actorPersonId: g.proxy.proxyPersonId, via: "PROXY" };
  }
  const personId = await ownedPersonId(a.userId);
  if (!personId || !(await personAccess({ kind: "OWNER", userId: a.userId }, personId, "INSURANCE"))) throw new NotFoundError();
  return { personId, actorPersonId: personId, via: "OWNER" };
}

async function logProxyTx(tx: Prisma.TransactionClient, o: { personId: string; actorPersonId: string; via: string }, userId: string, action: string, detail: Record<string, unknown>) {
  if (o.via !== "PROXY") return;
  await tx.personAccessLogEntry.create({ data: { personId: o.personId, kind: "PROXY_ACTION", actorUserId: userId, detail: { via: "PROXY", proxyPersonId: o.actorPersonId, action, ...detail } as never } });
}

async function cardEventTx(tx: Prisma.TransactionClient, c: InsuranceCard, change: "ADDED" | "UPDATED" | "REMOVED", userId: string) {
  await emitDomainEvent(tx, {
    type: "InsuranceCardChanged", aggregateId: c.id, personId: c.personId, actorUserId: userId,
    payload: { insuranceId: c.id, personId: c.personId, change, status: c.status, payerType: c.payerType, hasPhotos: !!(c.frontImageRef || c.backImageRef) },
  });
}

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}
function number(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : "";
  if (!/^[A-Z0-9/\-]{4,40}$/.test(s)) throw new BadRequestError(`${what}: 4 to 40 letters or digits.`);
  return s;
}
function date(v: unknown, what: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(String(v))) throw new BadRequestError(`${what} must be a date (YYYY-MM-DD).`);
  return d;
}

async function parseCard(body: Record<string, unknown>, partial = false) {
  const out: Record<string, unknown> = {};
  if (!partial || body.payerType !== undefined) {
    if (!(PAYER_TYPES as readonly unknown[]).includes(body.payerType)) throw new BadRequestError(`payerType must be one of ${PAYER_TYPES.join(", ")}.`);
    out.payerType = body.payerType;
  }
  const payerType = (out.payerType ?? body.payerType) as (typeof PAYER_TYPES)[number] | undefined;
  if (!partial || body.scheme !== undefined || body.payerType !== undefined) {
    if (payerType === "GOVERNMENT_SCHEME") {
      if (!(GOVERNMENT_SCHEMES as readonly unknown[]).includes(body.scheme)) throw new BadRequestError(`scheme must be one of ${GOVERNMENT_SCHEMES.join(", ")}.`);
      out.scheme = body.scheme;
    } else out.scheme = null;
  }
  if (body.payerId !== undefined && body.payerId !== null) {
    const payer = await prisma.payer.findUnique({ where: { id: String(body.payerId) }, select: { id: true, name: true, active: true, type: true } });
    if (!payer?.active || payer.type === "CASH") throw new BadRequestError("Unknown insurer.");
    out.payerId = payer.id;
    out.payerName = payer.name;
  } else if (!partial || body.payerName !== undefined) {
    const name = text(body.payerName, 120) ?? (payerType === "GOVERNMENT_SCHEME" && typeof out.scheme === "string" ? SCHEME_LABEL[out.scheme as (typeof GOVERNMENT_SCHEMES)[number]] : null);
    if (!name) throw new BadRequestError("The insurer's or scheme's name is required.");
    out.payerName = name;
    if (!partial) out.payerId = null;
  }
  if (!partial || body.planName !== undefined) out.planName = text(body.planName, 120);
  if (!partial || body.memberId !== undefined) out.memberId = number(body.memberId, "The member or card number");
  if (body.policyNumber !== undefined) out.policyNumber = body.policyNumber === null || body.policyNumber === "" ? null : number(body.policyNumber, "The policy number");
  if (!partial || body.validFrom !== undefined) out.validFrom = date(body.validFrom, "validFrom");
  if (!partial || body.validTo !== undefined) out.validTo = date(body.validTo, "validTo");
  if (out.validFrom && out.validTo && (out.validTo as Date) < (out.validFrom as Date)) throw new BadRequestError("validTo is before validFrom.");
  return out;
}

function encryptedNumbers(memberId: string | undefined, policy: string | null | undefined) {
  const k = currentCardKey();
  if (!k) throw new ConflictError("Insurance cards can't be stored yet (no encryption key is configured).");
  const out: Record<string, unknown> = { keyVersion: k.version };
  if (memberId !== undefined) { out.memberIdCipher = encryptCardValue(memberId, k.key); out.memberIdLast4 = memberId.slice(-4); }
  if (policy !== undefined) { out.policyCipher = policy ? encryptCardValue(policy, k.key) : null; out.policyLast4 = policy ? policy.slice(-4) : null; }
  return out;
}

/** The card as anyone but its edit screen sees it: masked numbers, no photo refs. */
export function cardView(c: InsuranceCard) {
  return {
    id: c.id, payerType: c.payerType, payerTypeLabel: PAYER_TYPE_LABEL[c.payerType], scheme: c.scheme, payerName: c.payerName, planName: c.planName,
    memberIdMasked: maskLast4(c.memberIdLast4), policyMasked: maskLast4(c.policyLast4), validFrom: c.validFrom?.toISOString().slice(0, 10) ?? null, validTo: c.validTo?.toISOString().slice(0, 10) ?? null,
    hasFront: !!c.frontImageRef, hasBack: !!c.backImageRef, version: c.version,
  };
}

export async function addCard(a: CardActorRef, body: Record<string, unknown>) {
  const o = await cardOwner(a);
  const f = await parseCard(body);
  const n = await prisma.insuranceCard.count({ where: { personId: o.personId, status: "ACTIVE" } });
  if (n >= 10) throw new ConflictError("At most 10 cards per person.");
  const enc = encryptedNumbers(f.memberId as string, (f.policyNumber as string | null | undefined) ?? null);
  const card = await prisma.$transaction(async (tx) => {
    const c = await tx.insuranceCard.create({
      data: {
        personId: o.personId, payerType: f.payerType as never, scheme: (f.scheme as string | null) ?? null, payerId: (f.payerId as string | null) ?? null, payerName: f.payerName as string, planName: (f.planName as string | null) ?? null,
        validFrom: (f.validFrom as Date | null) ?? null, validTo: (f.validTo as Date | null) ?? null, addedByPersonId: o.actorPersonId, ...(enc as { keyVersion: number; memberIdCipher: string; memberIdLast4: string }),
      },
    });
    await cardEventTx(tx, c, "ADDED", a.userId);
    await logProxyTx(tx, o, a.userId, "INSURANCE_CARD_ADDED", { cardId: c.id });
    return c;
  });
  await recordAuditEvent("person.insuranceCard.changed", a.userId, { personId: o.personId, cardId: card.id, change: "ADDED", via: o.via });
  return cardView(card);
}

async function ownCard(a: CardActorRef, cardId: string) {
  const o = await cardOwner(a);
  const c = await prisma.insuranceCard.findUnique({ where: { id: cardId } });
  if (!c || c.personId !== o.personId || c.status !== "ACTIVE") throw new NotFoundError();
  return { o, c };
}

export async function updateCard(a: CardActorRef, cardId: string, body: Record<string, unknown>) {
  const { o, c } = await ownCard(a, cardId);
  if (typeof body.version !== "number") throw new BadRequestError("version is required.");
  const f = await parseCard(body, true);
  const enc = f.memberId !== undefined || f.policyNumber !== undefined ? encryptedNumbers(f.memberId as string | undefined, f.policyNumber as string | null | undefined) : {};
  const { memberId: _m, policyNumber: _p, ...plain } = f;
  void _m; void _p;
  const card = await prisma.$transaction(async (tx) => {
    const r = await tx.insuranceCard.updateMany({ where: { id: c.id, version: body.version as number, status: "ACTIVE" }, data: { ...(plain as object), ...enc, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This card changed in the meantime. Refresh and try again.");
    const after = await tx.insuranceCard.findUniqueOrThrow({ where: { id: c.id } });
    await cardEventTx(tx, after, "UPDATED", a.userId);
    await logProxyTx(tx, o, a.userId, "INSURANCE_CARD_UPDATED", { cardId: c.id });
    return after;
  });
  await recordAuditEvent("person.insuranceCard.changed", a.userId, { personId: o.personId, cardId: c.id, change: "UPDATED", via: o.via });
  return cardView(card);
}

/** Removing a card ends its card shares too (each with its event). */
export async function removeCard(a: CardActorRef, cardId: string) {
  const { o, c } = await ownCard(a, cardId);
  await prisma.$transaction(async (tx) => {
    const r = await tx.insuranceCard.updateMany({ where: { id: c.id, status: "ACTIVE" }, data: { status: "REMOVED", removedAt: new Date(), version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This card was already removed.");
    await cardEventTx(tx, { ...c, status: "REMOVED" }, "REMOVED", a.userId);
    const { endCardSharesTx } = await import("./cardShares");
    await endCardSharesTx(tx, { cardId: c.id }, "CARD_REMOVED", a.userId);
    await logProxyTx(tx, o, a.userId, "INSURANCE_CARD_REMOVED", { cardId: c.id });
  });
  await recordAuditEvent("person.insuranceCard.changed", a.userId, { personId: o.personId, cardId: c.id, change: "REMOVED", via: o.via });
  return { status: "REMOVED" as const };
}

export async function listCards(a: CardActorRef) {
  const o = await cardOwner(a);
  const rows = await prisma.insuranceCard.findMany({ where: { personId: o.personId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  return { cards: rows.map(cardView) };
}

/** The card's own edit screen: the full numbers, for the member or their INSURANCE proxy only. */
export async function cardForEdit(a: CardActorRef, cardId: string) {
  const { o, c } = await ownCard(a, cardId);
  if (o.via === "PROXY") await prisma.$transaction((tx) => logProxyTx(tx, o, a.userId, "INSURANCE_CARD_VIEWED", { cardId: c.id }));
  return { ...cardView(c), memberId: decryptCardValue(c.memberIdCipher, c.keyVersion), policyNumber: c.policyCipher ? decryptCardValue(c.policyCipher, c.keyVersion) : null };
}

/**
 * A card photo, re-encoded as a JPEG so no metadata (EXIF: location, device,
 * time) is kept. Images only. Stored in the uploads bucket under the
 * member's scope, never as a PersonDocument.
 */
export async function setCardPhoto(a: CardActorRef, cardId: string, side: unknown, input: { bytes: Buffer; contentType: string }) {
  if (side !== "FRONT" && side !== "BACK") throw new BadRequestError("side must be FRONT or BACK.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.contentType)) throw new BadRequestError("A card photo must be a JPEG, PNG or WebP image.");
  const { o, c } = await ownCard(a, cardId);
  const clean = await reencode(input.bytes);
  const storage = getStorageAdapter();
  const stored = await storage.put({ bucket: "patient-uploads", bytes: clean, contentType: "image/jpeg", originalName: `card-${side.toLowerCase()}.jpg`, scope: o.personId });
  const field = side === "FRONT" ? "frontImageRef" : "backImageRef";
  try {
    const card = await prisma.$transaction(async (tx) => {
      const r = await tx.insuranceCard.updateMany({ where: { id: c.id, version: c.version, status: "ACTIVE" }, data: { [field]: stored.storageRef, version: { increment: 1 } } });
      if (r.count !== 1) throw new ConflictError("This card changed in the meantime. Refresh and try again.");
      const after = await tx.insuranceCard.findUniqueOrThrow({ where: { id: c.id } });
      await cardEventTx(tx, after, "UPDATED", a.userId);
      await logProxyTx(tx, o, a.userId, "INSURANCE_CARD_PHOTO", { cardId: c.id, side });
      return after;
    });
    return cardView(card);
  } catch (err) {
    await storage.delete(stored.storageRef).catch(() => undefined);
    throw err;
  }
}

/** Decodes and re-encodes an image: the pixels only, no metadata segments. */
export async function reencode(bytes: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  let img;
  try { img = await loadImage(bytes); } catch { throw new BadRequestError("That image couldn't be read."); }
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toBuffer("image/jpeg", 85);
}

/** A 5-minute URL for a card photo: the member, their INSURANCE proxy, or staff through the card's card share. */
export async function cardPhotoUrl(actor: CardActorRef | { kind: "CARD_SHARE"; userId: string; facilityId: string; cardShareId: string }, cardId: string, side: "FRONT" | "BACK") {
  let card: InsuranceCard | null;
  if ("kind" in actor) {
    card = (await staffCard(actor)).card;
    if (card.id !== cardId) throw new NotFoundError();
  } else {
    card = (await ownCard(actor, cardId)).c;
  }
  const ref = side === "FRONT" ? card.frontImageRef : card.backImageRef;
  if (!ref) throw new NotFoundError();
  const { url, expiresAt } = await getStorageAdapter().signedDownloadUrl(ref, SIGNED_URL_SECONDS);
  return { url, expiresAt: expiresAt.toISOString() };
}

/**
 * Staff, through a card share for their facility: the card with its full
 * numbers (they verify it with the insurer or the scheme), logged in the
 * member's access log (via CARD_SHARE).
 */
export async function staffCard(actor: { userId: string; facilityId: string; cardShareId: string }) {
  const cs = await prisma.cardShare.findUnique({ where: { id: actor.cardShareId }, select: { personId: true } });
  if (!cs) throw new NotFoundError();
  const g = await personAccess({ kind: "CARD_SHARE", ...actor }, cs.personId, "INSURANCE");
  if (!g?.cardId) throw new NotFoundError();
  const card = await prisma.insuranceCard.findUnique({ where: { id: g.cardId } });
  if (!card || card.status !== "ACTIVE") throw new NotFoundError();
  await prisma.personAccessLogEntry.create({ data: { personId: card.personId, kind: "RECORD_ACCESSED", accessingFacilityId: actor.facilityId, actorUserId: actor.userId, detail: { via: "CARD_SHARE", surface: "INSURANCE_CARD", cardShareId: actor.cardShareId, cardId: card.id } } });
  await recordAuditEvent("person.insuranceCard.accessedViaShare", actor.userId, { cardId: card.id, personId: card.personId, cardShareId: actor.cardShareId }, { facilityId: actor.facilityId });
  return { card, view: { ...cardView(card), memberId: decryptCardValue(card.memberIdCipher, card.keyVersion), policyNumber: card.policyCipher ? decryptCardValue(card.policyCipher, card.keyVersion) : null } };
}
