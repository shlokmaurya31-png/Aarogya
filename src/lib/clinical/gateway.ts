import { getClinicalDataMode } from "./config";
import { SyntheticCaseProvider } from "./providers/syntheticCaseProvider";
import type { ClinicalCaseProvider } from "./provider";

/**
 * Clinical Learning Data Gateway entry point. This is the single function the
 * rest of the app calls to get "the active case provider" — nothing else
 * should `new SyntheticCaseProvider()` directly, so that changing the active
 * mode is a one-place change.
 */
let cached: ClinicalCaseProvider | null = null;

export function getActiveCaseProvider(): ClinicalCaseProvider {
  const mode = getClinicalDataMode(); // throws if misconfigured
  if (!cached) {
    if (mode === "synthetic") {
      cached = new SyntheticCaseProvider();
    } else {
      // Unreachable: getClinicalDataMode() already validated the mode above.
      throw new Error(`Unhandled CLINICAL_DATA_MODE: ${mode}`);
    }
  }
  return cached;
}
