import { Router, type Response } from "express";
import puppeteer, { type Browser } from "puppeteer";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { requireOrgAccess } from "../lib/orgAccess.js";

const router = Router();

const lineItemSchema = z.object({
  particulars: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(500)),
  paymentMethod: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(200)),
  amount: z.number().nonnegative(),
});

const invoiceBodySchema = z.object({
  entryId: z.string().uuid().nullable().optional(),
  entryLineNo: z.number().int().positive().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  invoiceNo: z.preprocess(
    (v) => {
      if (v === null) return undefined;
      if (typeof v !== "string") return undefined;
      const s = v.trim().toUpperCase();
      return s || undefined;
    },
    z.string().max(64).optional(),
  ),
  issueDate: z.string().min(10),
  currency: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.string().min(3).max(3)),
  fxRate: z.number().positive().default(1),
  status: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(["draft", "issued"]).default("issued")),
  billToName: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(200)),
  memo: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(2000).nullable().optional(),
  ),
  paymentAccountName: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(200).nullable().optional(),
  ),
  paymentBankName: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(200).nullable().optional(),
  ),
  paymentBankAddress: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(1000).nullable().optional(),
  ),
  paymentAccountNumber: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(120).nullable().optional(),
  ),
  paymentSwiftCode: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim().toUpperCase();
      return s || null;
    },
    z.string().max(64).nullable().optional(),
  ),
  officialStamp: z.preprocess(
    (v) => {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const s = v.trim();
      return s || null;
    },
    z.string().max(200).nullable().optional(),
  ),
  lineItems: z.array(lineItemSchema).min(1),
});

function normalizeInvoiceNo(input: string): string {
  return input.trim().toUpperCase();
}

async function issueInvoiceNo(sql: any, orgId: string, issueDate: string): Promise<string> {
  const year = String(issueDate || new Date().toISOString().slice(0, 10)).slice(0, 4) || new Date().getFullYear().toString();
  const prefix = `I${year}`;
  const rows = (await sql`
    SELECT invoice_no as "invoiceNo"
    FROM invoices
    WHERE org_id = ${orgId} AND invoice_no LIKE ${prefix + "%"}
    ORDER BY created_at DESC
    LIMIT 5000
  `) as Array<{ invoiceNo: string | null }>;

  let maxSeq = 0;
  for (const row of rows) {
    const value = typeof row.invoiceNo === "string" ? row.invoiceNo.trim().toUpperCase() : "";
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(value);
    if (!match) continue;
    const next = Number(match[1]);
    if (Number.isFinite(next) && next > maxSeq) maxSeq = next;
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

function totalFromLineItems(items: Array<{ amount: number }>): number {
  return Math.round(items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0) * 100) / 100;
}

function formatAmount(input: unknown): string {
  return (Math.round((Number(input) || 0) * 100) / 100).toFixed(2);
}

function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInvoicePdfHtml(invoice: any): string {
  const currency = String(invoice.currency || "SGD").toUpperCase();
  const currencyLabel = currency === "SGD" ? "SGD 新币" : currency;
  const lineItems = Array.isArray(invoice.lineItems) ? invoice.lineItems.slice(0, 12) : [];
  const minRows = Math.max(3, lineItems.length);
  while (lineItems.length < minRows) {
    lineItems.push({ particulars: "", paymentMethod: "", amount: 0 });
  }
  const rowsHtml = lineItems
    .map((item: any, idx: number) => {
      const particulars = item?.particulars ? escapeHtml(item.particulars) : "&nbsp;";
      const paymentMethod = item?.paymentMethod ? escapeHtml(item.paymentMethod) : "&nbsp;";
      const amount = Number(item?.amount) > 0 ? formatAmount(item.amount) : "&nbsp;";
      return `
        <tr>
          <td class="sn">${idx + 1}.</td>
          <td class="particulars">${particulars}</td>
          <td class="payment">${paymentMethod}</td>
          <td class="amount">${amount}</td>
        </tr>
      `;
    })
    .join("");

  const memoHtml = invoice.memo
    ? `
      <div class="memo-title">备注 Memo</div>
      <div class="memo-body">${escapeHtml(invoice.memo)}</div>
    `
    : "";

  const stampHtml = invoice.officialStamp ? `<div class="stamp-text">${escapeHtml(invoice.officialStamp)}</div>` : "";

  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(invoice.invoiceNo || "invoice")}</title>
      <style>
        @page { size: A4; margin: 12mm; }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          color: #111827;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
          background: #ffffff;
        }
        .sheet {
          width: 186mm;
          min-height: 273mm;
          margin: 0 auto;
        }
        .top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }
        .bill-to {
          max-width: 62%;
          font-size: 14px;
          line-height: 1.9;
          font-weight: 600;
          padding-top: 10px;
        }
        .title {
          text-align: right;
        }
        .title .main {
          font-size: 34px;
          letter-spacing: 0.18em;
          font-weight: 600;
        }
        .title .sub {
          margin-top: -6px;
          font-size: 20px;
          letter-spacing: 0.2em;
          font-weight: 500;
        }
        .meta {
          margin-top: 22px;
          font-size: 14px;
          line-height: 1.9;
        }
        .invoice-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 30px;
          font-size: 13px;
        }
        .invoice-table th,
        .invoice-table td {
          border: 1px solid #111827;
          padding: 8px 10px;
          vertical-align: top;
        }
        .invoice-table th {
          font-weight: 600;
          background: #ffffff;
        }
        .sn {
          width: 56px;
          text-align: center;
          height: 48px;
        }
        .particulars {
          width: 41%;
        }
        .payment {
          width: 31%;
        }
        .amount {
          width: 18%;
          text-align: right;
        }
        .payment-box {
          line-height: 1.7;
        }
        .payment-title {
          font-weight: 600;
          margin-bottom: 8px;
        }
        .total-box {
          min-height: 152px;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          align-items: flex-end;
        }
        .total-label {
          font-size: 13px;
          font-weight: 600;
        }
        .total-value {
          margin-top: 42px;
          font-size: 20px;
          font-weight: 700;
        }
        .footer {
          margin-top: 38px;
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
        }
        .memo {
          max-width: 60%;
          font-size: 13px;
          line-height: 1.7;
          color: #3f3f46;
          min-height: 60px;
        }
        .memo-title {
          font-weight: 600;
          color: #111827;
          margin-bottom: 4px;
        }
        .stamp-wrap {
          width: 220px;
        }
        .stamp-label {
          text-align: right;
          font-size: 13px;
        }
        .stamp-box {
          margin-top: 12px;
          height: 82px;
          border: 1px dashed #9ca3af;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 0 16px;
          font-size: 13px;
        }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="top">
          <div class="bill-to">Bill to 付款单位: ${escapeHtml(invoice.billToName || "-")}</div>
          <div class="title">
            <div class="main">INVOICE</div>
            <div class="sub">发票</div>
            <div class="meta">
              <div><strong>Invoice No.发票编号:</strong> ${escapeHtml(invoice.invoiceNo || "")}</div>
              <div><strong>Date 日期:</strong> ${escapeHtml(invoice.issueDate || "")}</div>
            </div>
          </div>
        </div>

        <table class="invoice-table">
          <thead>
            <tr>
              <th>S/N<br/>序号</th>
              <th>Particulars 收款事项</th>
              <th>Payment mode 付款方式<br/>Cash / Cheque / Fund Transfer</th>
              <th>Amount 金额 (${escapeHtml(currencyLabel)})</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr>
              <td colspan="3">
                <div class="payment-box">
                  <div class="payment-title">Payment method 付款信息如下:</div>
                  <div>Account name 收款人：${escapeHtml(invoice.paymentAccountName || "-")}</div>
                  <div>Bank name 银行名: ${escapeHtml(invoice.paymentBankName || "-")}</div>
                  <div>Bank address 银行地址: ${escapeHtml(invoice.paymentBankAddress || "-")}</div>
                  <div>Account number 银行账户: ${escapeHtml(invoice.paymentAccountNumber || "-")}</div>
                  <div>Swift code 国际汇款号: ${escapeHtml(invoice.paymentSwiftCode || "-")}</div>
                </div>
              </td>
              <td>
                <div class="total-box">
                  <div class="total-label">TOTAL 合计 (${escapeHtml(currencyLabel)})</div>
                  <div class="total-value">${formatAmount(invoice.totalTxn)}</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          <div class="memo">${memoHtml}</div>
          <div class="stamp-wrap">
            <div class="stamp-label">Official Stamp 公章:</div>
            <div class="stamp-box">${stampHtml}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const sql = getSql();
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      customerId: z.string().uuid().optional(),
    })
    .safeParse({ limit: req.query.limit, customerId: req.query.customerId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Invalid query" });
    return;
  }

  const limit = q.data.limit ?? 200;
  const customerId = q.data.customerId ?? null;
  const rows = await sql`
    SELECT
      i.id,
      i.entry_id as "entryId",
      i.entry_line_no as "entryLineNo",
      i.customer_id as "customerId",
      i.invoice_no as "invoiceNo",
      to_char(i.issue_date, 'YYYY-MM-DD') as "issueDate",
      i.currency_code as "currency",
      i.fx_rate as "fxRate",
      i.status,
      i.bill_to_name as "billToName",
      i.memo,
      i.payment_account_name as "paymentAccountName",
      i.payment_bank_name as "paymentBankName",
      i.payment_bank_address as "paymentBankAddress",
      i.payment_account_number as "paymentAccountNumber",
      i.payment_swift_code as "paymentSwiftCode",
      i.official_stamp as "officialStamp",
      i.total_txn as "totalTxn",
      i.line_items as "lineItems",
      i.created_at as "createdAt",
      i.updated_at as "updatedAt",
      c.name as "customerName",
      c.code as "customerCode"
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
    WHERE i.org_id = ${orgId}
      AND (${customerId}::uuid IS NULL OR i.customer_id = ${customerId}::uuid)
    ORDER BY i.issue_date DESC, i.created_at DESC
    LIMIT ${limit}
  `;
  res.status(200).json({ success: true, data: { invoices: rows } });
});

router.get("/next-no", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const q = z.object({ issueDate: z.string().min(10).optional() }).safeParse({ issueDate: req.query.issueDate });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Invalid query" });
    return;
  }
  const sql = getSql();
  const issueDate = q.data.issueDate || new Date().toISOString().slice(0, 10);
  const invoiceNo = await issueInvoiceNo(sql, orgId, issueDate);
  res.status(200).json({ success: true, data: { invoiceNo } });
});

router.get("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const sql = getSql();
  const id = req.params.id;
  const rows = await sql`
    SELECT
      i.id,
      i.entry_id as "entryId",
      i.entry_line_no as "entryLineNo",
      i.customer_id as "customerId",
      i.invoice_no as "invoiceNo",
      to_char(i.issue_date, 'YYYY-MM-DD') as "issueDate",
      i.currency_code as "currency",
      i.fx_rate as "fxRate",
      i.status,
      i.bill_to_name as "billToName",
      i.memo,
      i.payment_account_name as "paymentAccountName",
      i.payment_bank_name as "paymentBankName",
      i.payment_bank_address as "paymentBankAddress",
      i.payment_account_number as "paymentAccountNumber",
      i.payment_swift_code as "paymentSwiftCode",
      i.official_stamp as "officialStamp",
      i.total_txn as "totalTxn",
      i.line_items as "lineItems",
      i.created_at as "createdAt",
      i.updated_at as "updatedAt",
      c.name as "customerName",
      c.code as "customerCode"
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
    WHERE i.org_id = ${orgId} AND i.id = ${id}
    LIMIT 1
  `;
  const invoice = rows[0] as any;
  if (!invoice) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  res.status(200).json({ success: true, data: { invoice } });
});

router.get("/:id/pdf", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const sql = getSql();
  const id = req.params.id;
  const rows = await sql`
    SELECT
      i.id,
      i.invoice_no as "invoiceNo",
      to_char(i.issue_date, 'YYYY-MM-DD') as "issueDate",
      i.currency_code as "currency",
      i.fx_rate as "fxRate",
      i.status,
      i.bill_to_name as "billToName",
      i.memo,
      i.payment_account_name as "paymentAccountName",
      i.payment_bank_name as "paymentBankName",
      i.payment_bank_address as "paymentBankAddress",
      i.payment_account_number as "paymentAccountNumber",
      i.payment_swift_code as "paymentSwiftCode",
      i.official_stamp as "officialStamp",
      i.total_txn as "totalTxn",
      i.line_items as "lineItems"
    FROM invoices i
    WHERE i.org_id = ${orgId} AND i.id = ${id}
    LIMIT 1
  `;
  const invoice = rows[0] as any;
  if (!invoice) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  const html = renderInvoicePdfHtml(invoice);
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=medium"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    const safeName = String(invoice.invoiceNo || "invoice").replace(/[^\w.-]+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    res.status(200).send(Buffer.from(pdf));
  } catch (e: any) {
    res.status(500).json({ success: false, error: typeof e?.message === "string" ? e.message : "PDF generation failed" });
  } finally {
    if (browser) {
      await browser.close().catch(() => void 0);
    }
  }
});

router.post("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const parsed = invoiceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const userId = req.auth!.userId;
  const payload = parsed.data;
  const invoiceNo = payload.invoiceNo ? normalizeInvoiceNo(payload.invoiceNo) : await issueInvoiceNo(sql, orgId, payload.issueDate);
  const totalTxn = totalFromLineItems(payload.lineItems);

  const row = (
    await sql`
      INSERT INTO invoices (
        org_id, entry_id, entry_line_no, customer_id, invoice_no, issue_date, currency_code, fx_rate, status,
        bill_to_name, memo, payment_account_name, payment_bank_name, payment_bank_address,
        payment_account_number, payment_swift_code, official_stamp, total_txn, line_items, created_by, updated_at
      ) VALUES (
        ${orgId}, ${payload.entryId ?? null}, ${payload.entryLineNo ?? null}, ${payload.customerId ?? null}, ${invoiceNo},
        ${payload.issueDate}, ${payload.currency}, ${payload.fxRate}, ${payload.status}, ${payload.billToName},
        ${payload.memo ?? null}, ${payload.paymentAccountName ?? null}, ${payload.paymentBankName ?? null},
        ${payload.paymentBankAddress ?? null}, ${payload.paymentAccountNumber ?? null}, ${payload.paymentSwiftCode ?? null},
        ${payload.officialStamp ?? null}, ${totalTxn}, ${JSON.stringify(payload.lineItems)}::jsonb, ${userId}, now()
      )
      RETURNING
        id,
        entry_id as "entryId",
        entry_line_no as "entryLineNo",
        customer_id as "customerId",
        invoice_no as "invoiceNo",
        to_char(issue_date, 'YYYY-MM-DD') as "issueDate",
        currency_code as "currency",
        fx_rate as "fxRate",
        status,
        bill_to_name as "billToName",
        memo,
        payment_account_name as "paymentAccountName",
        payment_bank_name as "paymentBankName",
        payment_bank_address as "paymentBankAddress",
        payment_account_number as "paymentAccountNumber",
        payment_swift_code as "paymentSwiftCode",
        official_stamp as "officialStamp",
        total_txn as "totalTxn",
        line_items as "lineItems",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `
  )[0] as any;

  res.status(200).json({ success: true, data: { invoice: row } });
});

router.patch("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;
  const parsed = invoiceBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const id = req.params.id;
  const payload = parsed.data;
  const totalTxn = totalFromLineItems(payload.lineItems);
  const invoiceNo = payload.invoiceNo ? normalizeInvoiceNo(payload.invoiceNo) : await issueInvoiceNo(sql, orgId, payload.issueDate);

  const existing = await sql`SELECT id FROM invoices WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`;
  if (!existing.length) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  const row = (
    await sql`
      UPDATE invoices
      SET
        entry_id = ${payload.entryId ?? null},
        entry_line_no = ${payload.entryLineNo ?? null},
        customer_id = ${payload.customerId ?? null},
        invoice_no = ${invoiceNo},
        issue_date = ${payload.issueDate},
        currency_code = ${payload.currency},
        fx_rate = ${payload.fxRate},
        status = ${payload.status},
        bill_to_name = ${payload.billToName},
        memo = ${payload.memo ?? null},
        payment_account_name = ${payload.paymentAccountName ?? null},
        payment_bank_name = ${payload.paymentBankName ?? null},
        payment_bank_address = ${payload.paymentBankAddress ?? null},
        payment_account_number = ${payload.paymentAccountNumber ?? null},
        payment_swift_code = ${payload.paymentSwiftCode ?? null},
        official_stamp = ${payload.officialStamp ?? null},
        total_txn = ${totalTxn},
        line_items = ${JSON.stringify(payload.lineItems)}::jsonb,
        updated_at = now()
      WHERE org_id = ${orgId} AND id = ${id}
      RETURNING
        id,
        entry_id as "entryId",
        entry_line_no as "entryLineNo",
        customer_id as "customerId",
        invoice_no as "invoiceNo",
        to_char(issue_date, 'YYYY-MM-DD') as "issueDate",
        currency_code as "currency",
        fx_rate as "fxRate",
        status,
        bill_to_name as "billToName",
        memo,
        payment_account_name as "paymentAccountName",
        payment_bank_name as "paymentBankName",
        payment_bank_address as "paymentBankAddress",
        payment_account_number as "paymentAccountNumber",
        payment_swift_code as "paymentSwiftCode",
        official_stamp as "officialStamp",
        total_txn as "totalTxn",
        line_items as "lineItems",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `
  )[0] as any;

  res.status(200).json({ success: true, data: { invoice: row } });
});

export default router;
