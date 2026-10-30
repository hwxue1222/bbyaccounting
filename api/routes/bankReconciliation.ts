import { Router, type Response } from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { requireOrgAccess } from "../lib/orgAccess.js";
import { issueVoucherNo } from "../lib/voucher.js";

const router = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
(globalThis as any).pdfjsWorker ||= pdfjsWorker;

type StatementSide = "debit" | "credit";
type ColumnKey = "date" | "description" | "debit" | "credit" | "amount" | "side";
type PdfColumnKey = "date" | "description" | "reference" | "debit" | "credit" | "balance";

type ParsedStatementRow = {
  rowNo: number;
  date: string;
  description: string;
  side: StatementSide;
  amount: number;
};

type AmountToken = {
  raw: string;
  index: number;
  amount: number;
  signedAmount: number;
};

type PdfTextCell = {
  text: string;
  x: number;
  y: number;
};

type PdfTextRow = {
  y: number;
  cells: PdfTextCell[];
};

const HEADER_KEYWORDS: Record<ColumnKey, string[]> = {
  date: ["date", "transactiondate", "postingdate", "valuedate", "日期", "交易日期", "入账日期"],
  description: ["description", "particular", "particulars", "narration", "memo", "details", "remark", "摘要", "描述", "备注", "说明"],
  debit: ["debit", "dr", "withdrawal", "payment", "out", "借方", "支出", "付款", "转出"],
  credit: ["credit", "cr", "deposit", "receipt", "in", "贷方", "收入", "收款", "转入"],
  amount: ["amount", "amt", "交易额", "金额", "发生额"],
  side: ["side", "drcr", "debitcredit", "借贷", "借贷方", "方向"],
};

function normalizeHeader(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_\-()[\]./:]/g, "");
}

function headerType(label: string): ColumnKey | null {
  const normalized = normalizeHeader(label);
  if (!normalized) return null;
  for (const [key, aliases] of Object.entries(HEADER_KEYWORDS) as Array<[ColumnKey, string[]]>) {
    if (aliases.some((alias) => normalized.includes(alias))) return key;
  }
  return null;
}

function formatYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial) * 24 * 60 * 60 * 1000);
}

function parseDateValue(value: unknown, text: string): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatYmd(new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())));
  }
  if (typeof value === "number") {
    const parsed = excelSerialToDate(value);
    if (parsed) return formatYmd(parsed);
  }
  const raw = String(text || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[./]/g, "-").replace(/\s+/g, "");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) {
    const [y, m, d] = normalized.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (!Number.isNaN(parsed.getTime())) return formatYmd(parsed);
  }
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(normalized)) {
    const [d, m, y] = normalized.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (!Number.isNaN(parsed.getTime())) return formatYmd(parsed);
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatYmd(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())));
  }
  return null;
}

function parseAmountValue(value: unknown, text: string): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(Math.abs(value) * 100) / 100;
  const raw = String(text || "").trim();
  if (!raw) return null;
  const negative = raw.includes("(") && raw.includes(")") || /^-/.test(raw);
  const cleaned = raw.replace(/[, ]/g, "").replace(/[()]/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.abs(negative ? -parsed : parsed) * 100) / 100;
}

function parseSignedAmountText(text: string): number | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const negative = raw.includes("(") && raw.includes(")") || /^-/.test(raw);
  const cleaned = raw.replace(/[, ]/g, "").replace(/[()]/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  const signed = negative ? -Math.abs(parsed) : parsed;
  return Math.round(signed * 100) / 100;
}

function parseSideValue(raw: string): StatementSide | null {
  const normalized = normalizeHeader(raw);
  if (!normalized) return null;
  if (
    normalized.includes("credit") ||
    normalized === "cr" ||
    normalized.includes("deposit") ||
    normalized.includes("receipt") ||
    normalized.includes("贷") ||
    normalized.includes("收入") ||
    normalized.includes("转入")
  ) {
    return "credit";
  }
  if (
    normalized.includes("debit") ||
    normalized === "dr" ||
    normalized.includes("withdrawal") ||
    normalized.includes("payment") ||
    normalized.includes("借") ||
    normalized.includes("支出") ||
    normalized.includes("转出")
  ) {
    return "debit";
  }
  return null;
}

function extractAmountTokens(text: string): AmountToken[] {
  return Array.from(text.matchAll(/[+-]?\(?\d[\d,]*\.\d{2}\)?/g))
    .map((match) => {
      const raw = String(match[0] || "");
      const signedAmount = parseSignedAmountText(raw);
      const amount = parseAmountValue(undefined, raw);
      if (signedAmount == null || amount == null || !(amount > 0)) return null;
      return {
        raw,
        index: match.index ?? 0,
        amount,
        signedAmount,
      } satisfies AmountToken;
    })
    .filter(Boolean) as AmountToken[];
}

function textHasDebitHint(text: string): boolean {
  return /(debit|dr\b|withdrawal|payment|charges?|借|支出|付款|转出)/i.test(text);
}

function textHasCreditHint(text: string): boolean {
  return /(credit|cr\b|deposit|receipt|income|贷|收入|收款|转入)/i.test(text);
}

function normalizePdfText(text: string): string {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ");
}

function pdfHeaderKind(text: string): PdfColumnKey | null {
  const normalized = normalizeHeader(text);
  if (!normalized) return null;
  if (normalized.includes("date") || normalized.includes("tarikh")) return "date";
  if (normalized.includes("description") || normalized.includes("diskripsi")) return "description";
  if (normalized.includes("cheque") || normalized.includes("refno") || normalized.includes("rujukan") || normalized.includes("reference")) return "reference";
  if (normalized.includes("withdrawal") || normalized.includes("pengeluaran")) return "debit";
  if (normalized.includes("deposit")) return "credit";
  if (normalized.includes("balance") || normalized.includes("baki")) return "balance";
  return null;
}

function buildPdfRows(items: PdfTextCell[]): PdfTextRow[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfTextRow[] = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - item.y) <= 4) {
      last.cells.push(item);
      last.y = (last.y + item.y) / 2;
    } else {
      rows.push({ y: item.y, cells: [item] });
    }
  }
  for (const row of rows) {
    row.cells.sort((a, b) => a.x - b.x);
  }
  return rows;
}

function detectPdfColumnAnchors(rows: PdfTextRow[]): { anchors: Partial<Record<PdfColumnKey, number>>; headerBottomY: number } | null {
  const anchors: Partial<Record<PdfColumnKey, number>> = {};
  let headerBottomY = -Infinity;
  for (const row of rows.slice(0, 25)) {
    for (const cell of row.cells) {
      const kind = pdfHeaderKind(cell.text);
      if (!kind) continue;
      if (anchors[kind] == null) anchors[kind] = cell.x;
      else anchors[kind] = Math.round((Number(anchors[kind]) + cell.x) / 2);
      headerBottomY = Math.max(headerBottomY, row.y);
    }
  }
  if (!anchors.date || !anchors.description) return null;
  return { anchors, headerBottomY };
}

function nearestPdfColumn(x: number, anchors: Partial<Record<PdfColumnKey, number>>): PdfColumnKey | null {
  let best: { key: PdfColumnKey; dist: number } | null = null;
  for (const [key, anchorX] of Object.entries(anchors) as Array<[PdfColumnKey, number | undefined]>) {
    if (anchorX == null) continue;
    const dist = Math.abs(x - anchorX);
    if (!best || dist < best.dist) best = { key, dist };
  }
  return best?.key || null;
}

function appendText(base: string, extra: string): string {
  const next = normalizePdfText(extra);
  if (!next) return base;
  if (!base) return next;
  if (base.includes(next)) return base;
  return `${base} ${next}`.trim();
}

function detectColumns(worksheet: ExcelJS.Worksheet): { headerRow: number; columns: Partial<Record<ColumnKey, number>>; score: number } | null {
  const maxRows = Math.min(Math.max(worksheet.actualRowCount || 0, worksheet.rowCount || 0, 0), 20);
  let best: { headerRow: number; columns: Partial<Record<ColumnKey, number>>; score: number } | null = null;

  for (let rowNo = 1; rowNo <= maxRows; rowNo += 1) {
    const row = worksheet.getRow(rowNo);
    const columns: Partial<Record<ColumnKey, number>> = {};
    let score = 0;

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const kind = headerType(cell.text || "");
      if (!kind || columns[kind]) return;
      columns[kind] = colNumber;
    });

    if (columns.date) score += 2;
    if (columns.description) score += 2;
    if (columns.debit) score += 2;
    if (columns.credit) score += 2;
    if (columns.amount) score += 1;
    if (columns.side) score += 1;

    const hasAmounts = Boolean((columns.debit && columns.credit) || (columns.amount && columns.side) || columns.amount || columns.debit || columns.credit);
    if (!hasAmounts) continue;
    if (score < 4) continue;

    if (!best || score > best.score) {
      best = { headerRow: rowNo, columns, score };
    }
  }

  return best;
}

function parseWorksheet(worksheet: ExcelJS.Worksheet): ParsedStatementRow[] {
  const detected = detectColumns(worksheet);
  if (!detected) {
    throw new Error("无法识别 Excel 表头，请确保包含日期、摘要、借贷方/金额列。");
  }

  const { headerRow, columns } = detected;
  const out: ParsedStatementRow[] = [];
  const lastRow = Math.max(worksheet.actualRowCount || 0, worksheet.rowCount || 0);

  for (let rowNo = headerRow + 1; rowNo <= lastRow; rowNo += 1) {
    const row = worksheet.getRow(rowNo);
    const dateCell = columns.date ? row.getCell(columns.date) : null;
    const descriptionCell = columns.description ? row.getCell(columns.description) : null;
    const debitCell = columns.debit ? row.getCell(columns.debit) : null;
    const creditCell = columns.credit ? row.getCell(columns.credit) : null;
    const amountCell = columns.amount ? row.getCell(columns.amount) : null;
    const sideCell = columns.side ? row.getCell(columns.side) : null;

    const date = dateCell ? parseDateValue(dateCell.value, dateCell.text || "") : null;
    const description = String(descriptionCell?.text || "").trim();
    const debitAmount = debitCell ? parseAmountValue(debitCell.value, debitCell.text || "") : null;
    const creditAmount = creditCell ? parseAmountValue(creditCell.value, creditCell.text || "") : null;
    const singleAmount = amountCell ? parseAmountValue(amountCell.value, amountCell.text || "") : null;
    const explicitSide = sideCell ? parseSideValue(sideCell.text || "") : null;

    let side: StatementSide | null = null;
    let amount: number | null = null;

    if ((debitAmount || 0) > 0) {
      side = "debit";
      amount = debitAmount;
    } else if ((creditAmount || 0) > 0) {
      side = "credit";
      amount = creditAmount;
    } else if ((singleAmount || 0) > 0 && explicitSide) {
      side = explicitSide;
      amount = singleAmount;
    }

    const hasVisibleData = Boolean(date || description || amount || String(row.values || "").trim());
    if (!hasVisibleData) continue;
    if (!date || !amount || !side) continue;

    out.push({
      rowNo,
      date,
      description,
      side,
      amount: Math.round(amount * 100) / 100,
    });
  }

  if (!out.length) {
    throw new Error("没有解析到有效流水，请检查日期、借贷方和金额列是否完整。");
  }

  return out;
}

async function loadExcelStatementRows(file: Express.Multer.File): Promise<ParsedStatementRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);

  const sheets = workbook.worksheets.filter((sheet) => (sheet.actualRowCount || sheet.rowCount || 0) > 0);
  if (!sheets.length) {
    throw new Error("Excel 为空，无法导入。");
  }

  let bestRows: ParsedStatementRow[] | null = null;
  for (const sheet of sheets) {
    try {
      const rows = parseWorksheet(sheet);
      if (!bestRows || rows.length > bestRows.length) bestRows = rows;
    } catch {
      // Try the next sheet.
    }
  }

  if (!bestRows) {
    throw new Error("无法识别银行单格式，请使用包含日期、摘要、借贷方、金额列的 xlsx 文件。");
  }

  return bestRows;
}

function isDateFirstLine(line: string): boolean {
  return /^(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/.test(line);
}

function parsePdfStatementLine(line: string, rowNo: number): ParsedStatementRow | null {
  const trimmed = String(line || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const dateMatch = trimmed.match(/^(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/);
  if (!dateMatch) return null;

  const date = parseDateValue(undefined, dateMatch[1]);
  if (!date) return null;

  const rest = trimmed.slice(dateMatch[0].length).trim();
  if (!rest) return null;

  const amountTokens = extractAmountTokens(rest);
  if (!amountTokens.length) return null;

  const sideMatch = /\b(cr|credit|dr|debit)\b|[借贷]/i.exec(rest);
  const explicitSide = sideMatch ? parseSideValue(sideMatch[0]) : null;
  let side: StatementSide | null = explicitSide;
  let chosen: AmountToken | null = null;

  if (explicitSide) {
    const sideIndex = sideMatch?.index ?? rest.length;
    const nearestBeforeSide = [...amountTokens].reverse().find((token) => token.index < sideIndex) || null;
    chosen = nearestBeforeSide || amountTokens[amountTokens.length - 1] || null;
  }

  if (!chosen && amountTokens.length >= 2) {
    const first = amountTokens[0];
    const second = amountTokens[1];
    if (first.amount > 0 && second.amount <= 0) {
      chosen = first;
      side = "debit";
    } else if (second.amount > 0 && first.amount <= 0) {
      chosen = second;
      side = "credit";
    } else if (first.amount > 0 && second.amount > 0) {
      // Common PDF statements flatten as: description debit credit balance.
      if (/^\s*0+(?:\.0+)?\s*$/.test(first.raw)) {
        chosen = second;
        side = "credit";
      } else if (/^\s*0+(?:\.0+)?\s*$/.test(second.raw)) {
        chosen = first;
        side = "debit";
      }
    }
  }

  if (!chosen && amountTokens.length === 1) {
    chosen = amountTokens[0];
    if (!side) {
      if (chosen.signedAmount < 0 || textHasDebitHint(rest)) side = "debit";
      else if (chosen.signedAmount > 0 || textHasCreditHint(rest)) side = "credit";
    }
  }

  if (!chosen) {
    chosen = amountTokens[0];
    if (!side) {
      if (textHasDebitHint(rest)) side = "debit";
      else if (textHasCreditHint(rest)) side = "credit";
    }
  }

  if (!chosen || !side) return null;

  const descriptionEnd = chosen.index > 0 ? chosen.index : rest.length;
  const descriptionRaw = rest.slice(0, descriptionEnd).replace(/\b(cr|credit|dr|debit)\b/gi, "").replace(/[借贷]/g, "").trim();
  const description = descriptionRaw || rest.replace(chosen.raw, "").replace(/\b(cr|credit|dr|debit)\b/gi, "").replace(/[借贷]/g, "").trim();

  return {
    rowNo,
    date,
    description,
    side,
    amount: chosen.amount,
  };
}

function ensurePdfRuntimePolyfills() {
  const g = globalThis as any;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      multiplySelf() {
        return this;
      }
      preMultiplySelf() {
        return this;
      }
      translateSelf() {
        return this;
      }
      scaleSelf() {
        return this;
      }
      rotateSelf() {
        return this;
      }
      invertSelf() {
        return this;
      }
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {};
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {};
  }
}

async function loadPdfStatementRows(file: Express.Multer.File): Promise<ParsedStatementRow[]> {
  ensurePdfRuntimePolyfills();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(file.buffer),
    useWorkerFetch: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await loadingTask.promise;
    const out: ParsedStatementRow[] = [];
    let logicalRowNo = 1;

    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      });

      const items: PdfTextCell[] = [];
      for (const item of textContent.items as any[]) {
        if (!item || typeof item.str !== "string") continue;
        const text = normalizePdfText(item.str);
        if (!text) continue;
        const transform = item.transform || [];
        const [x, y] = viewport.convertToViewportPoint(transform[4] || 0, transform[5] || 0);
        items.push({ text, x, y });
      }

      const rows = buildPdfRows(items);
      const header = detectPdfColumnAnchors(rows);
      let tableRows: ParsedStatementRow[] = [];

      if (header) {
        let current: ParsedStatementRow | null = null;
        for (const row of rows) {
          if (row.y <= header.headerBottomY) continue;
          const mapped: Partial<Record<PdfColumnKey, string>> = {};
          for (const cell of row.cells) {
            const key = nearestPdfColumn(cell.x, header.anchors);
            if (!key) continue;
            mapped[key] = appendText(mapped[key] || "", cell.text);
          }

          const dateText = String(mapped.date || "").trim();
          const date = dateText ? parseDateValue(undefined, dateText) : null;
          const debitAmount = parseAmountValue(undefined, String(mapped.debit || ""));
          const creditAmount = parseAmountValue(undefined, String(mapped.credit || ""));
          const descriptionPart = String(mapped.description || "").trim();

          if (date) {
            if (current && current.amount > 0 && current.description) {
              tableRows.push(current);
            }
            const side: StatementSide | null = (debitAmount || 0) > 0 ? "debit" : (creditAmount || 0) > 0 ? "credit" : null;
            const amount = (debitAmount || 0) > 0 ? debitAmount : (creditAmount || 0) > 0 ? creditAmount : null;
            current = side && amount
              ? {
                  rowNo: logicalRowNo++,
                  date,
                  description: descriptionPart,
                  side,
                  amount: Math.round(amount * 100) / 100,
                }
              : null;
            continue;
          }

          if (current) {
            current.description = appendText(current.description, descriptionPart);
          }
        }

        if (current && current.amount > 0 && current.description) {
          tableRows.push(current);
        }
      }

      if (tableRows.length) {
        out.push(...tableRows);
        page.cleanup();
        continue;
      }

      const rawLines = rows
        .map((row) => row.cells.map((cell) => cell.text).join("\t").trim())
        .filter(Boolean);

      const logicalLines: string[] = [];
      for (const line of rawLines) {
        if (isDateFirstLine(line) || !logicalLines.length) {
          logicalLines.push(line);
        } else {
          logicalLines[logicalLines.length - 1] = `${logicalLines[logicalLines.length - 1]} ${line}`.trim();
        }
      }

      const fallbackRows = logicalLines
        .map((line) => parsePdfStatementLine(line, logicalRowNo++))
        .filter(Boolean) as ParsedStatementRow[];

      out.push(...fallbackRows);
      page.cleanup();
    }

    await doc.destroy();

    if (!out.length) {
      throw new Error("PDF 没有解析到有效流水，请确认这是文本型银行单，而不是扫描图片。");
    }

    return out;
  } finally {
    await loadingTask.destroy();
  }
}

function detectImportFormat(file: Express.Multer.File): "excel" | "pdf" {
  const fileName = String(file.originalname || "").toLowerCase();
  const mimeType = String(file.mimetype || "").toLowerCase();
  if (fileName.endsWith(".pdf") || mimeType.includes("pdf")) return "pdf";
  return "excel";
}

async function loadStatementRows(file: Express.Multer.File): Promise<ParsedStatementRow[]> {
  return detectImportFormat(file) === "pdf" ? await loadPdfStatementRows(file) : await loadExcelStatementRows(file);
}

router.post("/import", requireAuth, upload.single("file"), async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ success: false, error: "Missing file" });
    return;
  }

  try {
    const rows = await loadStatementRows(file);
    res.status(200).json({
      success: true,
      data: {
        rows,
        fileName: file.originalname,
        fileType: detectImportFormat(file),
      },
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: String(e?.message || "Import failed") });
  }
});

router.post("/post", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    bankAccountId: z.string().uuid(),
    rows: z
      .array(
        z.object({
          date: z.string().min(10),
          description: z.string().optional(),
          side: z.enum(["debit", "credit"]),
          amount: z.number().positive(),
          accountId: z.string().uuid(),
          post: z.boolean().optional(),
        }),
      )
      .min(1),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const selectedRows = parsed.data.rows.filter((row) => row.post !== false);
  if (!selectedRows.length) {
    res.status(400).json({ success: false, error: "没有可过账的流水" });
    return;
  }

  const bankAccount = (
    await sql`
      SELECT id, account_id as "accountId"
      FROM bank_accounts
      WHERE org_id = ${orgId} AND id = ${parsed.data.bankAccountId}
      LIMIT 1
    `
  )[0] as any;
  if (!bankAccount?.accountId) {
    res.status(404).json({ success: false, error: "Bank account not found" });
    return;
  }

  const accountIds = Array.from(new Set(selectedRows.map((row) => row.accountId)));
  const accountRows = await sql`
    SELECT id
    FROM accounts
    WHERE org_id = ${orgId} AND id = ANY(${accountIds}::uuid[])
  `;
  const accountSet = new Set((accountRows as any[]).map((row) => String(row.id)));
  const invalid = selectedRows.find((row) => !accountSet.has(row.accountId));
  if (invalid) {
    res.status(400).json({ success: false, error: "存在无效科目，请重新选择。" });
    return;
  }

  if (selectedRows.some((row) => row.accountId === String(bankAccount.accountId))) {
    res.status(400).json({ success: false, error: "对方科目不能与银行科目相同。" });
    return;
  }

  const orgRow = (
    await sql`
      SELECT base_currency as "baseCurrency"
      FROM organizations
      WHERE id = ${orgId}
      LIMIT 1
    `
  )[0] as any;
  const currency = String(orgRow?.baseCurrency || "BASE").toUpperCase();

  const created = await sql.begin(async (trx) => {
    const result: Array<{ id: string; voucherNo: string }> = [];

    for (const row of selectedRows) {
      const amount = Math.round((Number(row.amount) || 0) * 100) / 100;
      if (!(amount > 0)) {
        throw new Error("金额必须大于 0");
      }

      const voucherNo = await issueVoucherNo(trx, orgId);
      const memo = `Bank reconciliation${row.description ? ` - ${String(row.description).trim()}` : ""}`;
      const entry = (
        await trx`
          INSERT INTO journal_entries (
            org_id, entry_date, status, posted_source, voucher_no, parent_entry_id, is_system,
            currency_code, fx_rate, memo, created_by, inventory_impact, posted_at
          )
          VALUES (
            ${orgId}, ${row.date}, 'posted', 'user', ${voucherNo}, NULL, false,
            ${currency}, 1, ${memo}, ${req.auth!.userId}, false, now()
          )
          RETURNING id, voucher_no as "voucherNo"
        `
      )[0] as any;

      const bankDebit = row.side === "credit" ? amount : 0;
      const bankCredit = row.side === "debit" ? amount : 0;
      const otherDebit = row.side === "debit" ? amount : 0;
      const otherCredit = row.side === "credit" ? amount : 0;
      const description = String(row.description || "").trim() || null;

      await trx`
        INSERT INTO journal_lines (
          org_id, entry_id, line_no, account_id, description, cost_center_id,
          debit_txn, credit_txn, debit_base, credit_base
        )
        VALUES (
          ${orgId}, ${entry.id}, 1, ${row.accountId}, ${description}, NULL,
          ${otherDebit}, ${otherCredit}, ${otherDebit}, ${otherCredit}
        )
      `;

      await trx`
        INSERT INTO journal_lines (
          org_id, entry_id, line_no, account_id, description, cost_center_id,
          debit_txn, credit_txn, debit_base, credit_base
        )
        VALUES (
          ${orgId}, ${entry.id}, 2, ${bankAccount.accountId}, ${description}, NULL,
          ${bankDebit}, ${bankCredit}, ${bankDebit}, ${bankCredit}
        )
      `;

      result.push({ id: String(entry.id), voucherNo: String(entry.voucherNo) });
    }

    return result;
  });

  res.status(200).json({
    success: true,
    data: {
      count: created.length,
      entries: created,
    },
  });
});

export default router;
