import sharp from "sharp";
import type { DocumentStepError } from "@prisma/client";

/**
 * Week 4b, 4a follow-up — page images are normalized before OCR
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §4.1 `doc-page-split`; pre-launch item 13).
 * The upload itself is never touched: the normalized image is a derived page
 * stored alongside it, with a record of what was done to it.
 *
 *   orientation  the EXIF orientation is applied (a phone photo taken sideways
 *                comes out upright), then dropped with the rest of the metadata
 *                (no camera, time or GPS tags reach storage or a provider);
 *   deskew       a small tilt (up to ±10°) is measured from the text lines'
 *                projection profile (ink found by a local threshold, so
 *                shadows and the background around a photographed page don't
 *                count) and undone, only when the measurement is clear;
 *                anything ambiguous is left as it is;
 *   size         the long edge is brought down to 2,400 px (never enlarged);
 *   compression  JPEG (mozjpeg, quality 82) on a white background.
 *
 * Decompression bombs are refused (TOO_LARGE above 80 megapixels) and bytes
 * that don't decode are UNREADABLE. The output is deterministic for the same
 * input and library version. A page turned 90° or 180° with no EXIF tag is
 * left for the OCR model, which reads rotated pages.
 */

export const NORMALIZATION = {
  version: 1,
  maxEdge: 2400,
  jpegQuality: 82,
  maxInputPixels: 80_000_000,
  maxSkewDegrees: 10,
  /** Below this the page is treated as straight (rotating would only blur it). */
  minSkewDegrees: 0.3,
  /** The best angle's profile score must beat the unrotated one by this factor. */
  minGain: 1.08,
} as const;

export interface Normalization {
  version: number;
  exifOrientation: number | null;
  deskewDegrees: number;
  input: { width: number; height: number; format: string; bytes: number };
  output: { width: number; height: number; format: "jpeg"; bytes: number };
  resized: boolean;
}

export type NormalizedPage = { bytes: Buffer; contentType: "image/jpeg"; normalization: Normalization };

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/**
 * The page's tilt in degrees, in sharp's convention (positive: turned
 * clockwise; rotating by the negative levels it), or 0 when unclear.
 * Projection profile: dark pixels are projected onto the axis perpendicular
 * to each candidate angle; the angle whose row histogram is most peaked
 * (largest sum of squares) is the one the text lines run along.
 */
export function estimateSkew(gray: Uint8Array, width: number, height: number, local?: Uint8Array): { degrees: number; gain: number } {
  const xs: number[] = [], ys: number[] = [];
  if (local) {
    // Local threshold: ink is darker than its own neighbourhood. Shadows,
    // dark backgrounds around a photographed page and gradients are not ink.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (gray[i] + LOCAL_INK_DELTA < local[i]) { xs.push(x); ys.push(y); }
    }
    return profile(xs, ys, width, height, gray.length);
  }
  // Otsu's threshold on the grey histogram.
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v] += 1;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (gray[y * width + x] <= threshold) { xs.push(x); ys.push(y); }
  return profile(xs, ys, width, height, total);
}

/** How much darker than its neighbourhood (0–255) a pixel must be to count as ink. */
const LOCAL_INK_DELTA = 28;

function profile(xs: number[], ys: number[], width: number, height: number, total: number): { degrees: number; gain: number } {
  // A blank page, or one that is mostly ink (a photo, not text): nothing to measure.
  if (xs.length < 50 || xs.length > total * 0.5) return { degrees: 0, gain: 1 };
  const diag = Math.ceil(Math.hypot(width, height));
  const score = (deg: number) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const bins = new Float64Array(2 * diag + 2);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] * c - xs[i] * s) + diag] += 1;
    let sq = 0;
    for (const b of bins) sq += b * b;
    return sq;
  };
  const base = score(0);
  let bestDeg = 0, bestScore = base;
  const scan = (from: number, to: number, step: number) => {
    for (let d = from; d <= to + 1e-9; d += step) {
      const sc = score(d);
      if (sc > bestScore) { bestScore = sc; bestDeg = d; }
    }
  };
  scan(-NORMALIZATION.maxSkewDegrees, NORMALIZATION.maxSkewDegrees, 0.5);
  const coarse = bestDeg;
  scan(coarse - 0.5, coarse + 0.5, 0.1);
  const gain = base === 0 ? 1 : bestScore / base;
  const degrees = Math.round(bestDeg * 10) / 10;
  if (Math.abs(degrees) < NORMALIZATION.minSkewDegrees || gain < NORMALIZATION.minGain) return { degrees: 0, gain };
  return { degrees, gain };
}

/** Normalizes one page image (JPEG, PNG or WebP). Never modifies `bytes`. */
export async function normalizePageImage(bytes: Buffer): Promise<NormalizedPage | Extract<DocumentStepError, "UNREADABLE" | "TOO_LARGE">> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    return "UNREADABLE";
  }
  if (!meta.width || !meta.height || !meta.format) return "UNREADABLE";
  if (meta.width * meta.height > NORMALIZATION.maxInputPixels) return "TOO_LARGE";
  try {
    // Upright (EXIF applied) and within the size limit, on white.
    const upright = await sharp(bytes, { limitInputPixels: NORMALIZATION.maxInputPixels, failOn: "error" })
      .rotate()
      .resize({ width: NORMALIZATION.maxEdge, height: NORMALIZATION.maxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: WHITE })
      .png({ compressionLevel: 1 })
      .toBuffer({ resolveWithObject: true });
    // Measure the tilt on a small grey copy (fast; text lines survive the downscale).
    const probe = await sharp(upright.data).greyscale().resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    const local = await sharp(probe.data, { raw: probe.info }).blur(12).toColourspace("b-w").raw().toBuffer();
    const skew = estimateSkew(new Uint8Array(probe.data), probe.info.width, probe.info.height, new Uint8Array(local));
    let img = sharp(upright.data);
    if (skew.degrees !== 0) {
      img = sharp(await img.rotate(-skew.degrees, { background: WHITE }).png({ compressionLevel: 1 }).toBuffer())
        // The rotation grows the canvas; keep within the limit.
        .resize({ width: NORMALIZATION.maxEdge, height: NORMALIZATION.maxEdge, fit: "inside", withoutEnlargement: true });
    }
    const out = await img.flatten({ background: WHITE }).jpeg({ quality: NORMALIZATION.jpegQuality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const oriented = meta.orientation && meta.orientation >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
    return {
      bytes: out.data,
      contentType: "image/jpeg",
      normalization: {
        version: NORMALIZATION.version,
        exifOrientation: meta.orientation ?? null,
        // The correction applied (the opposite of the measured tilt).
        deskewDegrees: skew.degrees === 0 ? 0 : -skew.degrees,
        input: { width: meta.width, height: meta.height, format: meta.format, bytes: bytes.length },
        output: { width: out.info.width, height: out.info.height, format: "jpeg", bytes: out.data.length },
        resized: upright.info.width < oriented.width || upright.info.height < oriented.height,
      },
    };
  } catch {
    return "UNREADABLE";
  }
}
