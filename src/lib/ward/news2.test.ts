import { describe, expect, it } from "vitest";
import { news2 } from "./news2";

describe("NEWS2 placeholder (Flagship 4d)", () => {
  it("scores each parameter at its band edges", () => {
    const rr = [[8, 3], [9, 1], [11, 1], [12, 0], [20, 0], [21, 2], [24, 2], [25, 3]];
    for (const [v, p] of rr) expect(news2({ rr: v }).parts.rr, `rr ${v}`).toBe(p);
    for (const [v, p] of [[91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0]]) expect(news2({ spo2: v }).parts.spo2, `spo2 ${v}`).toBe(p);
    for (const [v, p] of [[90, 3], [91, 2], [100, 2], [101, 1], [110, 1], [111, 0], [219, 0], [220, 3]]) expect(news2({ sbp: v }).parts.sbp, `sbp ${v}`).toBe(p);
    for (const [v, p] of [[40, 3], [41, 1], [50, 1], [51, 0], [90, 0], [91, 1], [110, 1], [111, 2], [130, 2], [131, 3]]) expect(news2({ hr: v }).parts.hr, `hr ${v}`).toBe(p);
    for (const [v, p] of [[35.0, 3], [35.1, 1], [36.0, 1], [36.1, 0], [38.0, 0], [38.1, 1], [39.0, 1], [39.1, 2]]) expect(news2({ tempC: v }).parts.tempC, `temp ${v}`).toBe(p);
    expect(news2({ onOxygen: true }).parts.onOxygen).toBe(2);
    expect(news2({ onOxygen: false }).parts.onOxygen).toBe(0);
    expect(news2({ consciousness: "ALERT" }).parts.consciousness).toBe(0);
    for (const c of ["NEW_CONFUSION", "VOICE", "PAIN", "UNRESPONSIVE"] as const) expect(news2({ consciousness: c }).parts.consciousness).toBe(3);
  });

  it("a normal set is routine; the journey's set (HR 88, SBP 124, SpO2 97) calls no one", () => {
    const r = news2({ rr: 16, spo2: 97, onOxygen: false, sbp: 124, hr: 72, consciousness: "ALERT", tempC: 37 });
    expect(r).toMatchObject({ score: 0, scored: 7, response: "ROUTINE", callDoctor: false });
    expect(news2({ hr: 88, sbp: 124, spo2: 97 })).toMatchObject({ score: 0, scored: 3, callDoctor: false });
  });

  it("calls the doctor at an aggregate of 5, or any single red score; 7 or more is an emergency", () => {
    expect(news2({ rr: 22, hr: 95, tempC: 38.5 })).toMatchObject({ score: 4, red: false, response: "WARD", callDoctor: false });
    expect(news2({ rr: 22, hr: 95, tempC: 38.5, spo2: 95 })).toMatchObject({ score: 5, response: "URGENT", callDoctor: true });
    expect(news2({ consciousness: "NEW_CONFUSION" })).toMatchObject({ score: 3, red: true, response: "URGENT", callDoctor: true });
    expect(news2({ rr: 26, spo2: 90, onOxygen: true })).toMatchObject({ score: 8, response: "EMERGENCY", callDoctor: true });
  });

  it("scores only what was recorded", () => {
    expect(news2({})).toMatchObject({ score: 0, scored: 0, callDoctor: false });
  });
});
