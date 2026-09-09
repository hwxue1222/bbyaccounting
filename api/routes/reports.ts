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
    .object({ start: z.string().min(10), end: z.string().min(10) })
    .safeParse({ start: req.query.start, end: req.query.end });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }
  const sql = getSql();
  const rows = await sql`
    SELECT
      a.id as accountId,
      a.code,
      a.name,
      a.type,
      COALESCE(SUM(l.debit_base), 0) as debit,
      COALESCE(SUM(l.credit_base), 0) as credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id
    LEFT JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.org_id = ${orgId}
      AND a.is_active = true
      AND e.status = 'posted'
      AND e.entry_date >= ${q.data.start}
      AND e.entry_date <= ${q.data.end}
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
    .object({ start: z.string().min(10), end: z.string().min(10) })
    .safeParse({ start: req.query.start, end: req.query.end });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing start/end" });
    return;
  }
  const sql = getSql();
  const rows = await sql`
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
  `;
  res.status(200).json({ success: true, data: { rows } });
});

router.get("/balance-sheet", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z.object({ asOf: z.string().min(10) }).safeParse({ asOf: req.query.asOf });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing asOf" });
    return;
  }
  const sql = getSql();
  const rows = await sql`
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
  `;
  res.status(200).json({ success: true, data: { rows } });
});

router.get("/gl", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const q = z
    .object({ accountId: z.string().uuid(), start: z.string().min(10), end: z.string().min(10) })
    .safeParse({ accountId: req.query.accountId, start: req.query.start, end: req.query.end });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Missing accountId/start/end" });
    return;
  }
  const sql = getSql();
  const lines = await sql`
    SELECT
      e.entry_date as entryDate,
      e.id as entryId,
      e.memo,
      l.description,
      l.debit_base as debitBase,
      l.credit_base as creditBase
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.org_id = ${orgId}
      AND l.account_id = ${q.data.accountId}
      AND e.status = 'posted'
      AND e.entry_date >= ${q.data.start}
      AND e.entry_date <= ${q.data.end}
    ORDER BY e.entry_date ASC, e.created_at ASC, l.line_no ASC
  `;
  res.status(200).json({ success: true, data: { lines } });
});

export default router;
