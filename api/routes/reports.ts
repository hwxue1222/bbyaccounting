import { Router, type Response } from "express";
import ExcelJS from "exceljs";
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

function fmtDateLong(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function monthLabel(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    d.getUTCMonth()
  ];
  const year = d.getUTCFullYear();
  return `${month} ${year}`;
}

async function getOrgName(sql: ReturnType<typeof getSql>, orgId: string): Promise<string> {
  const rows = await sql`SELECT name FROM organizations WHERE id = ${orgId} LIMIT 1`;
  return rows.length ? String((rows[0] as any).name) : "";
}

async function fetchAccountBalancesAsOf(sql: ReturnType<typeof getSql>, orgId: string, asOf: string, costCenterId?: string) {
  const ccJoin =
    costCenterId === undefined
      ? sql``
      : costCenterId === "__none__"
        ? sql`AND l.cost_center_id IS NULL`
        : sql`AND l.cost_center_id = ${costCenterId}`;

  return sql`
    SELECT
      a.id,
      a.code,
      a.name,
      a.type,
      a.normal_balance as "normalBalance",
      COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN (l.debit_base - l.credit_base) ELSE 0 END), 0) as balance
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id ${ccJoin}
    LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = a.org_id AND e.status = 'posted' AND e.entry_date <= ${asOf}
    WHERE a.org_id = ${orgId}
      AND a.is_active = true
    GROUP BY a.id, a.code, a.name, a.type, a.normal_balance
    ORDER BY a.code ASC
  `;
}

async function computeNetProfit(sql: ReturnType<typeof getSql>, orgId: string, start: string, end: string, costCenterId?: string): Promise<number> {
  const base = sql`
    SELECT
      a.type,
      COALESCE(SUM(l.debit_base), 0) as debit,
      COALESCE(SUM(l.credit_base), 0) as credit
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.org_id = ${orgId}
      AND e.status = 'posted'
      AND e.entry_date >= ${start}
      AND e.entry_date <= ${end}
      AND a.type IN ('income', 'cogs', 'expense')
  `;

  const q =
    costCenterId === undefined
      ? sql`${base} GROUP BY a.type`
      : costCenterId === "__none__"
        ? sql`${base} AND l.cost_center_id IS NULL GROUP BY a.type`
        : sql`${base} AND l.cost_center_id = ${costCenterId} GROUP BY a.type`;

  const rows = (await q) as any[];
  let income = 0;
  let cogs = 0;
  let expense = 0;
  for (const r of rows) {
    const t = String(r.type);
    const debit = Number(r.debit || 0);
    const credit = Number(r.credit || 0);
    if (t === "income") income += credit - debit;
    if (t === "cogs") cogs += debit - credit;
    if (t === "expense") expense += debit - credit;
  }
  return income - cogs - expense;
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

router.get("/fixed-assets-schedule", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const q = z
    .object({
      start: z.string().min(10),
      end: z.string().min(10),
    })
    .safeParse({ start: req.query.start, end: req.query.end });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }

  const sql = getSql();

  const unassignedRows = await sql`
    SELECT COALESCE(SUM(l.debit_base - l.credit_base), 0) as amount
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE l.org_id = ${orgId}
      AND e.org_id = ${orgId}
      AND a.org_id = ${orgId}
      AND e.status = 'posted'
      AND e.entry_date >= ${q.data.start}
      AND e.entry_date <= ${q.data.end}
      AND a.code LIKE '61%'
      AND l.fixed_asset_id IS NULL
  `;
  const unassignedDepExpense = Math.round((Number((unassignedRows[0] as any)?.amount || 0) || 0) * 100) / 100;

  const rows = await sql`
    WITH assets AS (
      SELECT
        id,
        asset_no,
        category,
        name,
        acquisition_date,
        status,
        disposed_at,
        asset_account_id,
        accum_dep_account_id,
        dep_expense_account_id
      FROM fixed_assets
      WHERE org_id = ${orgId}
        AND status <> 'draft'
        AND acquisition_date <= ${q.data.end}
        AND (disposed_at IS NULL OR disposed_at >= ${q.data.start})
    ),
    cost_open AS (
      SELECT
        l.fixed_asset_id as asset_id,
        COALESCE(SUM(l.debit_base - l.credit_base), 0) as amount
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN assets a ON a.id = l.fixed_asset_id
      WHERE l.org_id = ${orgId}
        AND e.status = 'posted'
        AND e.entry_date < ${q.data.start}
        AND l.account_id = a.asset_account_id
      GROUP BY l.fixed_asset_id
    ),
    cost_period AS (
      SELECT
        l.fixed_asset_id as asset_id,
        COALESCE(SUM(l.debit_base), 0) as debit,
        COALESCE(SUM(l.credit_base), 0) as credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN assets a ON a.id = l.fixed_asset_id
      WHERE l.org_id = ${orgId}
        AND e.status = 'posted'
        AND e.entry_date >= ${q.data.start}
        AND e.entry_date <= ${q.data.end}
        AND l.account_id = a.asset_account_id
      GROUP BY l.fixed_asset_id
    ),
    ad_open AS (
      SELECT
        l.fixed_asset_id as asset_id,
        COALESCE(SUM(l.credit_base - l.debit_base), 0) as amount
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN assets a ON a.id = l.fixed_asset_id
      WHERE l.org_id = ${orgId}
        AND e.status = 'posted'
        AND e.entry_date < ${q.data.start}
        AND l.account_id = a.accum_dep_account_id
      GROUP BY l.fixed_asset_id
    ),
    ad_disposal_period AS (
      SELECT
        l.fixed_asset_id as asset_id,
        COALESCE(SUM(l.debit_base), 0) as amount
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN assets a ON a.id = l.fixed_asset_id
      WHERE l.org_id = ${orgId}
        AND e.status = 'posted'
        AND e.entry_date >= ${q.data.start}
        AND e.entry_date <= ${q.data.end}
        AND l.account_id = a.accum_dep_account_id
      GROUP BY l.fixed_asset_id
    ),
    dep_period AS (
      SELECT
        l.fixed_asset_id as asset_id,
        COALESCE(SUM(l.debit_base - l.credit_base), 0) as amount
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN assets a ON a.id = l.fixed_asset_id
      WHERE l.org_id = ${orgId}
        AND e.status = 'posted'
        AND e.entry_date >= ${q.data.start}
        AND e.entry_date <= ${q.data.end}
        AND l.account_id = a.dep_expense_account_id
      GROUP BY l.fixed_asset_id
    )
    SELECT
      a.id as "assetId",
      a.asset_no as "assetNo",
      a.category,
      a.name,
      to_char(a.acquisition_date, 'YYYY-MM-DD') as "acquisitionDate",
      a.status,
      COALESCE(co.amount, 0) as "openingCost",
      COALESCE(cp.debit, 0) as "additions",
      COALESCE(cp.credit, 0) as "disposals",
      (COALESCE(co.amount, 0) + COALESCE(cp.debit, 0) - COALESCE(cp.credit, 0)) as "closingCost",
      COALESCE(ao.amount, 0) as "openingAccumDep",
      COALESCE(dp.amount, 0) as "depExpense",
      COALESCE(adp.amount, 0) as "accumDepDisposed",
      (COALESCE(ao.amount, 0) + COALESCE(dp.amount, 0) - COALESCE(adp.amount, 0)) as "closingAccumDep",
      ((COALESCE(co.amount, 0) + COALESCE(cp.debit, 0) - COALESCE(cp.credit, 0)) - (COALESCE(ao.amount, 0) + COALESCE(dp.amount, 0) - COALESCE(adp.amount, 0))) as "netBookValue"
    FROM assets a
    LEFT JOIN cost_open co ON co.asset_id = a.id
    LEFT JOIN cost_period cp ON cp.asset_id = a.id
    LEFT JOIN ad_open ao ON ao.asset_id = a.id
    LEFT JOIN dep_period dp ON dp.asset_id = a.id
    LEFT JOIN ad_disposal_period adp ON adp.asset_id = a.id
    ORDER BY a.acquisition_date ASC, a.name ASC
  `;

  let items = (rows as any[]).map((r) => ({
    assetId: String(r.assetId),
    assetNo: r.assetNo ? String(r.assetNo) : null,
    category: r.category ? String(r.category) : null,
    name: String(r.name || ""),
    acquisitionDate: String(r.acquisitionDate || ""),
    status: String(r.status || ""),
    openingCost: Number(r.openingCost || 0),
    additions: Number(r.additions || 0),
    disposals: Number(r.disposals || 0),
    closingCost: Number(r.closingCost || 0),
    openingAccumDep: Number(r.openingAccumDep || 0),
    depExpense: Number(r.depExpense || 0),
    accumDepDisposed: Number(r.accumDepDisposed || 0),
    closingAccumDep: Number(r.closingAccumDep || 0),
    netBookValue: Number(r.netBookValue || 0),
  }));

  if (unassignedDepExpense !== 0) {
    const candidates = items.filter((it) => it.status === "active" && Number(it.closingCost || 0) > 0);
    if (candidates.length === 1) {
      const targetId = candidates[0].assetId;
      items = items.map((it) => {
        if (it.assetId !== targetId) return it;
        const depExpense = Math.round((Number(it.depExpense || 0) + unassignedDepExpense) * 100) / 100;
        const closingAccumDep = Math.round((Number(it.openingAccumDep || 0) + depExpense - Number(it.accumDepDisposed || 0)) * 100) / 100;
        const netBookValue = Math.round((Number(it.closingCost || 0) - closingAccumDep) * 100) / 100;
        return { ...it, depExpense, closingAccumDep, netBookValue };
      });
    } else {
      items = [
        ...items,
        {
          assetId: "__unassigned_dep__",
          assetNo: null,
          category: "Unassigned",
          name: "折旧（未关联 61xx）",
          acquisitionDate: "",
          status: "unassigned",
          openingCost: 0,
          additions: 0,
          disposals: 0,
          closingCost: 0,
          openingAccumDep: 0,
          depExpense: unassignedDepExpense,
          accumDepDisposed: 0,
          closingAccumDep: 0,
          netBookValue: 0,
        },
      ];
    }
  }

  const totals = items.reduce(
    (acc, it) => {
      acc.openingCost += it.openingCost;
      acc.additions += it.additions;
      acc.disposals += it.disposals;
      acc.closingCost += it.closingCost;
      acc.openingAccumDep += it.openingAccumDep;
      acc.depExpense += it.depExpense;
      acc.accumDepDisposed += it.accumDepDisposed;
      acc.closingAccumDep += it.closingAccumDep;
      acc.netBookValue += it.netBookValue;
      return acc;
    },
    {
      openingCost: 0,
      additions: 0,
      disposals: 0,
      closingCost: 0,
      openingAccumDep: 0,
      depExpense: 0,
      accumDepDisposed: 0,
      closingAccumDep: 0,
      netBookValue: 0,
    },
  );

  res.status(200).json({
    success: true,
    data: {
      start: q.data.start,
      end: q.data.end,
      items,
      totals,
    },
  });
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

  const income = typed.filter((r) => r.type === "income");
  const cogs = typed.filter((r) => r.type === "cogs");
  const expenses = typed.filter((r) => r.type === "expense");

  const sum = (xs: any[]) => xs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totalIncome = sum(income);
  const totalCogs = sum(cogs);
  const grossProfit = totalIncome - totalCogs;
  const totalExpenses = sum(expenses);
  const netProfit = grossProfit - totalExpenses;

  const rows = [
    { section: "Trading Income", code: "", name: "Trading Income", amount: null, isHeader: true },
    ...income.map((r) => ({ section: "Trading Income", code: r.code, name: r.name, amount: r.amount })),
    { section: "Trading Income", code: "", name: "Total Trading Income", amount: totalIncome, isTotal: true },
    { section: "Cost of Sales", code: "", name: "Cost of Sales", amount: null, isHeader: true },
    ...cogs.map((r) => ({ section: "Cost of Sales", code: r.code, name: r.name, amount: r.amount })),
    { section: "Cost of Sales", code: "", name: "Total Cost of Sales", amount: totalCogs, isTotal: true },
    { section: "Summary", code: "", name: "Gross Profit", amount: grossProfit, isTotal: true },
    { section: "Operating Expenses", code: "", name: "Operating Expenses", amount: null, isHeader: true },
    ...expenses.map((r) => ({ section: "Operating Expenses", code: r.code, name: r.name, amount: r.amount })),
    { section: "Operating Expenses", code: "", name: "Total Operating Expenses", amount: totalExpenses, isTotal: true },
    { section: "Summary", code: "", name: "Net Profit", amount: netProfit, isTotal: true },
  ];

  res.status(200).json({ success: true, data: { rows, netProfit } });
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

  const balances = (await fetchAccountBalancesAsOf(sql, orgId, q.data.asOf, costCenterId)) as any[];
  const netProfitYtd = await computeNetProfit(sql, orgId, `${q.data.asOf.slice(0, 4)}-01-01`, q.data.asOf, costCenterId);

  const assets = balances.filter((a) => a.type === "asset");
  const liabilities = balances.filter((a) => a.type === "liability");
  const equity = balances.filter((a) => a.type === "equity");

  const isBank = (a: any) => String(a.code).startsWith("10") || String(a.name).toLowerCase().includes("bank") || String(a.name).toLowerCase().includes("cash");
  const isFixed = (a: any) => String(a.code).startsWith("16") || String(a.name).toLowerCase().includes("fixed") || String(a.name).toLowerCase().includes("equipment") || String(a.name).toLowerCase().includes("depreciation");

  const bank = assets.filter(isBank);
  const fixed = assets.filter(isFixed);
  const currentAssets = assets.filter((a) => !isBank(a) && !isFixed(a));

  const amtAsset = (a: any) => Number(a.balance || 0);
  const amtLiabEq = (a: any) => -Number(a.balance || 0);

  const sum = (xs: any[], f: (x: any) => number) => xs.reduce((s, r) => s + (f(r) || 0), 0);
  const totalBank = sum(bank, amtAsset);
  const totalCurrentAssets = sum(currentAssets, amtAsset);
  const totalFixed = sum(fixed, amtAsset);
  const totalAssets = totalBank + totalCurrentAssets + totalFixed;
  const totalCurrentLiab = sum(liabilities, amtLiabEq);
  const totalLiab = totalCurrentLiab;
  const netAssets = totalAssets - totalLiab;
  const totalEquity = netProfitYtd + sum(equity, amtLiabEq);
  const variance = netAssets - totalEquity;

  const rows: any[] = [];
  rows.push({ section: "Assets", label: "Assets", amount: null, isHeader: true });
  rows.push({ section: "Assets", label: "Bank", amount: null, indent: 1, isHeader: true });
  for (const a of bank) rows.push({ section: "Assets", code: a.code, name: a.name, label: a.name, amount: amtAsset(a), indent: 1 });
  rows.push({ section: "Assets", label: "Total Bank", amount: totalBank, indent: 1, isTotal: true });
  rows.push({ section: "Assets", label: "Current Assets", amount: null, indent: 1, isHeader: true });
  for (const a of currentAssets) rows.push({ section: "Assets", code: a.code, name: a.name, label: a.name, amount: amtAsset(a), indent: 1 });
  rows.push({ section: "Assets", label: "Total Current Assets", amount: totalCurrentAssets, indent: 1, isTotal: true });
  rows.push({ section: "Assets", label: "Fixed Assets", amount: null, indent: 1, isHeader: true });
  for (const a of fixed) rows.push({ section: "Assets", code: a.code, name: a.name, label: a.name, amount: amtAsset(a), indent: 1 });
  rows.push({ section: "Assets", label: "Total Fixed Assets", amount: totalFixed, indent: 1, isTotal: true });
  rows.push({ section: "Assets", label: "Total Assets", amount: totalAssets, isTotal: true });
  rows.push({ section: "Liabilities", label: "Liabilities", amount: null, isHeader: true });
  rows.push({ section: "Liabilities", label: "Current Liabilities", amount: null, indent: 1, isHeader: true });
  for (const a of liabilities) rows.push({ section: "Liabilities", code: a.code, name: a.name, label: a.name, amount: amtLiabEq(a), indent: 1 });
  rows.push({ section: "Liabilities", label: "Total Current Liabilities", amount: totalCurrentLiab, indent: 1, isTotal: true });
  rows.push({ section: "Liabilities", label: "Total Liabilities", amount: totalLiab, isTotal: true });
  rows.push({ section: "Summary", label: "Net Assets", amount: netAssets, indent: 1, isTotal: true });
  rows.push({ section: "Equity", label: "Equity", amount: null, isHeader: true });
  rows.push({ section: "Equity", label: "Current Year Earnings", amount: netProfitYtd, indent: 1 });
  for (const a of equity) rows.push({ section: "Equity", code: a.code, name: a.name, label: a.name, amount: amtLiabEq(a), indent: 1 });
  rows.push({ section: "Equity", label: "Total Equity", amount: totalEquity, isTotal: true });
  rows.push({ section: "Summary", label: "Net Assets - Total Equity", amount: variance, isTotal: true });

  res.status(200).json({ success: true, data: { rows, netProfitYtd, variance } });
});

router.get("/balance-sheet.xlsx", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const q = z
    .object({ asOf: z.string().min(10), costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional() })
    .safeParse({ asOf: req.query.asOf, costCenterId: req.query.costCenterId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing asOf" });
    return;
  }

  const sql = getSql();
  const orgName = await getOrgName(sql, orgId);
  const balances = (await fetchAccountBalancesAsOf(sql, orgId, q.data.asOf, q.data.costCenterId)) as any[];
  const netProfitYtd = await computeNetProfit(sql, orgId, `${q.data.asOf.slice(0, 4)}-01-01`, q.data.asOf, q.data.costCenterId);

  const assets = balances.filter((a) => a.type === "asset");
  const liabilities = balances.filter((a) => a.type === "liability");
  const equity = balances.filter((a) => a.type === "equity");

  const isBank = (a: any) => String(a.code).startsWith("10") || String(a.name).toLowerCase().includes("bank") || String(a.name).toLowerCase().includes("cash");
  const isFixed = (a: any) => String(a.code).startsWith("16") || String(a.name).toLowerCase().includes("fixed") || String(a.name).toLowerCase().includes("equipment") || String(a.name).toLowerCase().includes("depreciation");

  const bank = assets.filter(isBank);
  const fixed = assets.filter(isFixed);
  const currentAssets = assets.filter((a) => !isBank(a) && !isFixed(a));

  const amtAsset = (a: any) => Number(a.balance || 0);
  const amtLiabEq = (a: any) => -Number(a.balance || 0);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Balance Sheet");
  ws.getColumn(1).width = 1.3671875;
  ws.getColumn(2).width = 50;
  ws.getColumn(3).width = 14.16015625;

  ws.getCell("A1").value = "Balance Sheet";
  ws.getCell("A2").value = orgName || "";
  ws.getCell("A3").value = `As at ${fmtDateLong(q.data.asOf)}`;
  ws.getCell("B5").value = "Account";
  ws.getCell("C5").value = fmtDateLong(q.data.asOf);

  let r = 7;
  ws.getCell(r, 1).value = "Assets";
  r++;
  ws.getCell(r, 2).value = "Bank";
  r++;
  const bankStart = r;
  for (const a of bank) {
    ws.getCell(r, 2).value = a.name;
    ws.getCell(r, 3).value = amtAsset(a);
    r++;
  }
  const bankEnd = r - 1;
  ws.getCell(r, 2).value = "Total Bank";
  ws.getCell(r, 3).value = { formula: bankEnd >= bankStart ? `SUM(C${bankStart}:C${bankEnd})` : "0" } as any;
  const rTotalBank = r;
  r++;
  ws.getCell(r, 2).value = "Current Assets";
  r++;
  const curStart = r;
  for (const a of currentAssets) {
    ws.getCell(r, 2).value = a.name;
    ws.getCell(r, 3).value = amtAsset(a);
    r++;
  }
  const curEnd = r - 1;
  ws.getCell(r, 2).value = "Total Current Assets";
  ws.getCell(r, 3).value = { formula: curEnd >= curStart ? `SUM(C${curStart}:C${curEnd})` : "0" } as any;
  const rTotalCur = r;
  r++;
  ws.getCell(r, 2).value = "Fixed Assets";
  r++;
  const fixStart = r;
  for (const a of fixed) {
    ws.getCell(r, 2).value = a.name;
    ws.getCell(r, 3).value = amtAsset(a);
    r++;
  }
  const fixEnd = r - 1;
  ws.getCell(r, 2).value = "Total Fixed Assets";
  ws.getCell(r, 3).value = { formula: fixEnd >= fixStart ? `SUM(C${fixStart}:C${fixEnd})` : "0" } as any;
  const rTotalFix = r;
  r++;
  ws.getCell(r, 1).value = "Total Assets";
  ws.getCell(r, 3).value = { formula: `C${rTotalBank}+C${rTotalCur}+C${rTotalFix}` } as any;
  const rTotalAssets = r;
  r += 2;
  ws.getCell(r, 1).value = "Liabilities";
  r++;
  ws.getCell(r, 2).value = "Current Liabilities";
  r++;
  const liabStart = r;
  for (const a of liabilities) {
    ws.getCell(r, 2).value = a.name;
    ws.getCell(r, 3).value = amtLiabEq(a);
    r++;
  }
  const liabEnd = r - 1;
  ws.getCell(r, 2).value = "Total Current Liabilities";
  ws.getCell(r, 3).value = { formula: liabEnd >= liabStart ? `SUM(C${liabStart}:C${liabEnd})` : "0" } as any;
  const rTotalCurLiab = r;
  r++;
  ws.getCell(r, 1).value = "Total Liabilities";
  ws.getCell(r, 3).value = { formula: `C${rTotalCurLiab}` } as any;
  const rTotalLiab = r;
  r += 2;
  ws.getCell(r, 2).value = "Net Assets";
  ws.getCell(r, 3).value = { formula: `C${rTotalAssets}-C${rTotalLiab}` } as any;
  const rNetAssets = r;
  r += 2;
  ws.getCell(r, 1).value = "Equity";
  r++;
  const eqStart = r;
  ws.getCell(r, 2).value = "Current Year Earnings";
  ws.getCell(r, 3).value = netProfitYtd;
  r++;
  for (const a of equity) {
    ws.getCell(r, 2).value = a.name;
    ws.getCell(r, 3).value = amtLiabEq(a);
    r++;
  }
  const eqEnd = r - 1;
  ws.getCell(r, 1).value = "Total Equity";
  ws.getCell(r, 3).value = { formula: eqEnd >= eqStart ? `SUM(C${eqStart}:C${eqEnd})` : "0" } as any;
  const rTotalEquity = r;
  r++;
  ws.getCell(r, 2).value = "Net Assets - Total Equity";
  ws.getCell(r, 3).value = { formula: `C${rNetAssets}-C${rTotalEquity}` } as any;

  for (let i = 1; i <= r; i++) {
    ws.getCell(i, 3).numFmt = "#,##0.00;(#,##0.00)";
  }
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(2).font = { bold: true };
  ws.getRow(5).font = { bold: true };
  ws.getRow(7).font = { bold: true };

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`Balance_Sheet_${q.data.asOf}.xlsx`)}`);
  const buf = await wb.xlsx.writeBuffer();
  res.status(200).send(Buffer.from(buf));
});

router.get("/profit-loss.xlsx", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const q = z
    .object({ start: z.string().min(10), end: z.string().min(10), costCenterId: z.union([z.string().uuid(), z.literal("__none__")]).optional() })
    .safeParse({ start: req.query.start, end: req.query.end, costCenterId: req.query.costCenterId });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }

  const sql = getSql();
  const orgName = await getOrgName(sql, orgId);

  const plRows = (await (async () => {
    const rowsResp = await sql`
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
        AND a.type IN ('income','cogs','expense')
        ${q.data.costCenterId === undefined ? sql`` : q.data.costCenterId === "__none__" ? sql`AND l.cost_center_id IS NULL` : sql`AND l.cost_center_id = ${q.data.costCenterId}`}
      GROUP BY a.type, a.code, a.name
      ORDER BY a.type ASC, a.code ASC
    `;
    return rowsResp as any[];
  })());

  const income = plRows
    .filter((r) => String(r.type) === "income")
    .map((r) => ({ name: String(r.name), amount: Number(r.credit || 0) - Number(r.debit || 0) }));
  const cogs = plRows
    .filter((r) => String(r.type) === "cogs")
    .map((r) => ({ name: String(r.name), amount: Number(r.debit || 0) - Number(r.credit || 0) }));
  const expenses = plRows
    .filter((r) => String(r.type) === "expense")
    .map((r) => ({ name: String(r.name), amount: Number(r.debit || 0) - Number(r.credit || 0) }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Profit and Loss");
  ws.getColumn(1).width = 23.4375;
  ws.getColumn(2).width = 10.66015625;

  ws.getCell("A1").value = "Profit and Loss";
  ws.getCell("A2").value = orgName || "";
  ws.getCell("A3").value = `For the month ended ${fmtDateLong(q.data.end)}`;
  ws.getCell("A5").value = "Account";
  ws.getCell("B5").value = monthLabel(q.data.end);
  ws.getCell("A7").value = "Trading Income";
  let r = 8;
  for (const x of income) {
    ws.getCell(r, 1).value = x.name;
    ws.getCell(r, 2).value = x.amount;
    r++;
  }
  const incomeStart = 8;
  const incomeEnd = r - 1;
  ws.getCell(r, 1).value = "Total Trading Income";
  ws.getCell(r, 2).value = { formula: incomeEnd >= incomeStart ? `SUM(B${incomeStart}:B${incomeEnd})` : "0" } as any;
  const rTotalIncome = r;
  r += 2;
  ws.getCell(r, 1).value = "Cost of Sales";
  r++;
  const cogsStart = r;
  for (const x of cogs) {
    ws.getCell(r, 1).value = x.name;
    ws.getCell(r, 2).value = x.amount;
    r++;
  }
  const cogsEnd = r - 1;
  ws.getCell(r, 1).value = "Total Cost of Sales";
  ws.getCell(r, 2).value = { formula: cogsEnd >= cogsStart ? `SUM(B${cogsStart}:B${cogsEnd})` : "0" } as any;
  const rTotalCogs = r;
  r += 2;
  ws.getCell(r, 1).value = "Gross Profit";
  ws.getCell(r, 2).value = { formula: `B${rTotalIncome}-B${rTotalCogs}` } as any;
  const rGross = r;
  r += 2;
  ws.getCell(r, 1).value = "Operating Expenses";
  r++;
  const expStart = r;
  for (const x of expenses) {
    ws.getCell(r, 1).value = x.name;
    ws.getCell(r, 2).value = x.amount;
    r++;
  }
  const expEnd = r - 1;
  ws.getCell(r, 1).value = "Total Operating Expenses";
  ws.getCell(r, 2).value = { formula: expEnd >= expStart ? `SUM(B${expStart}:B${expEnd})` : "0" } as any;
  const rTotalExp = r;
  r += 2;
  ws.getCell(r, 1).value = "Net Profit";
  ws.getCell(r, 2).value = { formula: `B${rGross}-B${rTotalExp}` } as any;

  for (let i = 1; i <= r; i++) {
    ws.getCell(i, 2).numFmt = "#,##0.00;(#,##0.00)";
  }
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(2).font = { bold: true };
  ws.getRow(5).font = { bold: true };

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`Profit_and_Loss_${q.data.end}.xlsx`)}`);
  const buf = await wb.xlsx.writeBuffer();
  res.status(200).send(Buffer.from(buf));
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

  const ccWhere =
    costCenterId === undefined
      ? sql``
      : costCenterId === "__none__"
        ? sql`AND l.cost_center_id IS NULL`
        : sql`AND l.cost_center_id = ${costCenterId}`;

  const accWhere = accountId ? sql`AND a.id = ${accountId}` : sql``;

  const accounts = (await sql`
    SELECT id as "accountId", code as "accountCode", name as "accountName", type as "accountType", normal_balance as "normalBalance"
    FROM accounts a
    WHERE a.org_id = ${orgId} AND a.is_active = true
    ${accWhere}
    ORDER BY a.code ASC
  `) as any[];

  const openingRows = (await sql`
    SELECT
      l.account_id as "accountId",
      COALESCE(SUM(l.debit_base - l.credit_base), 0) as "openingNet"
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.org_id = ${orgId}
      AND e.status = 'posted'
      AND e.entry_date < ${q.data.start}
      ${ccWhere}
    GROUP BY l.account_id
  `) as any[];

  const openingByAccount = new Map<string, number>();
  for (const r of openingRows) {
    openingByAccount.set(String(r.accountId), Number(r.openingNet || 0));
  }

  const lineRows = (await sql`
    SELECT
      l.account_id as "accountId",
      to_char(e.entry_date, 'YYYY-MM-DD') as "entryDate",
      e.id as "entryId",
      e.memo,
      l.description,
      l.cost_center_id as "costCenterId",
      cc.code as "costCenterCode",
      cc.name as "costCenterName",
      l.debit_base as "debitBase",
      l.credit_base as "creditBase"
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
    WHERE l.org_id = ${orgId}
      AND e.status = 'posted'
      AND e.entry_date >= ${q.data.start}
      AND e.entry_date <= ${q.data.end}
      ${ccWhere}
      ${accountId ? sql`AND l.account_id = ${accountId}` : sql``}
    ORDER BY e.entry_date ASC, e.created_at ASC, l.line_no ASC
  `) as any[];

  const linesByAccount = new Map<string, any[]>();
  for (const r of lineRows) {
    const id = String(r.accountId);
    const arr = linesByAccount.get(id) ?? [];
    arr.push(r);
    linesByAccount.set(id, arr);
  }

  const typeOrder = ["asset", "liability", "equity", "income", "cogs", "expense"];
  const typeLabel: Record<string, string> = {
    asset: "Assets",
    liability: "Liabilities",
    equity: "Equity",
    income: "Sales",
    cogs: "Cost",
    expense: "Expense",
  };

  const accountsSorted = accounts
    .slice()
    .sort((a, b) => {
      const ta = String(a.accountType);
      const tb = String(b.accountType);
      const ia = typeOrder.indexOf(ta);
      const ib = typeOrder.indexOf(tb);
      const da = ia === -1 ? 999 : ia;
      const db = ib === -1 ? 999 : ib;
      if (da !== db) return da - db;
      return String(a.accountCode).localeCompare(String(b.accountCode));
    });

  const sections: any[] = [];
  const sectionByType = new Map<string, any>();
  for (const a of accountsSorted) {
    const t = String(a.accountType);
    if (!sectionByType.has(t)) {
      const s = { type: t, label: typeLabel[t] ?? t, accounts: [] as any[] };
      sectionByType.set(t, s);
      sections.push(s);
    }
    const openingNet = openingByAccount.get(String(a.accountId)) ?? 0;
    let runningNet = openingNet;
    let periodDebit = 0;
    let periodCredit = 0;
    const tx = (linesByAccount.get(String(a.accountId)) ?? []).map((x) => {
      const debit = Number(x.debitBase || 0);
      const credit = Number(x.creditBase || 0);
      periodDebit += debit;
      periodCredit += credit;
      runningNet = runningNet + (debit - credit);
      return {
        kind: "txn",
        entryDate: String(x.entryDate),
        entryId: String(x.entryId),
        memo: x.memo == null ? null : String(x.memo),
        description: x.description == null ? null : String(x.description),
        costCenterId: x.costCenterId == null ? null : String(x.costCenterId),
        costCenterCode: x.costCenterCode == null ? null : String(x.costCenterCode),
        costCenterName: x.costCenterName == null ? null : String(x.costCenterName),
        debitBase: debit,
        creditBase: credit,
        balanceNet: runningNet,
      };
    });

    const closingNet = runningNet;
    (sectionByType.get(t) as any).accounts.push({
      accountId: String(a.accountId),
      accountCode: String(a.accountCode),
      accountName: String(a.accountName),
      accountType: t,
      normalBalance: String(a.normalBalance),
      openingNet,
      closingNet,
      periodDebit,
      periodCredit,
      lines: tx,
    });
  }

  res.status(200).json({ success: true, data: { sections } });
});

router.get("/ap-aging", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const q = z.object({ asOf: z.string().min(10) }).safeParse({ asOf: req.query.asOf });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing asOf" });
    return;
  }

  const sql = getSql();
  const asOf = q.data.asOf;

  const rows = await sql`
    WITH base AS (
      SELECT
        d.vendor_id as "vendorId",
        COALESCE(v.code, '') as "vendorCode",
        COALESCE(v.name, '') as "vendorName",
        GREATEST(0, (${asOf}::date - d.due_date))::int as "days",
        (GREATEST(0, (d.total_txn - d.paid_txn)) * d.fx_rate)::numeric as "openBase"
      FROM ap_documents d
      JOIN vendors v ON v.id = d.vendor_id AND v.org_id = d.org_id
      WHERE d.org_id = ${orgId}
        AND d.status = 'open'
        AND d.issue_date <= ${asOf}
        AND (d.total_txn - d.paid_txn) > 0
    )
    SELECT
      "vendorId",
      "vendorCode",
      "vendorName",
      COALESCE(SUM(CASE WHEN "days" <= 30 THEN "openBase" ELSE 0 END), 0) as "b0_30",
      COALESCE(SUM(CASE WHEN "days" >= 31 AND "days" <= 60 THEN "openBase" ELSE 0 END), 0) as "b31_60",
      COALESCE(SUM(CASE WHEN "days" >= 61 AND "days" <= 90 THEN "openBase" ELSE 0 END), 0) as "b61_90",
      COALESCE(SUM(CASE WHEN "days" >= 91 THEN "openBase" ELSE 0 END), 0) as "b90p",
      COALESCE(SUM("openBase"), 0) as "total"
    FROM base
    GROUP BY "vendorId", "vendorCode", "vendorName"
    ORDER BY "vendorName" ASC
  `;

  res.status(200).json({ success: true, data: { asOf, rows } });
});

router.get("/ar-aging", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const q = z.object({ asOf: z.string().min(10) }).safeParse({ asOf: req.query.asOf });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing asOf" });
    return;
  }

  const sql = getSql();
  const asOf = q.data.asOf;

  const rows = await sql`
    WITH base AS (
      SELECT
        d.customer_id as "customerId",
        COALESCE(c.code, '') as "customerCode",
        COALESCE(c.name, '') as "customerName",
        GREATEST(0, (${asOf}::date - d.due_date))::int as "days",
        (GREATEST(0, (d.total_txn - d.paid_txn)) * d.fx_rate)::numeric as "openBase"
      FROM ar_documents d
      JOIN customers c ON c.id = d.customer_id AND c.org_id = d.org_id
      WHERE d.org_id = ${orgId}
        AND d.status = 'open'
        AND d.issue_date <= ${asOf}
        AND (d.total_txn - d.paid_txn) > 0
    )
    SELECT
      "customerId",
      "customerCode",
      "customerName",
      COALESCE(SUM(CASE WHEN "days" <= 30 THEN "openBase" ELSE 0 END), 0) as "b0_30",
      COALESCE(SUM(CASE WHEN "days" >= 31 AND "days" <= 60 THEN "openBase" ELSE 0 END), 0) as "b31_60",
      COALESCE(SUM(CASE WHEN "days" >= 61 AND "days" <= 90 THEN "openBase" ELSE 0 END), 0) as "b61_90",
      COALESCE(SUM(CASE WHEN "days" >= 91 THEN "openBase" ELSE 0 END), 0) as "b90p",
      COALESCE(SUM("openBase"), 0) as "total"
    FROM base
    GROUP BY "customerId", "customerCode", "customerName"
    ORDER BY "customerName" ASC
  `;

  res.status(200).json({ success: true, data: { asOf, rows } });
});

export default router;
