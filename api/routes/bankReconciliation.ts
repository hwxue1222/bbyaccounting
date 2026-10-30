import { Router, type Response } from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { requireOrgAccess } from "../lib/orgAccess.js";
import { issueVoucherNo } from "../lib/voucher.js";

const router = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

type StatementSide = "debit" | "credit";
type ColumnKey = "date" | "description" | "debit" | "credit" | "amount" | "side";

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

async function loadPdfStatementRows(file: Express.Multer.File): Promise<ParsedStatementRow[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: file.buffer });
  try {
    const result = await parser.getText();
    const rawLines = String(result.text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const logicalLines: string[] = [];
    for (const line of rawLines) {
      if (isDateFirstLine(line) || !logicalLines.length) {
        logicalLines.push(line);
      } else {
        logicalLines[logicalLines.length - 1] = `${logicalLines[logicalLines.length - 1]} ${line}`.trim();
      }
    }

    const rows = logicalLines
      .map((line, idx) => parsePdfStatementLine(line, idx + 1))
      .filter(Boolean) as ParsedStatementRow[];

    if (!rows.length) {
      throw new Error("PDF 没有解析到有效流水，请确认这是文本型银行单，而不是扫描图片。");
    }

    return rows;
  } finally {
    await parser.destroy();
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
