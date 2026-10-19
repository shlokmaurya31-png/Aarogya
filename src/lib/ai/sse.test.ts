import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

describe("the AI answer stream parser", () => {
  it("returns whole events as they complete, across chunk boundaries", () => {
    const feed = createSseParser();
    expect(feed('event: meta\ndata: {"mode":"CHART_QA"}\n\nevent: sen')).toEqual([{ event: "meta", data: { mode: "CHART_QA" } }]);
    expect(feed('tence\ndata: {"text":"Hb 11.2 g/dL.","citations":[1]}\n')).toEqual([]);
    expect(feed("\nevent: done\ndata: {\"outcome\":\"ANSWERED\"}\n\n")).toEqual([
      { event: "sentence", data: { text: "Hb 11.2 g/dL.", citations: [1] } },
      { event: "done", data: { outcome: "ANSWERED" } },
    ]);
  });
  it("keeps a non-JSON data line as text, and skips empty blocks", () => {
    const feed = createSseParser();
    expect(feed("event: x\ndata: plain\n\n\n\n")).toEqual([{ event: "x", data: "plain" }]);
  });
});
