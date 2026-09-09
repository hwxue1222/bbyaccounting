import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";

const router = Router();

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

router.get("/trial-balance", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z
    .object({
      start: z.string().min(10),
      end: z.string().min(10),
      costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional(),
    })
    .safeParse({ start: req.query.start, end: req.query.end, costCenterId: req.query.costCenterId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }
  const sql = getSql();

  const costCenterId = q.data.costCenterId;
  const rows =
    costCenterId === undefined
      ? await sql`
          WITH opening AS (
            SELECT
              l.account_id,
              COALESCE(SUM(l.debit_base - l.credit_base), 0) as balance
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date < ${q.data.start}
            GROUP BY l.account_id
          ),
          period AS (
            SELECT
              l.account_id,
              COALESCE(SUM(l.debit_base), 0) as debit,
              COALESCE(SUM(l.credit_base), 0) as credit
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date >= ${q.data.start}
              AND e.entry_date <= ${q.data.end}
            GROUP BY l.account_id
          )
          SELECT
            a.id as "accountId",
            a.code,
            a.name,
            a.type,
            GREATEST(COALESCE(o.balance, 0), 0) as "openingDebit",
            GREATEST(-COALESCE(o.balance, 0), 0) as "openingCredit",
            COALESCE(p.debit, 0) as "periodDebit",
            COALESCE(p.credit, 0) as "periodCredit",
            GREATEST(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0), 0) as "closingDebit",
            GREATEST(-(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0)), 0) as "closingCredit"
          FROM accounts a
          LEFT JOIN opening o ON o.account_id = a.id
          LEFT JOIN period p ON p.account_id = a.id
          WHERE a.org_id = ${orgId}
            AND a.is_active = true
          ORDER BY a.code ASC
        `
      : costCenterId === "__none__"
        ? await sql`
            WITH opening AS (
              SELECT
                l.account_id,
                COALESCE(SUM(l.debit_base - l.credit_base), 0) as balance
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${orgId}
                AND e.status = 'posted'
                AND e.entry_date < ${q.data.start}
                AND l.cost_center_id IS NULL
              GROUP BY l.account_id
            ),
            period AS (
              SELECT
                l.account_id,
                COALESCE(SUM(l.debit_base), 0) as debit,
                COALESCE(SUM(l.credit_base), 0) as credit
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${orgId}
                AND e.status = 'posted'
                AND e.entry_date >= ${q.data.start}
                AND e.entry_date <= ${q.data.end}
                AND l.cost_center_id IS NULL
              GROUP BY l.account_id
            )
            SELECT
              a.id as "accountId",
              a.code,
              a.name,
              a.type,
              GREATEST(COALESCE(o.balance, 0), 0) as "openingDebit",
              GREATEST(-COALESCE(o.balance, 0), 0) as "openingCredit",
              COALESCE(p.debit, 0) as "periodDebit",
              COALESCE(p.credit, 0) as "periodCredit",
              GREATEST(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0), 0) as "closingDebit",
              GREATEST(-(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0)), 0) as "closingCredit"
            FROM accounts a
            LEFT JOIN opening o ON o.account_id = a.id
            LEFT JOIN period p ON p.account_id = a.id
            WHERE a.org_id = ${orgId}
              AND a.is_active = true
            ORDER BY a.code ASC
          `
        : await sql`
            WITH opening AS (
              SELECT
                l.account_id,
                COALESCE(SUM(l.debit_base - l.credit_base), 0) as balance
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${orgId}
                AND e.status = 'posted'
                AND e.entry_date < ${q.data.start}
                AND l.cost_center_id = ${costCenterId}
              GROUP BY l.account_id
            ),
            period AS (
              SELECT
                l.account_id,
                COALESCE(SUM(l.debit_base), 0) as debit,
                COALESCE(SUM(l.credit_base), 0) as credit
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${orgId}
                AND e.status = 'posted'
                AND e.entry_date >= ${q.data.start}
                AND e.entry_date <= ${q.data.end}
                AND l.cost_center_id = ${costCenterId}
              GROUP BY l.account_id
            )
            SELECT
              a.id as "accountId",
              a.code,
              a.name,
              a.type,
              GREATEST(COALESCE(o.balance, 0), 0) as "openingDebit",
              GREATEST(-COALESCE(o.balance, 0), 0) as "openingCredit",
              COALESCE(p.debit, 0) as "periodDebit",
              COALESCE(p.credit, 0) as "periodCredit",
              GREATEST(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0), 0) as "closingDebit",
              GREATEST(-(COALESCE(o.balance, 0) + COALESCE(p.debit, 0) - COALESCE(p.credit, 0)), 0) as "closingCredit"
            FROM accounts a
            LEFT JOIN opening o ON o.account_id = a.id
            LEFT JOIN period p ON p.account_id = a.id
            WHERE a.org_id = ${orgId}
              AND a.is_active = true
            ORDER BY a.code ASC
          `;

  res.status(200).json({ success: true, data: { rows } });
});

router.get("/profit-loss", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z
    .object({
      start: z.string().min(10),
      end: z.string().min(10),
      costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional(),
    })
    .safeParse({ start: req.query.start, end: req.query.end, costCenterId: req.query.costCenterId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }
  const sql = getSql();
  const costCenterId = q.data.costCenterId;

  const baseRows =
    costCenterId === undefined
      ? await sql`
          SELECT
            a.type,
            a.code,
            a.name,
            COALESCE(SUM(l.debit_base), 0) as debit,
            COALESCE(SUM(l.credit_base), 0) as credit
          FROM accounts a
          JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
          JOIN journal_entries e ON e.id = l.entry_id
          WHERE a.org_id = ${orgId}
            AND e.status = 'posted'
            AND e.entry_date >= ${q.data.start}
            AND e.entry_date <= ${q.data.end}
            AND a.type IN ('income', 'cogs', 'expense')
          GROUP BY a.type, a.code, a.name
          ORDER BY a.type ASC, a.code ASC
        `
      : costCenterId === "__none__"
        ? await sql`
            SELECT
              a.type,
              a.code,
              a.name,
              COALESCE(SUM(l.debit_base), 0) as debit,
              COALESCE(SUM(l.credit_base), 0) as credit
            FROM accounts a
            JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE a.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date >= ${q.data.start}
              AND e.entry_date <= ${q.data.end}
              AND a.type IN ('income', 'cogs', 'expense')
              AND l.cost_center_id IS NULL
            GROUP BY a.type, a.code, a.name
            ORDER BY a.type ASC, a.code ASC
          `
        : await sql`
            SELECT
              a.type,
              a.code,
              a.name,
              COALESCE(SUM(l.debit_base), 0) as debit,
              COALESCE(SUM(l.credit_base), 0) as credit
            FROM accounts a
            JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE a.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date >= ${q.data.start}
              AND e.entry_date <= ${q.data.end}
              AND a.type IN ('income', 'cogs', 'expense')
              AND l.cost_center_id = ${costCenterId}
            GROUP BY a.type, a.code, a.name
            ORDER BY a.type ASC, a.code ASC
          `;

  const typed = (baseRows as any[]).map((r) => {
    const debit = Number(r.debit || 0);
    const credit = Number(r.credit || 0);
    const type = String(r.type);
    const amount = type === "income" ? credit - debit : debit - credit;
    return { ...r, amount };
  });

  const revenue = typed.filter((r) => r.type === "income");
  const cogs = typed.filter((r) => r.type === "cogs");
  const expenses = typed.filter((r) => r.type === "expense");

  const sum = (xs: any[]) => xs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totalRevenue = sum(revenue);
  const totalCogs = sum(cogs);
  const grossProfit = totalRevenue - totalCogs;
  const totalExpenses = sum(expenses);
  const netProfit = grossProfit - totalExpenses;

  const rows = [
    ...revenue.map((r) => ({ section: "Revenue", code: r.code, name: r.name, amount: r.amount })),
    { section: "Revenue", code: "", name: "Total Revenue", amount: totalRevenue, isTotal: true },
    ...cogs.map((r) => ({ section: "Cost of Sales", code: r.code, name: r.name, amount: r.amount })),
    { section: "Cost of Sales", code: "", name: "Total Cost of Sales", amount: totalCogs, isTotal: true },
    { section: "Summary", code: "", name: "Gross Profit", amount: grossProfit, isTotal: true },
    ...expenses.map((r) => ({ section: "Expenses", code: r.code, name: r.name, amount: r.amount })),
    { section: "Expenses", code: "", name: "Total Expenses", amount: totalExpenses, isTotal: true },
    { section: "Summary", code: "", name: "Net Profit", amount: netProfit, isTotal: true },
  ];

  res.status(200).json({ success: true, data: { rows } });
});

router.get("/balance-sheet", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z
    .object({
      asOf: z.string().min(10),
      costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional(),
    })
    .safeParse({ asOf: req.query.asOf, costCenterId: req.query.costCenterId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing asOf" });
    return;
  }
  const sql = getSql();
  const costCenterId = q.data.costCenterId;

  const baseRows =
    costCenterId === undefined
      ? await sql`
          SELECT
            a.type,
            a.code,
            a.name,
            COALESCE(SUM(l.debit_base), 0) as debit,
            COALESCE(SUM(l.credit_base), 0) as credit
          FROM accounts a
          JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
          JOIN journal_entries e ON e.id = l.entry_id
          WHERE a.org_id = ${orgId}
            AND e.status = 'posted'
            AND e.entry_date <= ${q.data.asOf}
            AND a.type IN ('asset', 'liability', 'equity')
          GROUP BY a.type, a.code, a.name
          ORDER BY a.type ASC, a.code ASC
        `
      : costCenterId === "__none__"
        ? await sql`
            SELECT
              a.type,
              a.code,
              a.name,
              COALESCE(SUM(l.debit_base), 0) as debit,
              COALESCE(SUM(l.credit_base), 0) as credit
            FROM accounts a
            JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE a.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date <= ${q.data.asOf}
              AND a.type IN ('asset', 'liability', 'equity')
              AND l.cost_center_id IS NULL
            GROUP BY a.type, a.code, a.name
            ORDER BY a.type ASC, a.code ASC
          `
        : await sql`
            SELECT
              a.type,
              a.code,
              a.name,
              COALESCE(SUM(l.debit_base), 0) as debit,
              COALESCE(SUM(l.credit_base), 0) as credit
            FROM accounts a
            JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE a.org_id = ${orgId}
              AND e.status = 'posted'
              AND e.entry_date <= ${q.data.asOf}
              AND a.type IN ('asset', 'liability', 'equity')
              AND l.cost_center_id = ${costCenterId}
            GROUP BY a.type, a.code, a.name
            ORDER BY a.type ASC, a.code ASC
          `;

  const rows = (baseRows as any[]).map((r) => {
    const debit = Number(r.debit || 0);
    const credit = Number(r.credit || 0);
    const balance = debit - credit;
    return {
      section: r.type === "asset" ? "Assets" : r.type === "liability" ? "Liabilities" : "Equity",
      code: r.code,
      name: r.name,
      debit: Math.max(balance, 0),
      credit: Math.max(-balance, 0),
    };
  });

  const sum = (xs: any[], key: "debit" | "credit") => xs.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const assets = rows.filter((r) => r.section === "Assets");
  const liabilities = rows.filter((r) => r.section === "Liabilities");
  const equity = rows.filter((r) => r.section === "Equity");
  const totalAssets = sum(assets, "debit") - sum(assets, "credit");
  const totalLiab = sum(liabilities, "credit") - sum(liabilities, "debit");
  const totalEq = sum(equity, "credit") - sum(equity, "debit");

  const out = [
    ...assets,
    { section: "Assets", code: "", name: "Total Assets", debit: Math.max(totalAssets, 0), credit: Math.max(-totalAssets, 0), isTotal: true },
    ...liabilities,
    { section: "Liabilities", code: "", name: "Total Liabilities", debit: Math.max(-totalLiab, 0), credit: Math.max(totalLiab, 0), isTotal: true },
    ...equity,
    { section: "Equity", code: "", name: "Total Equity", debit: Math.max(-totalEq, 0), credit: Math.max(totalEq, 0), isTotal: true },
    {
      section: "Summary",
      code: "",
      name: "Assets - (Liabilities + Equity)",
      debit: 0,
      credit: 0,
      variance: totalAssets - (totalLiab + totalEq),
      isTotal: true,
    },
  ];

  res.status(200).json({ success: true, data: { rows: out } });
});

router.get("/gl", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z
    .object({
      start: z.string().min(10),
      end: z.string().min(10),
      accountId: z.string().uuid().optional(),
      costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional(),
    })
    .safeParse({
      accountId: req.query.accountId,
      start: req.query.start,
      end: req.query.end,
      costCenterId: req.query.costCenterId,
    });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }
  const sql = getSql();
  const costCenterId = q.data.costCenterId;

  const accountId = q.data.accountId;
  const baseWhere = {
    orgId,
    start: q.data.start,
    end: q.data.end,
  };

  const lines =
    accountId === undefined
      ? costCenterId === undefined
        ? await sql`
            SELECT
              e.entry_date as "entryDate",
              e.id as "entryId",
              e.memo,
              a.code as "accountCode",
              a.name as "accountName",
              l.description,
              l.debit_base as "debitBase",
              l.credit_base as "creditBase"
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            JOIN accounts a ON a.id = l.account_id
            WHERE l.org_id = ${baseWhere.orgId}
              AND e.status = 'posted'
              AND e.entry_date >= ${baseWhere.start}
              AND e.entry_date <= ${baseWhere.end}
            ORDER BY a.code ASC, e.entry_date ASC, e.created_at ASC, l.line_no ASC
          `
        : costCenterId === "__none__"
          ? await sql`
              SELECT
                e.entry_date as "entryDate",
                e.id as "entryId",
                e.memo,
                a.code as "accountCode",
                a.name as "accountName",
                l.description,
                l.debit_base as "debitBase",
                l.credit_base as "creditBase"
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              JOIN accounts a ON a.id = l.account_id
              WHERE l.org_id = ${baseWhere.orgId}
                AND e.status = 'posted'
                AND e.entry_date >= ${baseWhere.start}
                AND e.entry_date <= ${baseWhere.end}
                AND l.cost_center_id IS NULL
              ORDER BY a.code ASC, e.entry_date ASC, e.created_at ASC, l.line_no ASC
            `
          : await sql`
              SELECT
                e.entry_date as "entryDate",
                e.id as "entryId",
                e.memo,
                a.code as "accountCode",
                a.name as "accountName",
                l.description,
                l.debit_base as "debitBase",
                l.credit_base as "creditBase"
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              JOIN accounts a ON a.id = l.account_id
              WHERE l.org_id = ${baseWhere.orgId}
                AND e.status = 'posted'
                AND e.entry_date >= ${baseWhere.start}
                AND e.entry_date <= ${baseWhere.end}
                AND l.cost_center_id = ${costCenterId}
              ORDER BY a.code ASC, e.entry_date ASC, e.created_at ASC, l.line_no ASC
            `
      : costCenterId === undefined
        ? await sql`
            SELECT
              e.entry_date as "entryDate",
              e.id as "entryId",
              e.memo,
              l.description,
              l.debit_base as "debitBase",
              l.credit_base as "creditBase"
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.org_id = ${baseWhere.orgId}
              AND l.account_id = ${accountId}
              AND e.status = 'posted'
              AND e.entry_date >= ${baseWhere.start}
              AND e.entry_date <= ${baseWhere.end}
            ORDER BY e.entry_date ASC, e.created_at ASC, l.line_no ASC
          `
        : costCenterId === "__none__"
          ? await sql`
              SELECT
                e.entry_date as "entryDate",
                e.id as "entryId",
                e.memo,
                l.description,
                l.debit_base as "debitBase",
                l.credit_base as "creditBase"
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${baseWhere.orgId}
                AND l.account_id = ${accountId}
                AND e.status = 'posted'
                AND e.entry_date >= ${baseWhere.start}
                AND e.entry_date <= ${baseWhere.end}
                AND l.cost_center_id IS NULL
              ORDER BY e.entry_date ASC, e.created_at ASC, l.line_no ASC
            `
          : await sql`
              SELECT
                e.entry_date as "entryDate",
                e.id as "entryId",
                e.memo,
                l.description,
                l.debit_base as "debitBase",
                l.credit_base as "creditBase"
              FROM journal_lines l
              JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.org_id = ${baseWhere.orgId}
                AND l.account_id = ${accountId}
                AND e.status = 'posted'
                AND e.entry_date >= ${baseWhere.start}
                AND e.entry_date <= ${baseWhere.end}
                AND l.cost_center_id = ${costCenterId}
              ORDER BY e.entry_date ASC, e.created_at ASC, l.line_no ASC
            `;

  res.status(200).json({ success: true, data: { lines } });
});

export default router;
