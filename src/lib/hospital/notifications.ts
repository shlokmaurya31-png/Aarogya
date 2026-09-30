/**
 * Phase E1 — Hospital Notification Center service.
 *
 * The delivery layer the roadmap deliberately stopped before. Upstream
 * producers (D6 domain events, D7 workflow escalations, critical-result
 * handlers, SLA breaches, approval requests) call `createNotification` /
 * `createNotifications`; recipients read their own stream through the
 * ownership-scoped read/mutate helpers here.
 *
 * ALL reads and mutations are scoped by `recipientStaffId` — a staff member
 * can never see or touch another staff member's notifications, and every
 * row also carries `facilityId` for tenant-level filtering/auditing. Nothing
 * in this file mutates canonical clinical data; it only produces and marks
 * notification rows. Purely additive.
 */
import { prisma } from "@/lib/db";
import type { Prisma, Notification } from "@prisma/client";

export const NOTIFICATION_CATEGORIES = ["CLINICAL", "OPERATIONAL", "ADMINISTRATIVE", "SYSTEM"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_PRIORITIES = ["ROUTINE", "URGENT", "CRITICAL"] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** Coerce an arbitrary category to a known value, defaulting to OPERATIONAL. */
export function coerceCategory(value: unknown): NotificationCategory {
  return NOTIFICATION_CATEGORIES.includes(value as NotificationCategory)
    ? (value as NotificationCategory)
    : "OPERATIONAL";
}

/** Coerce an arbitrary priority to a known value, defaulting to ROUTINE. */
export function coercePriority(value: unknown): NotificationPriority {
  return NOTIFICATION_PRIORITIES.includes(value as NotificationPriority)
    ? (value as NotificationPriority)
    : "ROUTINE";
}

/** Clamp a requested list size into the supported 1..100 window (default 30). */
export function clampLimit(value: unknown, fallback = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

export interface CreateNotificationInput {
  facilityId: string;
  recipientStaffId: string;
  type: string;
  title: string;
  body?: string | null;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  linkHref?: string | null;
  patientId?: string | null;
  encounterId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  createdByStaffId?: string | null;
}

function normalise(input: CreateNotificationInput): Prisma.NotificationCreateInput {
  return {
    facility: { connect: { id: input.facilityId } },
    recipient: { connect: { id: input.recipientStaffId } },
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    category: coerceCategory(input.category),
    priority: coercePriority(input.priority),
    linkHref: input.linkHref ?? null,
    patientId: input.patientId ?? null,
    encounterId: input.encounterId ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    createdByStaffId: input.createdByStaffId ?? null,
  };
}

/** Raise a single notification. Producers should call this from their own logic. */
export function createNotification(input: CreateNotificationInput): Promise<Notification> {
  return prisma.notification.create({ data: normalise(input) });
}

/**
 * Raise many notifications (e.g. fan-out of one critical result to every
 * on-call doctor). Uses createMany for efficiency; relation connects are
 * flattened to scalar FKs since createMany does not accept nested writes.
 */
export function createNotifications(inputs: CreateNotificationInput[]): Promise<{ count: number }> {
  if (inputs.length === 0) return Promise.resolve({ count: 0 });
  const data = inputs.map((input) => {
    return {
      facilityId: input.facilityId,
      recipientStaffId: input.recipientStaffId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      category: coerceCategory(input.category),
      priority: coercePriority(input.priority),
      linkHref: input.linkHref ?? null,
      patientId: input.patientId ?? null,
      encounterId: input.encounterId ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdByStaffId: input.createdByStaffId ?? null,
    };
  });
  return prisma.notification.createMany({ data });
}

export interface ListNotificationsOptions {
  /** "unread" returns only rows where readAt IS NULL; "all" returns everything. */
  filter?: "unread" | "all";
  limit?: number;
}

/** List the caller's own notifications, newest first. Always recipient-scoped. */
export function listNotifications(recipientStaffId: string, opts: ListNotificationsOptions = {}): Promise<Notification[]> {
  const limit = clampLimit(opts.limit);
  return prisma.notification.findMany({
    where: {
      recipientStaffId,
      ...(opts.filter === "unread" ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Count the caller's own unread notifications. */
export function unreadCount(recipientStaffId: string): Promise<number> {
  return prisma.notification.count({ where: { recipientStaffId, readAt: null } });
}

/**
 * Mark ONE notification read. Scoped by recipientStaffId in the same
 * updateMany, so a caller can never mark another staff member's row read
 * (a mismatched id simply updates 0 rows). Idempotent.
 */
export async function markRead(recipientStaffId: string, notificationId: string): Promise<{ updated: number }> {
  const res = await prisma.notification.updateMany({
    where: { id: notificationId, recipientStaffId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: res.count };
}

/** Mark ALL of the caller's unread notifications read. Idempotent. */
export async function markAllRead(recipientStaffId: string): Promise<{ updated: number }> {
  const res = await prisma.notification.updateMany({
    where: { recipientStaffId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: res.count };
}
