/**
 * Free-text PHI redaction. Applied to any clinician note / free-text field
 * before it can be exposed inside an educational case. This is pattern-based
 * (regex) minimization, not a clinical-grade NLP de-identifier — it is a
 * safety net inside the gateway, not a substitute for the human/institutional
 * review a real clinical-source pipeline requires (see
 * docs/REAL_CLINICAL_DATA_INTEGRATION.md).
 */

interface RedactionRule {
  label: string;
  pattern: RegExp;
}

const RULES: RedactionRule[] = [
  { label: "PHONE", pattern: /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/g },
  { label: "EMAIL", pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi },
  { label: "AADHAAR", pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  { label: "ABHA", pattern: /\b\d{2}-\d{4}-\d{4}-\d{4}\b/g },
  { label: "MRN", pattern: /\b(?:MRN|UHID|IPD|OPD)[-#:\s]?\d{4,}\b/gi },
  { label: "PIN_CODE", pattern: /\b\d{6}\b(?=\s*(?:,|\.|$))/g },
  { label: "URL", pattern: /\bhttps?:\/\/\S+/gi },
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
  labelsFound: string[];
}

export function redactFreeText(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;
  const labelsFound = new Set<string>();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, () => {
      redactedCount += 1;
      labelsFound.add(rule.label);
      return `[REDACTED:${rule.label}]`;
    });
  }

  return { text, redactedCount, labelsFound: [...labelsFound] };
}
