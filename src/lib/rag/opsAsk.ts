import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { roleHasPermission, type Permission } from "@/lib/auth/permissions";
import { checkLimits, AskError, type AskResult, type Citation, type OutSentence } from "./ask";
import { contentWords } from "@/lib/ai/record/mock";
import { checkSentence, type SourceText } from "./validate";
import type { AiActor } from "./access";

/**
 * RAG Phase 5, step 5.6 — OPS_QA, the operational questions
 * (docs/RAG_ARCHITECTURE.md §6.4): live state read from the service's own
 * tables, every time, for the caller's facility only. Never embedded, never
 * cached, never sent to a model: every answer is Tier 0, a templated
 * sentence per reader, each stating when it was read.
 *
 *   reader     what it reads                         its screen's permission   names a patient only with
 *   BEDS       beds by status (and ICU beds free)    hospital:command-center   — (counts only)
 *   QUEUE      waiting, called and in-service        hospital:command-center   queue:manage (the queue
 *              entries by queue; the longest wait                              screen), when asked who
 *   STOCK      usable stock of the items the         inventory:stock:view      — (counts only)
 *              question names
 *   CRITICAL   critical results not yet              hospital:command-center   clinical:chart:read (the
 *              acknowledged; how long the oldest                               results screens), when
 *              has waited                                                       asked whose; no value
 *
 * A question needing a reader whose permission the caller lacks is refused
 * (403), never answered in part. A question no reader serves is "no record".
 * The interaction is logged like every AI request (mode OPS_QA, tier 0, no
 * text kept, no patient).
 */
export type OpsReader = "BEDS" | "QUEUE" | "STOCK" | "CRITICAL";

export const OPS_READERS: Record<OpsReader, { permission: Permission; names?: Permission; words: string[]; link: string }> = {
  BEDS: { permission: "hospital:command-center:view", words: ["bed", "beds", "occupancy", "occupied", "vacant", "icu", "ward capacity", "free beds", "available beds"], link: "/hospital-os/command-center" },
  QUEUE: { permission: "hospital:command-center:view", names: "queue:manage", words: ["queue", "queues", "waiting", "wait", "waits", "token", "tokens", "line"], link: "/hospital-os/queue" },
  STOCK: { permission: "inventory:stock:view", words: ["stock", "stocks", "inventory", "on hand", "in stock", "cylinders", "supply", "supplies"], link: "/hospital-os/inventory" },
  CRITICAL: { permission: "hospital:command-center:view", names: "clinical:chart:read", words: ["critical result", "critical results", "critical value", "critical values", "unacknowledged", "not acknowledged", "critical alerts", "critical alert"], link: "/hospital-os/command-center" },
};

const WHO = /\b(who|whose|which patients?|names?|list the patients)\b/i;
const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** The readers a question needs (none: "no record"). */
export function opsReadersFor(question: string): OpsReader[] {
  const q = norm(question);
  return (Object.keys(OPS_READERS) as OpsReader[]).filter((r) => OPS_READERS[r].words.some((w) => q.includes(` ${w} `)));
}

/** "21:05 IST on 2026-11-24": when the state was read, in the hospital's day. */
export function readAt(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.toISOString().slice(11, 16)} IST on ${ist.toISOString().slice(0, 10)}`;
}

interface Fact { reader: OpsReader; text: string }

async function readBeds(facilityId: string, at: string): Promise<Fact[]> {
  const rows = await prisma.bed.groupBy({ by: ["status"], where: { facilityId }, _count: { _all: true } });
  const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  const total = rows.reduce((a, r) => a + r._count._all, 0);
  const icuFree = await prisma.bed.count({ where: { facilityId, status: "AVAILABLE", icuCapable: true } });
  return [{ reader: "BEDS", text: `As of ${at}: ${n("AVAILABLE")} of ${total} beds available (${icuFree} ICU-capable), ${n("OCCUPIED")} occupied, ${n("RESERVED")} reserved, ${n("CLEANING")} being cleaned, ${n("BLOCKED") + n("MAINTENANCE")} blocked or under maintenance.` }];
}

async function readQueue(facilityId: string, at: string, names: boolean): Promise<Fact[]> {
  const live = await prisma.queueEntry.findMany({ where: { facilityId, status: { in: ["WAITING", "CALLED", "IN_SERVICE"] } }, select: { queueType: true, status: true, enteredAt: true, patient: names ? { select: { fullName: true } } : false }, orderBy: { enteredAt: "asc" }, take: 500 });
  if (!live.length) return [{ reader: "QUEUE", text: `As of ${at}: no one is waiting in any queue.` }];
  const types = [...new Set(live.map((e) => e.queueType))].sort();
  const now = Date.now();
  const out: Fact[] = types.map((t) => {
    const xs = live.filter((e) => e.queueType === t);
    const waiting = xs.filter((e) => e.status === "WAITING");
    const longest = waiting.length ? Math.round((now - waiting[0].enteredAt.getTime()) / 60_000) : 0;
    return { reader: "QUEUE" as const, text: `As of ${at}: ${t.replace(/_/g, " ")} queue: ${waiting.length} waiting, ${xs.length - waiting.length} called or with the clinician; longest wait ${longest} min.` };
  });
  if (names) {
    const waiting = live.filter((e) => e.status === "WAITING").slice(0, 10) as unknown as { patient: { fullName: string } }[];
    if (waiting.length) out.push({ reader: "QUEUE", text: `As of ${at}, waiting first: ${waiting.map((e) => e.patient.fullName).join("; ")}.` });
  }
  return out;
}

async function readStock(facilityId: string, at: string, question: string): Promise<Fact[]> {
  const words = contentWords(question).filter((w) => w.length >= 4 && !OPS_READERS.STOCK.words.includes(w));
  if (!words.length) return [];
  const items = await prisma.item.findMany({ where: { active: true, OR: [{ facilityId }, { facilityId: null }], AND: [{ OR: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })) }] }, select: { id: true, name: true, baseUnit: true }, take: 5, orderBy: { name: "asc" } });
  const out: Fact[] = [];
  for (const it of items) {
    const b = await prisma.stockBalance.aggregate({ where: { facilityId, itemId: it.id }, _sum: { onHandQty: true, reservedQty: true } });
    const onHand = b._sum.onHandQty ?? 0, reserved = b._sum.reservedQty ?? 0;
    out.push({ reader: "STOCK", text: `As of ${at}: ${it.name}: ${onHand - reserved} ${String(it.baseUnit).toLowerCase()} usable (${onHand} on hand, ${reserved} reserved).` });
  }
  return out;
}

async function readCritical(facilityId: string, at: string, names: boolean): Promise<Fact[]> {
  const where = { isCurrent: true, isCritical: true, acknowledgedAt: null, labOrder: { encounter: { facilityId } } };
  const labs = await prisma.labResult.findMany({ where, select: { resultedAt: true, labOrder: { select: { patient: names ? { select: { fullName: true } } : false } } }, orderBy: { resultedAt: "asc" }, take: 200 });
  const imaging = await prisma.imagingReport.count({ where: { isCurrent: true, isCritical: true, acknowledgedAt: null, imagingOrder: { encounter: { facilityId } } } });
  const oldest = labs[0]?.resultedAt ? Math.round((Date.now() - labs[0].resultedAt.getTime()) / 60_000) : 0;
  const out: Fact[] = [{ reader: "CRITICAL", text: `As of ${at}: ${labs.length} critical lab results and ${imaging} critical imaging reports not yet acknowledged${labs.length ? `; the oldest lab result has waited ${oldest} min` : ""}.` }];
  if (names && labs.length) {
    const who = [...new Set((labs as unknown as { labOrder: { patient: { fullName: string } } }[]).map((l) => l.labOrder.patient.fullName))].slice(0, 10);
    out.push({ reader: "CRITICAL", text: `As of ${at}, patients with an unacknowledged critical lab result: ${who.join("; ")}.` });
  }
  return out;
}

export async function askOps(actor: Extract<AiActor, { kind: "STAFF" }>, req: { question: string }): Promise<AskResult> {
  const started = Date.now();
  await checkLimits(actor);
  const question = req.question.trim();
  if (!question || question.length > 600) throw new AskError(400, "QUESTION_REQUIRED");
  const readers = opsReadersFor(question);
  // Every reader the question needs, or none: never a part answer.
  if (readers.some((r) => !roleHasPermission(actor.role as never, OPS_READERS[r].permission))) throw new AskError(403, "FORBIDDEN");
  const fac = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true } });
  const now = new Date();
  const at = readAt(now);
  const asksWho = WHO.test(question);
  const may = (r: OpsReader) => !!OPS_READERS[r].names && asksWho && roleHasPermission(actor.role as never, OPS_READERS[r].names!);
  const facts: Fact[] = [];
  for (const r of readers) {
    if (r === "BEDS") facts.push(...(await readBeds(actor.facilityId, at)));
    if (r === "QUEUE") facts.push(...(await readQueue(actor.facilityId, at, may("QUEUE"))));
    if (r === "STOCK") facts.push(...(await readStock(actor.facilityId, at, question)));
    if (r === "CRITICAL") facts.push(...(await readCritical(actor.facilityId, at, may("CRITICAL"))));
  }
  const id = randomUUID();
  const sources = new Map<number, SourceText>(facts.map((f, i) => [i + 1, { n: i + 1, text: f.text, context: `[Live · ${f.reader.toLowerCase()} · read ${at}]` }]));
  const sentences: OutSentence[] = facts.map((f, i) => ({ text: f.text, citations: [i + 1], kind: "FACT", labels: ["verified"] }));
  const outcome = sentences.length && sentences.every((s) => checkSentence(s, sources).ok) ? "ANSWERED" : "NO_RECORD";
  const citations: Citation[] = outcome === "ANSWERED" ? facts.map((f, i) => ({ n: i + 1, chunkId: `live:ops:${f.reader}:${i + 1}`, sourceType: "OPERATIONAL", sourceId: f.reader, origin: "VERIFIED", translated: false, handwritten: false, recordedAt: now.toISOString(), title: `Live ${f.reader.toLowerCase()}, read ${at}`, link: OPS_READERS[f.reader].link })) : [];
  await prisma.aiInteraction.create({
    data: {
      id, userId: actor.userId, role: actor.role, organizationId: fac?.organizationId ?? null, facilityId: actor.facilityId, mode: "OPS_QA", language: "en",
      model: "none", embeddingModel: "none", embeddingVersion: 0, outcome, module: "ASK", intent: `OPS_QA:${readers.join("+") || "NONE"}`, tier: 0, provider: null,
      retrievedChunkIds: [], citedChunkIds: [], inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started,
      metadataExpiresAt: new Date(now.getTime() + 365 * 86_400_000), createdAt: now,
    },
  });
  return {
    meta: { interactionId: id, mode: "OPS_QA" as never, label: "Live hospital state, read just now. Counts only unless you may see the names.", language: "en" },
    sentences: outcome === "ANSWERED" ? sentences : [{ text: "I couldn't find this in the hospital's live state.", citations: [], labels: [], kind: "GUIDANCE" }],
    citations, outcome, trace: { intent: "OPERATIONAL", readers, confidence: "RULE", answeredByReader: outcome === "ANSWERED", tier: 0, iterations: 0, inputTokens: 0 },
  };
}
