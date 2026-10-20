/**
 * 4c answers (docs/CONSENT_SHARING_DESIGN.md §15) — what the person is told
 * about access to their record, through the notification pipeline:
 *   - a waiting access request: ACCESS_REQUESTED at once (the person-notifier
 *     on AccessRequested), delivered by email, nothing clinical in it;
 *   - break-glass on a linked record: BREAK_GLASS_ACCESS at once, before any
 *     daily summary; its later transitions and a redelivery write nothing;
 *   - the daily summary: for the India day just ended, one ACCESS_SUMMARY per
 *     person whose record was opened, with the counts; none for a person
 *     nobody opened; today's opens wait for tomorrow; running it again writes
 *     nothing;
 *   - in the person's language (Hindi), English where there's no translation;
 *     by SMS to a verified phone when there's no account to email; NO_CHANNEL
 *     otherwise;
 *   - every write and delivery emits its event; the person lists only their own.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-person-notifications.ts
 */
import "./lib/gateBootstrap";
import { readFileSync, existsSync } from "node:fs";
process.env.EMAIL_PROVIDER = "outbox";
process.env.SMS_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { requestAccess } from "../src/lib/sharing/requests";
import { activateBreakGlass, completeBreakGlass } from "../src/lib/auth/authorize/breakGlass";
import { istDay, listOwnNotifications, sweepAccessSummaries } from "../src/lib/person/notifications";
import { EMAIL_OUTBOX_FILE } from "../src/lib/email/send";
import { SMS_OUTBOX_FILE } from "../src/lib/messaging/sms";
import { replayEvent } from "../src/lib/events/replay";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import { NOIDA, PUNE, drain, eventsOf, reporter, sharer, staff } from "./lib/shareFixture";

const { report, done } = reporter();
const outbox = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject?: string; text: string }) : []);

async function main() {
  registerAllConsumers();
  const P = await sharer({ noida: true });
  const Q = await sharer();
  const quiet = await sharer();
  const noidaDoc = await staff(NOIDA, "DOCTOR");
  const puneDoc = await staff(PUNE, "DOCTOR");
  const email = (await prisma.user.findUniqueOrThrow({ where: { id: P.userId }, select: { email: true } })).email!;
  const facilityNames = (await prisma.facility.findMany({ where: { id: { in: [PUNE, NOIDA] } }, select: { name: true } })).map((f) => f.name);
  await drain();

  // 1. A waiting request.
  const r = await requestAccess(noidaDoc.actor, { patientId: P.noida!, categories: ["LABS"], reason: "Anaemia follow-up" });
  await drain();
  const n1 = await prisma.personNotification.findUnique({ where: { dedupeKey: `ACCESS_REQUESTED:${r.id}` } });
  report("A request: ACCESS_REQUESTED written at once, with PersonNotificationQueued", !!n1 && n1.personId === P.personId && (await eventsOf(n1.id, "PersonNotificationQueued")).length === 1);
  report("…delivered by email (SENT, channel EMAIL), with PersonNotificationStatusChanged", n1 ? (await prisma.personNotification.findUniqueOrThrow({ where: { id: n1.id } })).status === "SENT" && (await eventsOf(n1.id, "PersonNotificationStatusChanged")).some((e) => (e.payload as { to?: string; channel?: string }).to === "SENT" && (e.payload as { channel?: string }).channel === "EMAIL") : false);
  const mail = outbox(EMAIL_OUTBOX_FILE).filter((m) => m.to === email);
  report("…and the message names no doctor, facility or reason", mail.length >= 1 && mail.every((m) => !facilityNames.some((f) => m.text.includes(f) || (m.subject ?? "").includes(f)) && !m.text.includes("Anaemia")));
  report("…sent once: no inline email beside the pipeline's", mail.filter((m) => m.subject === "A request to see your health record").length === 1);

  // 2. Break-glass: at once.
  const bg = await activateBreakGlass({ facilityId: PUNE, patientId: P.pune, actorUserId: puneDoc.userId, actorStaffId: puneDoc.staffId, reason: "Unconscious on arrival, needs history now", emergencyContext: "UNCONSCIOUS_PATIENT" });
  await drain();
  const n2 = await prisma.personNotification.findUnique({ where: { dedupeKey: `BREAK_GLASS:${bg.id}` } });
  report("Break-glass on a linked record: BREAK_GLASS_ACCESS at once (no daily wait), delivered", !!n2 && n2.kind === "BREAK_GLASS_ACCESS" && (await prisma.personNotification.findUniqueOrThrow({ where: { id: n2.id } })).status === "SENT");
  report("…naming no facility and no reason", !!n2 && !facilityNames.some((f) => n2.body.includes(f) || n2.title.includes(f)) && !n2.body.includes("Unconscious"));
  await completeBreakGlass({ facilityId: PUNE, breakGlassId: bg.id, actorUserId: puneDoc.userId }).catch(() => undefined);
  await drain();
  report("Its completion writes nothing more", (await prisma.personNotification.count({ where: { personId: P.personId, kind: "BREAK_GLASS_ACCESS" } })) === 1);
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");
  const activated = (await prisma.domainEventOutbox.findMany({ where: { aggregateId: bg.id, eventType: "BreakGlassStatusChanged" }, orderBy: { createdAt: "asc" } }))[0];
  await replayEvent(platform, activated.eventId, { reason: "person-notifications gate" });
  await drain();
  report("A redelivered activation writes nothing new (one per break-glass)", (await prisma.personNotification.count({ where: { personId: P.personId, kind: "BREAK_GLASS_ACCESS" } })) === 1);

  // 3. The daily summary.
  const now = new Date();
  const yesterday = istDay(new Date(istDay(now).start.getTime() - 1));
  const at = (h: number) => new Date(yesterday.start.getTime() + h * 3_600_000);
  for (const [who, h] of [[noidaDoc.userId, 2], [noidaDoc.userId, 5], [puneDoc.userId, 9]] as const) {
    await prisma.personAccessLogEntry.create({ data: { personId: Q.personId, kind: "RECORD_ACCESSED", actorUserId: who, accessingFacilityId: NOIDA, detail: { via: "SHARE_CODE", surface: "CONSULT_VIEW" }, createdAt: at(h) } });
  }
  await prisma.personAccessLogEntry.create({ data: { personId: Q.personId, kind: "RECORD_ACCESSED", actorUserId: puneDoc.userId, accessingFacilityId: PUNE, detail: { via: "TREATING", surface: "AI_ASK" }, createdAt: new Date(istDay(now).start.getTime() + 60_000) } });
  await prisma.person.update({ where: { id: Q.personId }, data: { preferredLanguage: "hi" } });
  const s1 = await sweepAccessSummaries({ now });
  await drain();
  const sum = await prisma.personNotification.findUnique({ where: { dedupeKey: `ACCESS_SUMMARY:${Q.personId}:${yesterday.day}` } });
  report("The daily summary: one for the person whose record was opened yesterday (India day), with the counts (3 opens, 2 people)",
    s1.queued >= 1 && !!sum && (sum.detail as { opens?: number; people?: number }).opens === 3 && (sum.detail as { people?: number }).people === 2);
  report("…in the person's language (Hindi), delivered", !!sum && sum.language === "hi" && /बार/.test(sum.body) && (await prisma.personNotification.findUniqueOrThrow({ where: { id: sum.id } })).status === "SENT");
  report("…today's open waits for tomorrow's summary", (await prisma.personNotification.count({ where: { personId: Q.personId, kind: "ACCESS_SUMMARY" } })) === 1);
  report("…nobody opened the quiet person's record: no summary", (await prisma.personNotification.count({ where: { personId: quiet.personId } })) === 0);
  const s2 = await sweepAccessSummaries({ now });
  report("Running the sweep again writes nothing", s2.queued === 0 && (await prisma.personNotification.count({ where: { personId: Q.personId, kind: "ACCESS_SUMMARY" } })) === 1);
  const tomorrow = new Date(istDay(now).end.getTime() + 60_000);
  await sweepAccessSummaries({ now: tomorrow });
  const today = await prisma.personNotification.findUnique({ where: { dedupeKey: `ACCESS_SUMMARY:${Q.personId}:${istDay(now).day}` } });
  report("Tomorrow, today's open is summarized (1 open, 1 person)", !!today && (today.detail as { opens?: number }).opens === 1 && (today.detail as { people?: number }).people === 1);

  // 4. Language fallback and channels.
  await prisma.person.update({ where: { id: quiet.personId }, data: { preferredLanguage: "ta" } });
  // No account to email (as for a member without their own login): the account's link is ended.
  await prisma.personAccount.updateMany({ where: { personId: quiet.personId }, data: { endedAt: new Date() } });
  const noEmail = (await prisma.personAccount.count({ where: { personId: quiet.personId, endedAt: null } })) === 0;
  await prisma.personAccessLogEntry.create({ data: { personId: quiet.personId, kind: "RECORD_ACCESSED", actorUserId: noidaDoc.userId, accessingFacilityId: NOIDA, detail: { via: "SHARE_CODE", surface: "CONSULT_VIEW" }, createdAt: at(3) } });
  await sweepAccessSummaries({ now });
  await drain();
  const qn = await prisma.personNotification.findFirst({ where: { personId: quiet.personId, kind: "ACCESS_SUMMARY" } });
  report("No translation yet (Tamil): written in English, and says so in its language field", !!qn && qn.language === "en" && /opened/.test(qn.body));
  if (noEmail) {
    report("No account to email and no verified phone: NO_CHANNEL, with its event", !!qn && (await prisma.personNotification.findUniqueOrThrow({ where: { id: qn.id } })).status === "NO_CHANNEL" && (await eventsOf(qn.id, "PersonNotificationStatusChanged")).some((e) => (e.payload as { to?: string }).to === "NO_CHANNEL"));
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    await prisma.personContact.create({ data: { personId: quiet.personId, kind: "PHONE", value: phone, verifiedAt: new Date() } });
    await prisma.personAccessLogEntry.create({ data: { personId: quiet.personId, kind: "RECORD_ACCESSED", actorUserId: noidaDoc.userId, accessingFacilityId: NOIDA, detail: { via: "SHARE_CODE", surface: "CONSULT_VIEW" }, createdAt: new Date(istDay(now).start.getTime() + 120_000) } });
    await sweepAccessSummaries({ now: tomorrow });
    await drain();
    const viaSms = await prisma.personNotification.findUnique({ where: { dedupeKey: `ACCESS_SUMMARY:${quiet.personId}:${istDay(now).day}` } });
    report("With a verified phone and no account to email: sent by SMS", !!viaSms && viaSms.status === "SENT" && viaSms.channel === "SMS" && outbox(SMS_OUTBOX_FILE).some((m) => m.to === phone));
  } else {
    report("(the account couldn't be detached: the channel fallback is untested)", false);
  }

  // 5. The person's own list.
  const own = await listOwnNotifications(P.userId);
  report("The person lists their own notifications, and only theirs", own.length === 2 && own.every((n) => n.kind === "ACCESS_REQUESTED" || n.kind === "BREAK_GLASS_ACCESS"));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
