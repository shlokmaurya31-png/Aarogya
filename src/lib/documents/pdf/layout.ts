/**
 * Phase 1.2 — the document layout engine.
 *
 * A DocumentSpec is a data-only description of a document (letterhead, title,
 * meta, a list of typed sections, an optional QR verify link). Templates produce
 * a DocumentSpec; renderDocument turns it into PDF bytes. Keeping this data-only
 * makes templates trivially testable without touching pdf-lib.
 */
import {
  newDocument,
  drawText,
  drawKeyValueRow,
  drawDivider,
  drawSpacer,
  drawTable,
  drawQrBlock,
  applyDraftWatermark,
  applyFooters,
  MARGIN,
  PAGE_HEIGHT,
  BRAND,
  MUTED,
  type RenderCtx,
} from "./primitives";

export interface Letterhead {
  facilityName: string;
  addressLines?: string[];
  contactLine?: string;
  /** Doctor / authoriser name + registration, shown under the title where relevant. */
  authorName?: string;
  authorRegistration?: string;
}

export type DocumentSection =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "keyValues"; rows: Array<{ label: string; value: string }> }
  | { kind: "table"; headers: string[]; rows: string[][]; widths: number[] }
  | { kind: "note"; text: string }
  | { kind: "signature"; label: string; name?: string; registration?: string };

export interface DocumentSpec {
  letterhead: Letterhead;
  title: string;
  /** Small meta rows under the title, e.g. document number + issue date. */
  meta?: Array<{ label: string; value: string }>;
  sections: DocumentSection[];
  /** When set, a QR linking here is drawn near the end with an authenticity caption. */
  verifyUrl?: string;
  footerNote: string;
  isDraft?: boolean;
}

function drawLetterhead(ctx: RenderCtx, lh: Letterhead): void {
  drawText(ctx, lh.facilityName, { size: 16, bold: true, color: BRAND });
  for (const line of lh.addressLines ?? []) drawText(ctx, line, { size: 9, color: MUTED });
  if (lh.contactLine) drawText(ctx, lh.contactLine, { size: 9, color: MUTED });
  drawDivider(ctx);
}

export async function renderDocument(spec: DocumentSpec): Promise<Uint8Array> {
  const ctx = (await newDocument()) as RenderCtx;

  drawLetterhead(ctx, spec.letterhead);

  drawText(ctx, spec.title, { size: 13, bold: true });
  if (spec.letterhead.authorName) {
    const reg = spec.letterhead.authorRegistration ? ` · Reg. No. ${spec.letterhead.authorRegistration}` : "";
    drawText(ctx, `${spec.letterhead.authorName}${reg}`, { size: 9, color: MUTED });
  }
  drawSpacer(ctx, 4);

  if (spec.meta && spec.meta.length) {
    for (const m of spec.meta) drawKeyValueRow(ctx, m.label, m.value);
    drawDivider(ctx);
  }

  for (const section of spec.sections) {
    switch (section.kind) {
      case "heading":
        drawSpacer(ctx, 4);
        drawText(ctx, section.text, { size: 11, bold: true, color: BRAND });
        drawSpacer(ctx, 2);
        break;
      case "paragraph":
        drawText(ctx, section.text, { size: 10 });
        break;
      case "keyValues":
        for (const r of section.rows) drawKeyValueRow(ctx, r.label, r.value);
        break;
      case "table":
        drawTable(ctx, section.headers, section.rows, section.widths);
        break;
      case "note":
        drawSpacer(ctx, 2);
        drawText(ctx, section.text, { size: 8.5, color: MUTED });
        break;
      case "signature":
        drawSpacer(ctx, 24);
        drawText(ctx, "____________________________", { size: 10 });
        drawText(ctx, section.label, { size: 9, color: MUTED });
        if (section.name) drawText(ctx, section.name, { size: 10, bold: true });
        if (section.registration) drawText(ctx, `Reg. No. ${section.registration}`, { size: 8.5, color: MUTED });
        break;
    }
  }

  if (spec.verifyUrl) {
    drawSpacer(ctx, 10);
    await drawQrBlock(ctx, spec.verifyUrl, "Scan to verify authenticity");
  }

  if (spec.isDraft) applyDraftWatermark(ctx);
  applyFooters(ctx, spec.footerNote);

  return ctx.pdf.save();
}

/** Exposed for tests: rough page-count estimate is derived from the real render. */
export { MARGIN, PAGE_HEIGHT };
