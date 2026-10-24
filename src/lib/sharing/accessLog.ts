import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Week 4c — a read of the person's record, in their access log (§7.1): who,
 * from which facility, through which way in, on which surface, which
 * categories. Part of the read (bookkeeping), not a state change.
 */
export type AccessVia = "SHARE_CODE" | "ACCESS_REQUEST" | "BOOKING" | "CHECKIN" | "CLAIM" | "TREATING" | "ORG_CONSENT" | "BREAK_GLASS";
export type AccessSurface = "CONSULT_VIEW" | "SHARED_RECORD_VIEW" | "AI_ASK" | "DOCUMENT_DOWNLOAD";

export async function logRecordAccess(input: {
  personId: string; actorUserId: string; facilityId: string | null; via: AccessVia; surface: AccessSurface; shareId?: string | null; categories?: string[];
  /** The upload opened (DOCUMENT_DOWNLOAD). */
  documentId?: string;
  /** Log at most once per share and surface (the consult view's refreshes). */
  oncePerShare?: boolean;
}, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const detail = { via: input.via, surface: input.surface, ...(input.shareId ? { shareId: input.shareId } : {}), ...(input.categories ? { categories: input.categories } : {}), ...(input.documentId ? { documentId: input.documentId } : {}) };
  if (input.oncePerShare && input.shareId) {
    const seen = await tx.personAccessLogEntry.findFirst({
      where: { personId: input.personId, kind: "RECORD_ACCESSED", actorUserId: input.actorUserId, AND: [{ detail: { path: ["shareId"], equals: input.shareId } }, { detail: { path: ["surface"], equals: input.surface } }] },
      select: { id: true },
    });
    if (seen) return;
  }
  await tx.personAccessLogEntry.create({ data: { personId: input.personId, kind: "RECORD_ACCESSED", accessingFacilityId: input.facilityId, actorUserId: input.actorUserId, detail } });
}

const KIND_LABEL: Record<string, string> = {
  RECORD_ACCESSED: "Opened your record", SHARE_CREATED: "You shared your record", SHARE_ENDED: "A share ended",
  ACCESS_REQUESTED: "Asked to see your record", ACCESS_REQUEST_DECIDED: "A request was decided", ACCESS_REVOKED_ALL: "You revoked all access",
  CONSENT_DECIDED: "You changed a choice", LINKED: "A hospital record was linked", UNLINKED: "A hospital record was unlinked",
};
const VIA_LABEL: Record<string, string> = {
  SHARE_CODE: "your visit code", ACCESS_REQUEST: "a request you approved", BOOKING: "the record you shared with a booking", TREATING: "the treating hospital", ORG_CONSENT: "your consent to the organization", BREAK_GLASS: "emergency access",
};

/** The person's own access log (§7.1): newest first, paged by a createdAt cursor; names resolved, ids kept out of the text. */
export async function listOwnAccessLog(userId: string, opts: { before?: string; limit?: number } = {}) {
  const { requireOwnedPerson } = await import("@/lib/person/access");
  const personId = await requireOwnedPerson(userId);
  const before = opts.before && !Number.isNaN(new Date(opts.before).getTime()) ? new Date(opts.before) : undefined;
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const rows = await prisma.personAccessLogEntry.findMany({ where: { personId, ...(before ? { createdAt: { lt: before } } : {}) }, orderBy: { createdAt: "desc" }, take: limit });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorUserId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, role: true } });
  const facilities = await prisma.facility.findMany({ where: { id: { in: rows.map((r) => r.accessingFacilityId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return {
    entries: rows.map((r) => {
      const d = (r.detail ?? {}) as { via?: string; surface?: string; categories?: string[] };
      const u = users.find((x) => x.id === r.actorUserId);
      return {
        id: r.id, at: r.createdAt.toISOString(), kind: r.kind, what: KIND_LABEL[r.kind] ?? r.kind.toLowerCase().replace(/_/g, " "),
        who: u ? (u.role === "PATIENT" ? "You" : u.displayName) : null, facility: facilities.find((f) => f.id === r.accessingFacilityId)?.name ?? null,
        wayIn: d.via ? VIA_LABEL[d.via] ?? d.via : null, surface: d.surface ?? null, categories: d.categories ?? null,
      };
    }),
    next: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}
