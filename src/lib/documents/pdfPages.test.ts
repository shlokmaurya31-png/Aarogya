import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fixtureById, fixturePdf } from "./fixtures";
import { splitPdf } from "./steps";
import { pdfTextLayer, rasterizePdfPage, textLayerVerdict } from "./pdfPages";

const lab = fixtureById("lab-en-cbc")!;
const onePage = async (pdf: Buffer) => {
  const pages = await splitPdf(pdf);
  if (typeof pages === "string") throw new Error(pages);
  return pages[0];
};

describe("PDF text-layer verdict", () => {
  it("calls ordinary report text usable, in any script", () => {
    expect(textLayerVerdict("Haemoglobin 13.2 g/dL (12.0-15.0)\nWBC 7,800 /µL\nPlatelets 2.4 lakh")).toBe("USABLE");
    expect(textLayerVerdict("हीमोग्लोबिन 13.2 g/dL\nरोगी: सुनीता देवी\nदिनांक: 12/03/2026")).toBe("USABLE");
  });
  it("calls a near-empty layer empty (a scan with a stray page number)", () => {
    expect(textLayerVerdict("")).toBe("EMPTY");
    expect(textLayerVerdict("  Page 1 of 2  ")).toBe("EMPTY");
  });
  it("calls replacement, private-use, control and mojibake text garbage", () => {
    expect(textLayerVerdict("Hb ��.� g/dL ��� patient ���� name here more text")).toBe("GARBAGE");
    expect(textLayerVerdict("  report of the patient, haemoglobin and more")).toBe("GARBAGE");
    expect(textLayerVerdict("HÃ©moglobine Ã©levÃ©e â€™ patient rÃ©sultat normal values")).toBe("GARBAGE");
    expect(textLayerVerdict("~~^^||{{}}~~^^ abcdefghij ~~^^||{{}}~~^^||{{}}~~^^ klmnopqrst ~~^^||{{}}")).toBe("GARBAGE");
  });
});

describe("PDF pages", () => {
  it("reads a digital page's text layer as lines in reading order", async () => {
    const { verdict, lines } = await pdfTextLayer(await onePage(await fixturePdf(lab, { textLayer: true })));
    expect(verdict).toBe("USABLE");
    expect(lines.map((l) => l.text)).toEqual(lab.pages[0].lines.map((l) => l.text));
    for (const l of lines) for (const v of l.bbox) expect(v).toBeGreaterThanOrEqual(0);
    expect(lines[0].bbox[1]).toBeLessThan(lines[lines.length - 1].bbox[1]);
  });
  it("finds no text layer on a scan-like page and a garbage one on a mis-encoded page", async () => {
    expect((await pdfTextLayer(await onePage(await fixturePdf(lab)))).verdict).toBe("EMPTY");
    expect((await pdfTextLayer(await onePage(await fixturePdf(lab, { garbageTextLayer: true })))).verdict).toBe("GARBAGE");
  });
  it("rasterizes a page to a normalized JPEG, deterministically", async () => {
    const page = await onePage(await fixturePdf(lab));
    const a = await rasterizePdfPage(page);
    const b = await rasterizePdfPage(page);
    if (typeof a === "string" || typeof b === "string") throw new Error("rasterize");
    expect(a.contentType).toBe("image/jpeg");
    const meta = await sharp(a.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2400);
    expect(meta.height!).toBeGreaterThan(meta.width!);
    expect(a.bytes.equals(b.bytes)).toBe(true);
    // Something was drawn: the page isn't blank white.
    const stats = await sharp(a.bytes).greyscale().stats();
    expect(stats.channels[0].min).toBeLessThan(128);
  });
  it("refuses bytes that aren't a PDF", async () => {
    expect(await rasterizePdfPage(Buffer.from("not a pdf"))).toBe("UNREADABLE");
  });
});
