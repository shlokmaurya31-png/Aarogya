import type { PersonNotificationKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";
import { sendEmail } from "@/lib/email/send";
import { sendSms } from "@/lib/messaging/sms";
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

type Texts = Record<PersonNotificationKind, (d: Record<string, number>) => { title: string; body: string }>;
const TEXTS: Record<string, Texts> = {
  en: {
    ACCESS_SUMMARY: (d) => ({
      title: "Who opened your health record yesterday",
      body: `Your record was opened ${d.opens} time${d.opens === 1 ? "" : "s"} by ${d.people} ${d.people === 1 ? "person" : "people"} yesterday. Open Aarogya to see who, and to stop any access you didn't expect.`,
    }),
    BREAK_GLASS_ACCESS: () => ({
      title: "Your record was opened in an emergency",
      body: "A hospital opened your health record using emergency access. Every emergency access is reviewed. Open Aarogya to see who and when.",
    }),
    ACCESS_REQUESTED: () => ({
      title: "A request to see your health record",
      body: "A doctor or hospital has asked to see part of your health record. Open Aarogya to approve or decline it. Nothing is shared until you approve.",
    }),
    COMING_OF_AGE: (d) => ({
      title: "A child in your family turns 18 soon",
      body: `A profile you manage becomes its owner's own in ${d.days} day${d.days === 1 ? "" : "s"}. From then on you see it only if they choose. Open Aarogya to hand it over.`,
    }),
    CHECKIN_OPEN: () => ({
      title: "You can check in before you arrive",
      body: "Check-in is open for your visit. Confirm your details, add your insurance card and get your token in Aarogya, so you don't wait at the desk.",
    }),
    INSURANCE_UPDATE: () => ({
      title: "An update on your insurance",
      body: "Something changed with your insurance approval, bill or claim. Open Aarogya to see what it means for you.",
    }),
    DOCUMENTS_REQUESTED: () => ({
      title: "The hospital needs a document for your claim",
      body: "The hospital asked for a document to support your insurance claim. Open Aarogya to see what is needed and attach it.",
    }),
    BILL_READY: () => ({
      title: "Your bill is ready",
      body: "Your itemised bill is ready. Open Aarogya to see it and your share to pay.",
    }),
  },
  hi: {
    ACCESS_SUMMARY: (d) => ({
      title: "कल आपका स्वास्थ्य रिकॉर्ड किसने देखा",
      body: `कल आपका रिकॉर्ड ${d.people} व्यक्ति/व्यक्तियों ने ${d.opens} बार खोला। कौन था, यह देखने और कोई अनचाही पहुँच बंद करने के लिए Aarogya खोलें।`,
    }),
    BREAK_GLASS_ACCESS: () => ({
      title: "आपातकाल में आपका रिकॉर्ड खोला गया",
      body: "एक अस्पताल ने आपातकालीन पहुँच से आपका स्वास्थ्य रिकॉर्ड खोला। हर आपातकालीन पहुँच की समीक्षा होती है। किसने और कब, यह देखने के लिए Aarogya खोलें।",
    }),
    ACCESS_REQUESTED: () => ({
      title: "आपका स्वास्थ्य रिकॉर्ड देखने का अनुरोध",
      body: "किसी डॉक्टर या अस्पताल ने आपके स्वास्थ्य रिकॉर्ड का कुछ हिस्सा देखने का अनुरोध किया है। स्वीकार या अस्वीकार करने के लिए Aarogya खोलें। आपकी स्वीकृति के बिना कुछ भी साझा नहीं होता।",
    }),
    COMING_OF_AGE: (d) => ({
      title: "आपके परिवार में कोई जल्द 18 का होगा",
      body: `आपके द्वारा प्रबंधित एक प्रोफ़ाइल ${d.days} दिन में उसके मालिक की अपनी हो जाएगी। उसके बाद आप उसे तभी देखेंगे जब वे चुनें। सौंपने के लिए Aarogya खोलें।`,
    }),
    CHECKIN_OPEN: () => ({
      title: "आने से पहले चेक-इन करें",
      body: "आपकी विज़िट के लिए चेक-इन खुल गया है। Aarogya में अपनी जानकारी की पुष्टि करें, बीमा कार्ड जोड़ें और टोकन लें, ताकि डेस्क पर इंतज़ार न करना पड़े।",
    }),
    INSURANCE_UPDATE: () => ({
      title: "आपके बीमा के बारे में नई जानकारी",
      body: "आपकी बीमा स्वीकृति, बिल या क्लेम में कुछ बदला है। आपके लिए इसका क्या अर्थ है, यह देखने के लिए Aarogya खोलें।",
    }),
    DOCUMENTS_REQUESTED: () => ({
      title: "आपके क्लेम के लिए अस्पताल को एक दस्तावेज़ चाहिए",
      body: "अस्पताल ने आपके बीमा क्लेम के लिए एक दस्तावेज़ माँगा है। क्या चाहिए, यह देखने और उसे जोड़ने के लिए Aarogya खोलें।",
    }),
    BILL_READY: () => ({
      title: "आपका बिल तैयार है",
      body: "आपका विस्तृत बिल तैयार है। उसे और आपको चुकाने वाला हिस्सा देखने के लिए Aarogya खोलें।",
    }),
  },
};

/** The text in the person's language, or English where there is no translation yet (a pre-launch item). */
export function notificationText(kind: PersonNotificationKind, language: string, detail: Record<string, number> = {}) {
  const lang = TEXTS[language] ? language : "en";
  return { language: lang, ...TEXTS[lang][kind](detail) };
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

/** The person's own notifications, newest first. */
export async function listOwnNotifications(userId: string, limit = 30) {
  const personId = await requireOwnedPerson(userId);
  const rows = await prisma.personNotification.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, limit)) });
  return rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt.toISOString(), status: n.status }));
}
