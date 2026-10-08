import { AppError } from "../../utils/AppError.js";

/**
 * Minimal RFC 4180 CSV parser (quoted fields, "" escapes, CRLF/LF, BOM). Returns one object per
 * data row keyed by header. When `columns` is given, headers are matched case-insensitively
 * (ignoring spaces/underscores) to those canonical names; unknown headers are rejected.
 */
export function parseCsv(input, { columns = null, maxRows = 5000 } = {}) {
  const text = String(input ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      if (rows.length > maxRows + 1) throw new AppError(400, `CSV has more than ${maxRows} rows`, "VALIDATION_ERROR");
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new AppError(400, "CSV has an unterminated quoted field", "VALIDATION_ERROR");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!nonEmpty.length) return [];
  const rawHeader = nonEmpty[0].map((h) => h.trim());
  let header = rawHeader;
  if (columns) {
    const canon = new Map(columns.map((c) => [c.toLowerCase().replace(/[\s_]/g, ""), c]));
    header = rawHeader.map((h) => {
      const key = canon.get(h.toLowerCase().replace(/[\s_]/g, ""));
      if (!key && h !== "") throw new AppError(400, `Unknown CSV column "${h.slice(0, 40)}"`, "VALIDATION_ERROR");
      return key || "";
    });
  }
  return nonEmpty.slice(1).map((r) => {
    const record = {};
    header.forEach((h, idx) => {
      if (h) record[h] = r[idx] ?? "";
    });
    return record;
  });
}

function csvCell(value) {
  if (value == null) return "";
  let s = typeof value === "number" || typeof value === "boolean" ? String(value) : String(value);
  // Spreadsheet formula injection guard for text cells.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
