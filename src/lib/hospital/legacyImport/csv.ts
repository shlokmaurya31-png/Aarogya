/**
 * Flagship 2, step 6 — a strict CSV reader (RFC 4180): a header row, commas,
 * double-quoted fields (with "" for a quote, and commas or newlines inside),
 * CRLF or LF. A malformed file (an unclosed quote, a row with more fields than
 * the header) is refused whole, never half-read. Blank lines are skipped. Each
 * record keeps its line number in the file, for the import report.
 */
export interface CsvRecord { line: number; values: string[] }

export class CsvFormatError extends Error {}

export function parseCsv(text: string): { header: string[]; records: CsvRecord[] } {
  const src = text.replace(/^﻿/, "");
  const rows: CsvRecord[] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push({ line: rowLine, values: row });
    row = [];
    field = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === "\"") {
        if (src[i + 1] === "\"") { field += "\""; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      if (ch === "\n") line += 1;
      field += ch; i += 1; continue;
    }
    if (ch === "\"") {
      if (field !== "") throw new CsvFormatError(`Line ${line}: a quote inside an unquoted field.`);
      quoted = true; i += 1; continue;
    }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r" && src[i + 1] === "\n") { i += 1; continue; }
    if (ch === "\n") { endRow(); line += 1; rowLine = line; i += 1; continue; }
    field += ch; i += 1;
  }
  if (quoted) throw new CsvFormatError(`Line ${rowLine}: a quoted field is never closed.`);
  if (field !== "" || row.length) endRow();
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].values.map((h) => h.trim());
  if (new Set(header).size !== header.length) throw new CsvFormatError("The header names a column twice.");
  for (const r of rows.slice(1)) if (r.values.length > header.length) throw new CsvFormatError(`Line ${r.line}: more fields than the header.`);
  return { header, records: rows.slice(1) };
}
