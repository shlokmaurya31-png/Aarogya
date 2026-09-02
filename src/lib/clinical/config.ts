/**
 * The ONLY switch controlling which ClinicalCaseProvider is active. This is
 * deliberately not a generic "enable feature X" flag: setting
 * CLINICAL_DATA_MODE to anything other than "synthetic" throws at import
 * time rather than silently falling back, because the failure mode we want
 * for an unrecognized/mistyped value is "the app refuses to boot", not
 * "the app quietly serves whatever it was already serving". Turning on a
 * real clinical feed requires writing and wiring a new provider class (see
 * docs/REAL_CLINICAL_DATA_INTEGRATION.md) — there is no environment-variable
 * path to one.
 */

export type ClinicalDataMode = "synthetic";

const IMPLEMENTED_MODES: ClinicalDataMode[] = ["synthetic"];

export function getClinicalDataMode(): ClinicalDataMode {
  const raw = process.env.CLINICAL_DATA_MODE ?? "synthetic";
  if (!IMPLEMENTED_MODES.includes(raw as ClinicalDataMode)) {
    throw new Error(
      `CLINICAL_DATA_MODE="${raw}" is not an implemented provider. Only "synthetic" is wired up in this build. ` +
        `See docs/REAL_CLINICAL_DATA_INTEGRATION.md before implementing another mode.`
    );
  }
  return raw as ClinicalDataMode;
}
