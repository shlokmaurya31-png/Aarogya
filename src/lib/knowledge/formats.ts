/**
 * RAG Phase 2, step 2.3 — which files a knowledge upload accepts
 * (docs/RAG_IMPLEMENTATION_PLAN.md §4.1; §13 decision 7): PDF, plain text,
 * Markdown, HTML, CSV and JSON. DOCX is deferred and refused with a message
 * asking for a PDF export. The type is decided by the bytes AND the name and
 * declared type together; a file whose bytes say one thing and whose name or
 * type says another is refused. Pure.
 */
export const KNOWLEDGE_FORMATS = ["PDF", "TEXT", "MARKDOWN", "HTML", "CSV", "JSON"] as const;
export type KnowledgeFormat = (typeof KNOWLEDGE_FORMATS)[number];

export const CONTENT_TYPE: Record<KnowledgeFormat, string> = {
  PDF: "application/pdf",
  TEXT: "text/plain",
  MARKDOWN: "text/markdown",
  HTML: "text/html",
  CSV: "text/csv",
  JSON: "application/json",
};

/** 20 MB: a long formulary as a PDF fits; anything larger is split by the hospital. */
export const KNOWLEDGE_MAX_BYTES = 20 * 1024 * 1024;

export type FormatRefusal = "EMPTY" | "TOO_LARGE" | "DOCX_DEFERRED" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "NOT_UTF8";

export const FORMAT_MESSAGES: Record<FormatRefusal, string> = {
  EMPTY: "The file is empty.",
  TOO_LARGE: "The file is larger than 20 MB. Split it into parts.",
  DOCX_DEFERRED: "Word files aren't accepted yet. Export the document as a PDF and upload that.",
  UNSUPPORTED_TYPE: "Upload a PDF, plain text, Markdown, HTML, CSV or JSON file.",
  TYPE_MISMATCH: "The file's contents don't match its name or type.",
  NOT_UTF8: "The text file isn't valid UTF-8 text.",
};

const BY_EXTENSION: Record<string, KnowledgeFormat> = {
  pdf: "PDF", txt: "TEXT", text: "TEXT", md: "MARKDOWN", markdown: "MARKDOWN", htm: "HTML", html: "HTML", csv: "CSV", json: "JSON",
};
const BY_TYPE: Record<string, KnowledgeFormat> = {
  "application/pdf": "PDF", "text/plain": "TEXT", "text/markdown": "MARKDOWN", "text/x-markdown": "MARKDOWN", "text/html": "HTML",
  "text/csv": "CSV", "application/csv": "CSV", "application/vnd.ms-excel": "CSV", "application/json": "JSON", "text/json": "JSON",
};
const DOCX = /\.(docx?|dotx|odt|rtf)$/i;

/** A binary signature that no accepted text format starts with. */
function binarySignature(b: Buffer): "PDF" | "ZIP" | "OLE" | "OTHER" | null {
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return "PDF";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "ZIP";
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0) return "OLE";
  const head = b.subarray(0, 8);
  if (head[0] === 0x89 && head[1] === 0x50) return "OTHER"; // PNG
  if (head[0] === 0xff && head[1] === 0xd8) return "OTHER"; // JPEG
  if (head.toString("latin1", 0, 2) === "MZ" || head.toString("latin1", 1, 4) === "ELF") return "OTHER";
  if (head.toString("latin1", 0, 4) === "GIF8" || head.toString("latin1", 0, 4) === "RIFF") return "OTHER";
  return null;
}

/** Text a reader can use: valid UTF-8 (a BOM is fine), no NUL or other C0 controls but tab, newline and carriage return. */
export function decodeText(b: Buffer): string | null {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(s)) return null;
  return s.replace(/^﻿/u, "");
}

export type DetectedFormat = { ok: true; format: KnowledgeFormat; contentType: string } | { ok: false; code: FormatRefusal };

export function detectFormat(input: { bytes: Buffer; fileName: string; declaredType?: string | null }): DetectedFormat {
  const { bytes, fileName } = input;
  if (DOCX.test(fileName)) return { ok: false, code: "DOCX_DEFERRED" };
  if (bytes.length === 0) return { ok: false, code: "EMPTY" };
  if (bytes.length > KNOWLEDGE_MAX_BYTES) return { ok: false, code: "TOO_LARGE" };
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byName = BY_EXTENSION[ext];
  const declared = (input.declaredType ?? "").split(";")[0].trim().toLowerCase();
  if (/officedocument|msword|opendocument/.test(declared)) return { ok: false, code: "DOCX_DEFERRED" };
  const byType = declared && declared !== "application/octet-stream" ? BY_TYPE[declared] : undefined;
  if (!byName) return { ok: false, code: "UNSUPPORTED_TYPE" };
  if (declared && declared !== "application/octet-stream" && !byType) return { ok: false, code: "UNSUPPORTED_TYPE" };
  // A declared type is honoured only when it names the same format as the extension (CSV may come as plain text).
  if (byType && byType !== byName && !(byName === "CSV" && byType === "TEXT") && !(byName === "MARKDOWN" && byType === "TEXT")) return { ok: false, code: "TYPE_MISMATCH" };

  const sig = binarySignature(bytes);
  if (byName === "PDF") return sig === "PDF" ? { ok: true, format: "PDF", contentType: CONTENT_TYPE.PDF } : { ok: false, code: "TYPE_MISMATCH" };
  if (sig === "ZIP" || sig === "OLE") return { ok: false, code: bytes.includes(Buffer.from("word/")) ? "DOCX_DEFERRED" : "TYPE_MISMATCH" };
  if (sig) return { ok: false, code: "TYPE_MISMATCH" };
  const text = decodeText(bytes);
  if (text === null) return { ok: false, code: "NOT_UTF8" };
  // The bytes must read as the format the name says.
  if (byName === "JSON") {
    try { JSON.parse(text); } catch { return { ok: false, code: "TYPE_MISMATCH" }; }
  }
  if (byName === "HTML" && !/<\s*(?:!doctype\s+html|html|body|p|h[1-6]|table|div|ul|ol)\b/i.test(text)) return { ok: false, code: "TYPE_MISMATCH" };
  if (byName !== "HTML" && byName !== "MARKDOWN" && /<\s*(?:!doctype\s+html|html)\b/i.test(text.slice(0, 512))) return { ok: false, code: "TYPE_MISMATCH" };
  return { ok: true, format: byName, contentType: CONTENT_TYPE[byName] };
}
