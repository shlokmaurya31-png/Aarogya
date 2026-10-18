import type { ProcessingPermit } from "./types";

/**
 * Permits are issued only here, and only by mayProcessPersonData() (realData.ts)
 * after the switch and consent said yes. The set of issued permits lets a
 * provider reject an object that merely looks like one.
 */
const issued = new WeakSet<object>();

export function issuePermit(personId: string): ProcessingPermit {
  const p = Object.freeze({ personId, purpose: "DOCUMENT_PROCESSING" as const }) as unknown as ProcessingPermit;
  issued.add(p);
  return p;
}

export function assertPermit(permit: ProcessingPermit | undefined): asserts permit is ProcessingPermit {
  if (!permit || !issued.has(permit)) throw new Error("A document provider was called without a processing permit.");
}
