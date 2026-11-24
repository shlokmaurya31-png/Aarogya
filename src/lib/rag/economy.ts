/**
 * RAG Phase 4 — the token economy as one switch, for measurement only: off,
 * a request is prepared as in Phase 3 (no Tier 0, no compression, no fitting
 * to a budget), so the benchmark can compare the same evaluation run before
 * and after (scripts/bench-rag-tokens.ts). Always on in the app.
 */
let enabled = true;
export function setTokenEconomyForTest(on: boolean) { enabled = on; }
export const tokenEconomy = () => enabled;
