/**
 * Phase D10 — Hospital Command Center 2.0 public surface. A read/intelligence layer
 * over canonical domain truth; never a source of truth, never a mutation path. See
 * docs/COMMAND_CENTER.md.
 */
export { getCommandCenterOverview, getCommandCenterSection, type OverviewOptions } from "./command-center";
export { getDrillDown, isDrillKind, DRILLDOWN_KINDS, type DrillKind } from "./drilldowns";
export { ALL_SECTIONS, BASE_PERMISSION, type SectionKey } from "./authz";
export { resolveWindow } from "./filters";
export { THRESHOLD_DEFAULTS } from "./thresholds";
export { worstStatus, statusFromThreshold, type CommandCenterOverview, type CommandSection, type Metric, type CcStatus } from "./types";
