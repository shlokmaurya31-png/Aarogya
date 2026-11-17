import { getAIProvider } from "./getAIProvider";
import type { ScholarAI } from "./provider";

/**
 * Aarogya Scholar's AI: the tutor, the viva examiner and the simulated
 * patient, over synthetic teaching cases from the Clinical Learning Data
 * Gateway only. The type leaves out the portal assistant, so Scholar code
 * cannot reach it, and nothing here takes a patient's record.
 */
export function getScholarAI(): ScholarAI {
  return getAIProvider();
}
