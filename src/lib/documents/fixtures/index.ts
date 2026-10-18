import type { DocumentFixture } from "./types";
import { SAMPLES } from "./samples";

export type { DocumentFixture, ExpectedFact } from "./types";
export { fixturePdf, ocrLines, FIXTURE_PAGE_KEY } from "./build";

/** The synthetic evaluation set (docs/DOCUMENT_PIPELINE_DESIGN.md §10.1). */
export const FIXTURES: readonly DocumentFixture[] = SAMPLES;

const BY_ID = new Map(FIXTURES.map((f) => [f.id, f]));
export function fixtureById(id: string): DocumentFixture | undefined {
  return BY_ID.get(id);
}
