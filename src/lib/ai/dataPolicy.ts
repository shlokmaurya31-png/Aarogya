/**
 * RAG Phase 1 — which provider may receive real data (ADR 0005 part C).
 *
 * Two conditions, both required:
 *   1. the global switch, AI_REAL_DATA_ENABLED=true (off by default);
 *   2. that provider's own flag, AI_PHI_ALLOWED_<PROVIDER>=true (off by
 *      default for every external provider), turned on only after its
 *      data-processing agreement and cross-border check are recorded in
 *      docs/PRE_LAUNCH_CHECKLIST.md.
 * Synthetic data needs neither. Checked inside each real provider, where it
 * asserts its permit, so no caller can route around it.
 */
export const EXTERNAL_PROVIDERS = ["ANTHROPIC", "VOYAGE"] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

type Env = Record<string, string | undefined>;

export function realDataEnabled(env: Env = process.env): boolean {
  return env.AI_REAL_DATA_ENABLED === "true";
}

/** Only the exact string "true" turns a provider's flag on. */
export function phiAllowed(provider: ExternalProvider, env: Env = process.env): boolean {
  return env[`AI_PHI_ALLOWED_${provider}`] === "true";
}

/** May this external provider be sent data of this kind? Synthetic: yes. Real: the switch and its own flag. */
export function providerMayReceive(provider: ExternalProvider, real: boolean, env: Env = process.env): boolean {
  return !real || (realDataEnabled(env) && phiAllowed(provider, env));
}
