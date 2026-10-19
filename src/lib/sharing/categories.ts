import type { RagCategory, RagSensitiveCategory, ShareCategory, SharePurpose } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { ALL_SENSITIVE } from "@/lib/rag/scope";

/**
 * Week 4c — what a share covers (docs/CONSENT_SHARING_DESIGN.md §2): one
 * table every read path uses. The five categories of the spec; allergies ride
 * with every share (the safety minimum, §12 decision 4); notes, diagnoses,
 * vitals and referrals are never shared through a share (decision 5).
 */
export const SHARE_CATEGORIES: readonly ShareCategory[] = ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "UPLOADS"];
/** A code share's default: the four record categories, no uploads (what the code showed before 4c, §12 decision 2). */
export const DEFAULT_CODE_CATEGORIES: readonly ShareCategory[] = ["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES"];
export const SHARE_PURPOSES: readonly SharePurpose[] = ["CONSULTATION", "SECOND_OPINION", "FOLLOW_UP", "REFERRAL", "OTHER"];
export const SENSITIVE_CATEGORIES: readonly RagSensitiveCategory[] = ALL_SENSITIVE;

/** Retrieval categories a share admits: its own and ALLERGIES. UPLOADS stays: a person chunk needs it as well as its own category. */
export function ragCategoriesFor(categories: readonly ShareCategory[]): RagCategory[] {
  return [...new Set<RagCategory>([...categories, "ALLERGIES"])];
}

/** Patient-provided entry kinds → the share category they also need (besides UPLOADS). Allergies need only UPLOADS. */
export const PROVIDED_KIND_CATEGORY: Record<string, ShareCategory | "ALWAYS" | null> = {
  LAB_RESULT: "LABS", MEDICATION_HISTORY: "PRESCRIPTIONS", ALLERGY: "ALWAYS", DIAGNOSIS: null, PROCEDURE: null,
};

export interface ShareChoice {
  categories: ShareCategory[];
  sensitiveCategories: RagSensitiveCategory[];
  recordedFrom?: Date;
  recordedTo?: Date;
  purpose: SharePurpose;
}

function list<T extends string>(v: unknown, allowed: readonly T[], name: string): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !allowed.includes(x as T))) throw new BadRequestError(`${name} must be a list of ${allowed.join(", ")}.`);
  return [...new Set(v as T[])].sort();
}

function day(v: unknown, name: string): Date | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(new Date(v).getTime())) throw new BadRequestError(`${name} must be a date (YYYY-MM-DD).`);
  return new Date(v);
}

/** Parses a share choice from a request body. `defaults` fills what the body leaves out. */
export function parseShareChoice(body: Record<string, unknown> | null | undefined, defaults: { categories?: readonly ShareCategory[]; purpose?: SharePurpose } = {}): ShareChoice {
  const b = body ?? {};
  const categories = b.categories === undefined && defaults.categories ? [...defaults.categories] : list(b.categories, SHARE_CATEGORIES, "categories");
  if (!categories.length) throw new BadRequestError("Choose at least one category to share.");
  const sensitiveCategories = list(b.sensitiveCategories, SENSITIVE_CATEGORIES, "sensitiveCategories");
  const period = (b.period ?? {}) as Record<string, unknown>;
  const recordedFrom = day(period.from, "period.from");
  // A "to" date covers that whole day.
  const toDay = day(period.to, "period.to");
  const recordedTo = toDay ? new Date(toDay.getTime() + 86_400_000 - 1) : undefined;
  if (recordedFrom && recordedTo && recordedFrom > recordedTo) throw new BadRequestError("The period's start must come before its end.");
  const purpose = (b.purpose ?? defaults.purpose ?? "CONSULTATION") as SharePurpose;
  if (!SHARE_PURPOSES.includes(purpose)) throw new BadRequestError(`purpose must be one of ${SHARE_PURPOSES.join(", ")}.`);
  return { categories, sensitiveCategories, recordedFrom, recordedTo, purpose };
}

/** Is a moment inside the share's period (inclusive)? An undated item is outside any period. */
export function inPeriod(at: Date | null | undefined, from?: Date | null, to?: Date | null): boolean {
  if (!from && !to) return true;
  if (!at) return false;
  return (!from || at >= from) && (!to || at <= to);
}
