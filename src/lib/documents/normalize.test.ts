import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { estimateSkew, normalizePageImage, NORMALIZATION } from "./normalize";

/** A synthetic page: dark bars where text lines would be, on white. */
async function page(w = 1200, h = 1600): Promise<Buffer> {
  const rects = Array.from({ length: 30 }, (_, i) => `<rect x="${100 + (i % 3) * 40}" y="${120 + i * 45}" width="${700 + ((i * 37) % 250)}" height="14" fill="#222"/>`).join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/>${rects}</svg>`)).png().toBuffer();
}

async function residualSkew(bytes: Buffer) {
  const g = await sharp(bytes).greyscale().resize({ width: 900, height: 900, fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  return estimateSkew(new Uint8Array(g.data), g.info.width, g.info.height).degrees;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ok = <T>(r: T | string): T => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("page image normalization", () => {
  it.each([6, -4, 9, 2.5])("undoes a %s° tilt and leaves the page level", async (tilt) => {
    const tilted = await sharp(await page()).rotate(tilt, { background: "white" }).jpeg().toBuffer();
    const r = ok(await normalizePageImage(tilted));
    expect(r.normalization.deskewDegrees).toBeCloseTo(-tilt, 0);
    expect(Math.abs(await residualSkew(r.bytes))).toBeLessThan(0.5);
  });

  it("leaves a straight page unrotated", async () => {
    const r = ok(await normalizePageImage(await page()));
    expect(r.normalization.deskewDegrees).toBe(0);
    expect([r.normalization.output.width, r.normalization.output.height]).toEqual([1200, 1600]);
  });

  it("doesn't rotate a page with nothing to measure (blank)", async () => {
    const blank = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
    expect(ok(await normalizePageImage(blank)).normalization.deskewDegrees).toBe(0);
  });

  it("applies the EXIF orientation, then drops all metadata", async () => {
    // Stored sideways with orientation 6 ("rotate 90° clockwise to view").
    const sideways = await sharp(await sharp(await page()).rotate(-90).toBuffer()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = ok(await normalizePageImage(sideways));
    expect(r.normalization.exifOrientation).toBe(6);
    expect([r.normalization.output.width, r.normalization.output.height]).toEqual([1200, 1600]);
    const meta = await sharp(r.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("brings an oversized photo down to the maximum edge, never enlarging", async () => {
    const big = await sharp(await page(1200, 1600)).resize(4500, 6000).png().toBuffer();
    const r = ok(await normalizePageImage(big));
    expect(Math.max(r.normalization.output.width, r.normalization.output.height)).toBe(NORMALIZATION.maxEdge);
    expect(r.normalization.resized).toBe(true);
    const small = ok(await normalizePageImage(await sharp(await page(600, 800)).png().toBuffer()));
    expect([small.normalization.output.width, small.normalization.output.height]).toEqual([600, 800]);
    expect(small.normalization.resized).toBe(false);
  });

  it("outputs a compressed JPEG", async () => {
    const png = await sharp(await page()).png({ compressionLevel: 0 }).toBuffer();
    const r = ok(await normalizePageImage(png));
    expect(r.contentType).toBe("image/jpeg");
    expect((await sharp(r.bytes).metadata()).format).toBe("jpeg");
    expect(r.bytes.length).toBeLessThan(png.length);
  });

  it("is deterministic and never modifies its input", async () => {
    const input = await sharp(await page()).rotate(5, { background: "white" }).jpeg().toBuffer();
    const before = sha(input);
    const a = ok(await normalizePageImage(input));
    const b = ok(await normalizePageImage(input));
    expect(sha(a.bytes)).toBe(sha(b.bytes));
    expect(sha(input)).toBe(before);
  });

  it("refuses decompression bombs and undecodable bytes", async () => {
    const bomb = await sharp({ create: { width: 10000, height: 10000, channels: 3, background: "white" } }).png().toBuffer();
    expect(await normalizePageImage(bomb)).toBe("TOO_LARGE");
    expect(await normalizePageImage(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))).toBe("UNREADABLE");
  });
});
