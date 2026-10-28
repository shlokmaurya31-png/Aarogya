import type { PersonNotificationKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";
import { sendEmail } from "@/lib/email/send";
import { sendSms } from "@/lib/messaging/sms";
import { messageText, textDirection } from "@/lib/notifications/texts";
import { requireOwnedPerson } from "./access";

/**
 * 4c answers (docs/CONSENT_SHARING_DESIGN.md §15) — what the person is told
 * about access to their record, through the notification pipeline:
 *
 *   ACCESS_SUMMARY      once a day (the India day just ended), if anyone
 *                       opened their record that day: how many times, by how
 *                       many people. The runner's sweep writes it.
 *   BREAK_GLASS_ACCESS  at once, when emergency access to one of their linked
 *                       records starts (the person-notifier, on
 *                       BreakGlassStatusChanged).
 *   ACCESS_REQUESTED    at once, when a doctor or hospital asks (the
 *                       person-notifier, on AccessRequested).
 *   COMING_OF_AGE       (Week 5b) to a household's managers, 30 days before a
 *                       child they manage turns 18 (src/lib/household/comingOfAge.ts).
 *
 * Writing one is a state change: PersonNotificationQueued in the same
 * transaction. The person-notifier delivers it (the account's email, else a
 * verified phone) and records the outcome with PersonNotificationStatusChanged.
 * The text carries no names, facilities or clinical detail; the app shows who.
 * One per fact (dedupeKey), so a redelivered event writes nothing new.
 */
const IST_OFFSET_MS = 330 * 60_000;

/**
 * The text in the person's language (Flagship 1b: all eleven app languages,
 * src/lib/notifications/texts.ts), or English when theirs isn't one of them.
 */
export function notificationText(kind: PersonNotificationKind, language: string, detail: Record<string, number> = {}) {
  const title = messageText(`notify.${kind}.title`, language, detail);
  return { language: title.language, title: title.text, body: messageText(`notify.${kind}.body`, language, detail).text };
}

/** A person's language for what Aarogya sends them (English when unknown). */
export async function personLanguage(personId: string | null | undefined): Promise<string> {
  if (!personId) return "en";
  return (await prisma.person.findUnique({ where: { id: personId }, select: { preferredLanguage: true } }))?.preferredLanguage ?? "en";
}

/** Writes a notification (once per dedupeKey) with PersonNotificationQueued. Null if it already exists. */
export async function queuePersonNotificationTx(tx: Prisma.TransactionClient, input: { personId: string; kind: PersonNotificationKind; dedupeKey: string; detail?: Record<string, number> }): Promise<string | null> {
  if (await tx.personNotification.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } })) return null;
  const person = await tx.person.findUnique({ where: { id: input.personId }, select: { status: true, preferredLanguage: true } });
  if (person?.status !== "ACTIVE") return null;
  const text = notificationText(input.kind, person.preferredLanguage, input.detail);
  const n = await tx.personNotification.create({
    data: { personId: input.personId, kind: input.kind, dedupeKey: input.dedupeKey, language: text.language, title: text.title, body: text.body, detail: input.detail ?? undefined },
  });
  await emitDomainEvent(tx, { type: "PersonNotificationQueued", aggregateId: n.id, personId: input.personId, payload: { notificationId: n.id, personId: input.personId, kind: input.kind } });
  return n.id;
}

/** Sends a PENDING notification: the account's email, else a verified phone; records the outcome with its event. */
export async function deliverPersonNotification(notificationId: string): Promise<"SENT" | "NO_CHANNEL" | "FAILED" | null> {
  const n = await prisma.personNotification.findUnique({ where: { id: notificationId } });
  if (!n || n.status !== "PENDING") return null;
  const owner = await prisma.personAccount.findFirst({ where: { personId: n.personId, role: "OWNER", endedAt: null }, select: { user: { select: { email: true } } } });
  const phone = await prisma.personContact.findFirst({ where: { personId: n.personId, kind: "PHONE", status: "ACTIVE", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" }, select: { value: true } });
  let to: "SENT" | "NO_CHANNEL" | "FAILED" = "NO_CHANNEL";
  let channel: "EMAIL" | "SMS" | undefined;
  if (owner?.user.email) {
    channel = "EMAIL";
    to = (await sendEmail({ to: owner.user.email, subject: n.title, text: n.body }).catch(() => ({ delivered: false }))).delivered ? "SENT" : "FAILED";
  } else if (phone) {
    channel = "SMS";
    to = (await sendSms(phone.value, `${n.title}. ${n.body}`).catch(() => ({ delivered: false }))).delivered ? "SENT" : "FAILED";
  }
  await prisma.$transaction(async (tx) => {
    const r = await tx.personNotification.updateMany({ where: { id: n.id, status: "PENDING" }, data: { status: to, channel: channel ?? null, sentAt: to === "SENT" ? new Date() : null, version: { increment: 1 } } });
    if (r.count !== 1) return;
    await emitDomainEvent(tx, { type: "PersonNotificationStatusChanged", aggregateId: n.id, personId: n.personId, payload: { notificationId: n.id, personId: n.personId, from: "PENDING", to, ...(channel ? { channel } : {}) } });
  });
  return to;
}

/** The India day (YYYY-MM-DD) a moment falls in, and that day's bounds. */
export function istDay(at: Date): { day: string; start: Date; end: Date } {
  const local = new Date(at.getTime() + IST_OFFSET_MS);
  const day = local.toISOString().slice(0, 10);
  const start = new Date(new Date(`${day}T00:00:00Z`).getTime() - IST_OFFSET_MS);
  return { day, start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Runner sweep: for the India day that just ended, one ACCESS_SUMMARY per
 * person whose record was opened that day (RECORD_ACCESSED in their log).
 * Idempotent: the dedupe key names the person and the day.
 */
export async function sweepAccessSummaries(opts: { now?: Date; batchSize?: number } = {}): Promise<{ queued: number }> {
  const today = istDay(opts.now ?? new Date());
  const { day, start, end } = istDay(new Date(today.start.getTime() - 1));
  const groups = await prisma.personAccessLogEntry.groupBy({
    by: ["personId"], where: { kind: "RECORD_ACCESSED", createdAt: { gte: start, lt: end } }, _count: { _all: true }, orderBy: { personId: "asc" }, take: opts.batchSize ?? 500,
  });
  let queued = 0;
  for (const g of groups) {
    const dedupeKey = `ACCESS_SUMMARY:${g.personId}:${day}`;
    if (await prisma.personNotification.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;
    const people = (await prisma.personAccessLogEntry.findMany({ where: { personId: g.personId, kind: "RECORD_ACCESSED", createdAt: { gte: start, lt: end } }, select: { actorUserId: true }, distinct: ["actorUserId"] })).length;
    const id = await prisma.$transaction((tx) => queuePersonNotificationTx(tx, { personId: g.personId, kind: "ACCESS_SUMMARY", dedupeKey, detail: { opens: g._count._all, people } })).catch((err) => {
      // A concurrent sweep wrote it first (the unique key): nothing to do.
      if ((err as { code?: string }).code === "P2002") return null;
      throw err;
    });
    if (id) queued += 1;
  }
  return { queued };
}

/** The person's own notifications, newest first, with each one's language and text direction (Urdu is right-to-left). */
export async function listOwnNotifications(userId: string, limit = 30) {
  const personId = await requireOwnedPerson(userId);
  const rows = await prisma.personNotification.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, limit)) });
  return rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, language: n.language, dir: textDirection(n.language), createdAt: n.createdAt.toISOString(), status: n.status }));
}
