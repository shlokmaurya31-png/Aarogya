/**
 * Phase D8 — configuration engine public surface.
 *
 * Domain services resolve effective configuration through the ONE resolver
 * (`resolveConfig` for actor-scoped callers, `resolveEffectiveInternal` /
 * `snapshotConfig` for trusted server-internal callers like the D7 engine). Admin
 * routes use the override lifecycle functions. See docs/platform/configuration/.
 */
export { resolveConfig, resolveEffectiveInternal, explainConfig, snapshotConfig, type ResolveArgs } from "./resolver";
export { setOverride, publishOverride, resetOverride, getHistory, listOverrides } from "./overrides";
export { resolveKeySpec, isKnownConfigKey, listRegistry } from "./registry";
export { invalidateOrg, clearConfigCache } from "./cache";
export { assertCanReadScope, assertCanConfigureScope, resolveScopeRef, type ScopeArgs } from "./authz";
export {
  ConfigError, CONFIG_LIMITS, VALUE_TYPES, SCOPES, RESOLUTION_ORDER, OVERRIDE_STATUS,
  type ValueType, type Scope, type EffectiveConfig, type ChainEntry, type ResolutionSource,
} from "./types";
