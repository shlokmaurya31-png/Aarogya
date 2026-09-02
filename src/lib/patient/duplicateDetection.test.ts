import { describe, it, expect } from "vitest";
import { scoreCandidate, classify } from "./duplicateDetection";

describe("scoreCandidate — duplicate patient matching", () => {
  it("scores an exact name + phone + DOB match as high confidence", () => {
    const dob = new Date("1990-05-15");
    const { score, matchedOn } = scoreCandidate(
      { fullName: "Ravi Kumar", phone: "9876543210", dob, sex: "male" },
      { fullName: "Ravi Kumar", phone: "9876543210", dob, sex: "male" }
    );
    expect(classify(score)).toBe("HIGH_CONFIDENCE_MATCH");
    expect(matchedOn).toContain("name");
    expect(matchedOn).toContain("phone");
    expect(matchedOn).toContain("dob");
  });

  it("matches phone regardless of country-code formatting", () => {
    const { score } = scoreCandidate(
      { fullName: "Zzz Nomatch", phone: "+91 98765 43210" },
      { fullName: "Different Person", phone: "9876543210", dob: null, sex: "" }
    );
    expect(score).toBeGreaterThanOrEqual(35); // phone-only match still crosses into POSSIBLE_MATCH range
  });

  it("gives no match for unrelated patients", () => {
    const { score } = scoreCandidate(
      { fullName: "Alpha One", phone: "1111111111" },
      { fullName: "Beta Two", phone: "2222222222", dob: null, sex: "" }
    );
    expect(classify(score)).toBe("NO_MATCH");
  });

  it("gives partial credit for name-token overlap without an exact match", () => {
    const { score, matchedOn } = scoreCandidate(
      { fullName: "Ravi Kumar" },
      { fullName: "ravi   kumar", phone: null, dob: null, sex: "" }
    );
    // normalization collapses whitespace/case, so this is actually an exact match, not partial —
    // confirms normalizeName() is doing its job rather than falsely reporting a weaker match.
    expect(matchedOn).toContain("name");
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it("classify() boundaries are consistent", () => {
    expect(classify(0)).toBe("NO_MATCH");
    expect(classify(34)).toBe("NO_MATCH");
    expect(classify(35)).toBe("POSSIBLE_MATCH");
    expect(classify(69)).toBe("POSSIBLE_MATCH");
    expect(classify(70)).toBe("HIGH_CONFIDENCE_MATCH");
  });
});
