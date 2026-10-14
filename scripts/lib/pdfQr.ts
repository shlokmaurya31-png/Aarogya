/**
 * Reads back the QR code that src/lib/documents draws into a PDF, so a check
 * can prove the printed verify link is the expected one. pdf-lib embeds the
 * QR PNG as a FlateDecode image XObject of raw 8-bit pixels; this inflates
 * each such image and asks jsQR to decode it.
 */
import { inflateSync } from "node:zlib";
import jsQR from "jsqr";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

export async function readQrCodes(pdfBytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(pdfBytes);
  const found: string[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (dict.get(PDFName.of("Filter")) !== PDFName.of("FlateDecode")) continue;
    const width = (dict.get(PDFName.of("Width")) as PDFNumber).asNumber();
    const height = (dict.get(PDFName.of("Height")) as PDFNumber).asNumber();
    const pixels = inflateSync(obj.contents);
    const channels = pixels.length / (width * height);
    if (channels !== 1 && channels !== 3) continue;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = pixels[i * channels + (channels === 3 ? c : 0)];
      rgba[i * 4 + 3] = 255;
    }
    const code = jsQR(rgba, width, height);
    if (code) found.push(code.data);
  }
  return found;
}
