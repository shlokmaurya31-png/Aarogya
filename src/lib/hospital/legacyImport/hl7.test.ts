import { describe, expect, it } from "vitest";
import { comp, first, Hl7FormatError, parseHl7, parseHl7Time, reps } from "./hl7";

/** A segment from its fields by number (HL7 numbering), so a fixture can't miscount pipes. */
const seg = (name: string, f: Record<number, string>) => [name, ...Array.from({ length: Math.max(...Object.keys(f).map(Number)) }, (_, i) => f[i + 1] ?? "")].join("|");
const zonedIst = (key: string, minute: number) => new Date(Date.parse(`${key}T00:00:00Z`) + (minute - 330) * 60_000);

describe("parseHl7 (Flagship 5)", () => {
  const text = [
    "\x0bMSH|^~\\&|OLDHIMS|PUNE|AAROGYA|PUNE|202503151030||ADT^A01|MSG001|P|2.5",
    "PID|1||H1^^^PUNE^MR~123412341234^^^UIDAI^NI||Rao^Asha^K||19800312|F|||||9876543210",
    seg("PV1", { 1: "1", 2: "I", 3: "W3^12^A", 7: "123^Sharma^Anita^^^Dr", 10: "GM", 19: "V2", 44: "202503151030" }),
    "OBX|1|ST|NOTE^Note||a \\F\\ b \\S\\ c||||||F\x1c\r",
    "MSH|^~\\&|OLDHIMS|PUNE|AAROGYA|PUNE|202503161200||ORU^R01|MSG002|P|2.5\r\nPID|1||H1^^^PUNE^MR",
  ].join("\r");
  const msgs = parseHl7(text);
  it("splits messages on MSH, segments on CR/LF, and drops MLLP framing", () => {
    expect(msgs.map((m) => [m.index, m.type, m.controlId])).toEqual([[1, "ADT^A01", "MSG001"], [2, "ORU^R01", "MSG002"]]);
    expect(msgs[0].segments.map((s) => s.name)).toEqual(["MSH", "PID", "PV1", "OBX"]);
  });
  it("numbers fields as HL7 does (MSH-1 is the separator) and reads components and repetitions", () => {
    const msh = first(msgs[0], "MSH")!;
    expect(comp(msh, 1)).toBe("|");
    expect(comp(msh, 3)).toBe("OLDHIMS");
    const pid = first(msgs[0], "PID")!;
    expect(reps(pid, 3).map((r) => [r[0], r[4]])).toEqual([["H1", "MR"], ["123412341234", "NI"]]);
    expect([comp(pid, 5, 1), comp(pid, 5, 2)]).toEqual(["Rao", "Asha"]);
    expect(comp(first(msgs[0], "PV1"), 19)).toBe("V2");
    expect(comp(first(msgs[0], "PV1"), 44)).toBe("202503151030");
  });
  it("decodes escape sequences", () => {
    expect(comp(first(msgs[0], "OBX"), 5)).toBe("a | b ^ c");
  });
  it("refuses what isn't HL7", () => {
    expect(() => parseHl7("PID|1||X")).toThrow(Hl7FormatError);
    expect(() => parseHl7("MSH")).toThrow(Hl7FormatError);
    expect(() => parseHl7("MSH|^~\\&|A\nnot a segment")).toThrow(Hl7FormatError);
  });
});

describe("parseHl7Time", () => {
  it("reads a time in the facility's zone, or with its own offset", () => {
    expect(parseHl7Time("202503151030", zonedIst)?.at.toISOString()).toBe("2025-03-15T05:00:00.000Z");
    expect(parseHl7Time("202503151030+0000", zonedIst)?.at.toISOString()).toBe("2025-03-15T10:30:00.000Z");
    expect(parseHl7Time("20250315", zonedIst)).toMatchObject({ hasTime: false });
  });
  it("refuses an impossible date or a time that isn't HL7", () => {
    expect(parseHl7Time("20250230", zonedIst)).toBeNull();
    expect(parseHl7Time("2025-03-15", zonedIst)).toBeNull();
    expect(parseHl7Time("202503152460", zonedIst)).toBeNull();
  });
});
