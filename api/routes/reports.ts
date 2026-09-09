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
          SELECT
            a.id as accountId,
            a.code,
            a.name,
            a.type,
            COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.debit_base END), 0) as debit,
            COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.credit_base END), 0) as credit
          FROM accounts a
          LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
          LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.entry_date >= ${q.data.start} AND e.entry_date <= ${q.data.end}
          WHERE a.org_id = ${orgId}
            AND a.is_active = true
          GROUP BY a.id, a.code, a.name, a.type
          ORDER BY a.code ASC
        `
      : costCenterId === "__none__"
        ? await sql`
            SELECT
              a.id as accountId,
              a.code,
              a.name,
              a.type,
              COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.debit_base END), 0) as debit,
              COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.credit_base END), 0) as credit
            FROM accounts a
            LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id AND l.cost_center_id IS NULL
            LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.entry_date >= ${q.data.start} AND e.entry_date <= ${q.data.end}
            WHERE a.org_id = ${orgId}
              AND a.is_active = true
            GROUP BY a.id, a.code, a.name, a.type
            ORDER BY a.code ASC
          `
        : await sql`
            SELECT
              a.id as accountId,
              a.code,
              a.name,
              a.type,
              COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.debit_base END), 0) as debit,
              COALESCE(SUM(CASE WHEN e.id IS NULL THEN 0 ELSE l.credit_base END), 0) as credit
            FROM accounts a
            LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id AND l.cost_center_id = ${costCenterId}
            LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted' AND e.entry_date >= ${q.data.start} AND e.entry_date <= ${q.data.end}
            WHERE a.org_id = ${orgId}
              AND a.is_active = true
            GROUP BY a.id, a.code, a.name, a.type
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
  const rows =
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
  const rows =
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
  res.status(200).json({ success: true, data: { rows } });
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
