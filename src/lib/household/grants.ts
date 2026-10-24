import type { ProxyGrant, ProxyPermission, Prisma, RagSensitiveCategory, ShareCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { ownedPersonId } from "@/lib/person/access";
import { DEFAULT_SHARE_CATEGORIES, SENSITIVE_CATEGORIES, SHARE_CATEGORIES } from "@/lib/sharing/categories";
import { ageOn, ADOLESCENT_FROM } from "./vocab";

/**
 * Week 5b — proxy grants (docs/HOUSEHOLD_DESIGN.md §5, §7). Membership confers
 * nothing: a proxy acts for a member only through an ACTIVE ProxyGrant whose
 * proxy is the actor's own Person, for exactly its permissions (VIEW, UPLOAD,
 * BOOK, SHARE, INSURANCE, USE_AI), its categories (4c's) and its sensitive
 * opt-ins. Every proxy read and write asks proxyGrantFor, through personAccess
 * (the PROXY way in); no route checks household membership.
 *
 * Sensitive categories are off for every proxy by default. For a managed
 * minor the guardian may opt in only while the child is under 12: a 12–17
 * year-old's sensitive categories stay hidden from guardians (5b decision,
 * pending lawyer review).
 */
export const ALL_PERMISSIONS: ProxyPermission[] = ["VIEW", "UPLOAD", "BOOK", "SHARE", "INSURANCE", "USE_AI"];

export async function grantEventTx(tx: Prisma.TransactionClient, g: ProxyGrant, from: string | null, actorUserId: string | null) {
  await emitDomainEvent(tx, {
    type: "ProxyGrantChanged", aggregateId: g.id, personId: g.memberPersonId, actorUserId,
    payload: {
      personId: g.memberPersonId, grantId: g.id, memberPersonId: g.memberPersonId, proxyPersonId: g.proxyPersonId, basis: g.basis, from: from as never, to: g.status,
      permissions: g.permissions, categories: g.categories, sensitiveCount: g.sensitiveCategories.length, ...(g.lapsedReason ? { lapsedReason: g.lapsedReason as never } : {}),
    },
  });
  await tx.personAccessLogEntry.create({ data: { personId: g.memberPersonId, kind: "PROXY_GRANT_CHANGED", actorUserId, detail: { grantId: g.id, proxyPersonId: g.proxyPersonId, to: g.status, permissions: g.permissions } } });
}

export function parsePermissions(v: unknown): ProxyPermission[] {
  if (!Array.isArray(v) || !v.length || v.some((p) => !ALL_PERMISSIONS.includes(p as ProxyPermission))) throw new BadRequestError(`permissions must be some of ${ALL_PERMISSIONS.join(", ")}.`);
  return [...new Set(v as ProxyPermission[])];
}

export function parseCategories(v: unknown): ShareCategory[] {
  if (v === undefined) return [...DEFAULT_SHARE_CATEGORIES];
  if (!Array.isArray(v) || !v.length || v.some((c) => !SHARE_CATEGORIES.includes(c as ShareCategory))) throw new BadRequestError("categories must be share categories (at least one).");
  return [...new Set(v as ShareCategory[])];
}

/** Sensitive opt-ins for a grant: refused for a guardian of a 12–17-year-old (pending lawyer review). */
export async function parseSensitive(v: unknown, memberPersonId: string, basis: string, at = new Date()): Promise<RagSensitiveCategory[]> {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((c) => !SENSITIVE_CATEGORIES.includes(c as RagSensitiveCategory))) throw new BadRequestError("Unknown sensitive category.");
  const list = [...new Set(v as RagSensitiveCategory[])];
  if (list.length && basis === "GUARDIAN") {
    const m = await prisma.person.findUnique({ where: { id: memberPersonId }, select: { dateOfBirth: true } });
    if (!m?.dateOfBirth || ageOn(m.dateOfBirth, at) >= ADOLESCENT_FROM) throw new BadRequestError("A guardian can't see a 12–17-year-old's sensitive records.");
  }
  return list;
}

export interface ProxyAccess {
  grant: ProxyGrant;
  proxyPersonId: string;
  memberPersonId: string;
  categories: ShareCategory[];
  sensitive: RagSensitiveCategory[];
}

/**
 * The one decision for proxy access: the actor's own Person holds an ACTIVE,
 * unexpired grant from this member with `permission`; the member's Person is
 * ACTIVE. Null otherwise (callers report 404-shaped). A guardian's sensitive
 * opt-ins are dropped once the child is 12 (the rule is applied at read time
 * too, not only when the grant was made).
 */
export async function proxyGrantFor(proxyUserId: string, memberPersonId: string, permission: ProxyPermission, at = new Date()): Promise<ProxyAccess | null> {
  const proxyPersonId = await ownedPersonId(proxyUserId);
  if (!proxyPersonId || proxyPersonId === memberPersonId) return null;
  const member = await prisma.person.findUnique({ where: { id: memberPersonId }, select: { status: true, dateOfBirth: true } });
  if (member?.status !== "ACTIVE") return null;
  const grant = await prisma.proxyGrant.findFirst({
    where: { memberPersonId, proxyPersonId, status: "ACTIVE", permissions: { has: permission }, OR: [{ validUntil: null }, { validUntil: { gt: at } }] },
    orderBy: { createdAt: "desc" },
  });
  if (!grant) return null;
  const adolescentGuardian = grant.basis === "GUARDIAN" && (!member.dateOfBirth || ageOn(member.dateOfBirth, at) >= ADOLESCENT_FROM);
  return { grant, proxyPersonId, memberPersonId, categories: grant.categories, sensitive: adolescentGuardian ? [] : grant.sensitiveCategories };
}

/** For proxy routes: the grant, or 404. */
export async function requireProxy(proxyUserId: string, memberPersonId: string, permission: ProxyPermission): Promise<ProxyAccess> {
  // Through the person access resolver (the PROXY way in), like every person-level read.
  const { personAccess } = await import("@/lib/person/access");
  const g = await personAccess({ kind: "PROXY", userId: proxyUserId, permission }, memberPersonId, permission === "VIEW" ? "PROFILE" : "UPLOADS");
  if (!g?.proxy) throw new NotFoundError();
  return g.proxy;
}

/** The members the actor may act for (the profile switcher): each with the grant's permissions. Subject only; every request re-checks. */
export async function proxyProfiles(proxyUserId: string) {
  const proxyPersonId = await ownedPersonId(proxyUserId);
  if (!proxyPersonId) return [];
  const now = new Date();
  const grants = await prisma.proxyGrant.findMany({ where: { proxyPersonId, status: "ACTIVE", OR: [{ validUntil: null }, { validUntil: { gt: now } }] }, orderBy: { createdAt: "asc" } });
  const people = await prisma.person.findMany({ where: { id: { in: grants.map((g) => g.memberPersonId) }, status: "ACTIVE" }, select: { id: true, displayName: true } });
  return grants.flatMap((g) => {
    const p = people.find((x) => x.id === g.memberPersonId);
    return p ? [{ personId: p.id, name: p.displayName, basis: g.basis, permissions: g.permissions, categories: g.categories }] : [];
  });
}

/** Grants about the caller (an adult member always sees their proxies). */
export async function grantsAboutMe(userId: string) {
  const personId = await ownedPersonId(userId);
  if (!personId) throw new NotFoundError();
  const grants = await prisma.proxyGrant.findMany({ where: { memberPersonId: personId, status: { in: ["ACTIVE", "PENDING_CONFIRMATION"] } }, orderBy: { createdAt: "asc" } });
  const people = await prisma.person.findMany({ where: { id: { in: grants.map((g) => g.proxyPersonId) } }, select: { id: true, displayName: true } });
  return grants.map((g) => ({ id: g.id, proxyName: people.find((p) => p.id === g.proxyPersonId)?.displayName ?? "Someone", basis: g.basis, status: g.status, permissions: g.permissions, categories: g.categories, sensitiveCategories: g.sensitiveCategories }));
}

/** An adult member removes a proxy at any time. */
export async function revokeGrantAsMember(userId: string, grantId: string) {
  const personId = await ownedPersonId(userId);
  const g = await prisma.proxyGrant.findUnique({ where: { id: grantId } });
  if (!personId || !g || g.memberPersonId !== personId) throw new NotFoundError();
  if (g.status !== "ACTIVE" && g.status !== "PENDING_CONFIRMATION") throw new ConflictError("This proxy no longer acts for you.");
  await prisma.$transaction(async (tx) => {
    const r = await tx.proxyGrant.updateMany({ where: { id: g.id, status: g.status }, data: { status: "REVOKED", revokedAt: new Date(), version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This proxy no longer acts for you.");
    await grantEventTx(tx, { ...g, status: "REVOKED" }, g.status, userId);
  });
  return { status: "REVOKED" as const };
}

/** An adult member changes what a proxy may do or see (only narrower or wider by their own choice). */
export async function updateGrantAsMember(userId: string, grantId: string, body: Record<string, unknown>) {
  const personId = await ownedPersonId(userId);
  const g = await prisma.proxyGrant.findUnique({ where: { id: grantId } });
  if (!personId || !g || g.memberPersonId !== personId || g.status !== "ACTIVE") throw new NotFoundError();
  const permissions = body.permissions === undefined ? g.permissions : parsePermissions(body.permissions);
  const categories = body.categories === undefined ? g.categories : parseCategories(body.categories);
  const sensitiveCategories = body.sensitiveCategories === undefined ? g.sensitiveCategories : await parseSensitive(body.sensitiveCategories, personId, "MEMBER_CHOICE");
  return prisma.$transaction(async (tx) => {
    const r = await tx.proxyGrant.updateMany({ where: { id: g.id, version: g.version }, data: { permissions, categories, sensitiveCategories, basis: "MEMBER_CHOICE", grantedByPersonId: personId, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This grant changed in the meantime.");
    const after = await tx.proxyGrant.findUniqueOrThrow({ where: { id: g.id } });
    await grantEventTx(tx, after, "ACTIVE", userId);
    return after;
  });
}
