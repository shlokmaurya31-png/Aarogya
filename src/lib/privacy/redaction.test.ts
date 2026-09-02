import { describe, it, expect } from "vitest";
import { redactFreeText } from "./redaction";

describe("redactFreeText", () => {
  it("redacts an Indian phone number", () => {
    const { text, labelsFound } = redactFreeText("Call the patient at 9876543210 tomorrow.");
    expect(text).not.toContain("9876543210");
    expect(labelsFound).toContain("PHONE");
  });

  it("redacts an email address", () => {
    const { text } = redactFreeText("Contact: jane.doe@hospital.example.com");
    expect(text).not.toContain("jane.doe@hospital.example.com");
  });

  it("redacts an Aadhaar-shaped number", () => {
    const { text, labelsFound } = redactFreeText("Aadhaar on file: 1234 5678 9012.");
    expect(text).not.toContain("1234 5678 9012");
    expect(labelsFound).toContain("AADHAAR");
  });

  it("leaves clinically meaningful text untouched", () => {
    const { text } = redactFreeText("Patient presents with crushing central chest pain radiating to the left arm.");
    expect(text).toBe("Patient presents with crushing central chest pain radiating to the left arm.");
  });

  it("counts multiple redactions", () => {
    const { redactedCount } = redactFreeText("Phone 9876543210, email a@b.com, phone again 8765432109.");
    expect(redactedCount).toBeGreaterThanOrEqual(3);
  });
});
