import { prisma } from "@/lib/db";
import type { Span } from "./protect";

/**
 * Week 4a — the person's identifiers, kept away from providers
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §6: no name, phone, UHID or ABHA number in
 * a prompt). Before page text goes to translation, tagging or extraction, these
 * become protected spans (placeholders), restored afterwards from the
 * originals. Covered: the Person's display name, their contacts, and the
 * names, UHIDs and phones of the facility records linked to them; plus any
 * ABHA-number-shaped or Indian-mobile-shaped string, whoever it belongs to.
 * Numbers are masked anyway for translation; this covers names and ids.
 */
export async function personIdentifiers(personId: string): Promise<string[]> {
  const [person, contacts, links] = await Promise.all([
    prisma.person.findUnique({ where: { id: personId }, select: { displayName: true } }),
    prisma.personContact.findMany({ where: { personId }, select: { value: true } }),
    prisma.personPatientLink.findMany({ where: { personId }, select: { patient: { select: { fullName: true, preferredName: true, uhid: true, phone: true } } } }),
  ]);
  const xs = [person?.displayName, ...contacts.map((c) => c.value), ...links.flatMap((l) => [l.patient.fullName, l.patient.preferredName, l.patient.uhid, l.patient.phone])];
  return [...new Set(xs.filter((x): x is string => !!x && x.trim().length >= 3).map((x) => x.trim()))];
}

const ABHA = /(?<!\d)\d{2}-?\d{4}-?\d{4}-?\d{4}(?!\d)/gu;
const MOBILE = /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/gu;

export function identifierSpans(text: string, identifiers: readonly string[]): Span[] {
  const out: Span[] = [];
  const lower = text.toLowerCase();
  for (const id of identifiers) {
    const needle = id.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) out.push({ start: at, end: at + needle.length, kind: "IDENTIFIER" });
  }
  for (const re of [ABHA, MOBILE]) for (const m of text.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length, kind: "IDENTIFIER" });
  return out;
}
