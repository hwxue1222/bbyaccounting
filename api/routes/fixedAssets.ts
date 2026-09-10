import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2 } from "../lib/nums.js";

const router = Router();

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

function monthKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT
      id,
      name,
      acquisition_date as "acquisitionDate",
      cost_base as "costBase",
      useful_life_months as "usefulLifeMonths",
      salvage_value_base as "salvageValueBase",
      status,
      disposed_at as "disposedAt"
    FROM fixed_assets
    WHERE org_id = ${orgId}
    ORDER BY acquisition_date DESC
  `;
  res.status(200).json({ success: true, data: { assets: rows } });
});

router.post("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    name: z.string().min(1),
    acquisitionDate: z.string().min(10),
    costTxn: z.number().positive(),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    usefulLifeMonths: z.number().int().positive(),
    salvageBase: z.number().nonnegative().default(0),
    offsetAccountId: z.string().uuid(),
    memo: z.string().trim().min(1).max(200).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();

  const assetAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1600' LIMIT 1`;
  const accumAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1610' LIMIT 1`;
  const depExpAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '6100' LIMIT 1`;
  const assetAccountId = assetAcc[0]?.id || null;
  const accumDepAccountId = accumAcc[0]?.id || null;
  const depExpenseAccountId = depExpAcc[0]?.id || null;
  if (!assetAccountId || !accumDepAccountId || !depExpenseAccountId) {
    res.status(400).json({ success: false, error: "Missing default fixed asset accounts" });
    return;
  }

  const costBase = round2(parsed.data.costTxn * parsed.data.fxRate);

  const created = await sql.begin(async (trx) => {
    const asset = (
      await trx`
        INSERT INTO fixed_assets (
          org_id, name, acquisition_date, cost_base, useful_life_months, salvage_value_base,
          asset_account_id, accum_dep_account_id, dep_expense_account_id
        ) VALUES (
          ${orgId}, ${parsed.data.name.trim()}, ${parsed.data.acquisitionDate}, ${costBase}, ${parsed.data.usefulLifeMonths}, ${parsed.data.salvageBase},
          ${assetAccountId}, ${accumDepAccountId}, ${depExpenseAccountId}
        )
        RETURNING id
      `
    )[0] as any;

    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.acquisitionDate}, 'posted', ${parsed.data.currency.toUpperCase()}, ${parsed.data.fxRate}, ${parsed.data.memo ? parsed.data.memo.trim() : 'Fixed asset purchase'}, ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
      VALUES (${orgId}, ${entry.id}, 1, ${assetAccountId}, 'Fixed asset cost', ${parsed.data.costTxn}, 0, ${costBase}, 0, ${asset.id})
    `;
    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base)
      VALUES (${orgId}, ${entry.id}, 2, ${parsed.data.offsetAccountId}, 'Fixed asset offset', 0, ${parsed.data.costTxn}, 0, ${costBase})
    `;

    return { assetId: asset.id, entryId: entry.id, costBase };
  });

  res.status(200).json({ success: true, data: created });
});

router.post("/depreciate", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const period = parsed.data.period;
  const runExisting = await sql`SELECT id FROM depreciation_runs WHERE org_id = ${orgId} AND period = ${period} LIMIT 1`;
  if (runExisting.length) {
    res.status(409).json({ success: false, error: "Depreciation already generated for this period" });
    return;
  }

  const assets = await sql`
    SELECT
      id,
      acquisition_date as "acquisitionDate",
      cost_base as "costBase",
      useful_life_months as "usefulLifeMonths",
      salvage_value_base as "salvageValueBase",
      asset_account_id as "assetAccountId",
      accum_dep_account_id as "accumDepAccountId",
      dep_expense_account_id as "depExpenseAccountId",
      status
    FROM fixed_assets
    WHERE org_id = ${orgId} AND status = 'active'
  `;

  const created = await sql.begin(async (trx) => {
    const orgRow = (await trx`SELECT base_currency as "baseCurrency" FROM organizations WHERE id = ${orgId} LIMIT 1`)[0] as any;
    const baseCurrency = String(orgRow?.baseCurrency || "BASE").toUpperCase();

    const run = (
      await trx`
        INSERT INTO depreciation_runs (org_id, period, created_by)
        VALUES (${orgId}, ${period}, ${req.auth!.userId})
        RETURNING id
      `
    )[0] as any;

    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${period + '-01'}, 'posted', ${baseCurrency}, 1, ${`Depreciation ${period}`}, ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    let lineNo = 1;
    let createdCount = 0;
    for (const a of assets as any[]) {
      const acq = new Date(a.acquisitionDate + 'T00:00:00Z');
      const acqKey = monthKey(acq);
      if (acqKey > period) continue;

      const depBase = Number(a.costBase) - Number(a.salvageValueBase);
      if (depBase <= 0) continue;
      const monthly = round2(depBase / Number(a.usefulLifeMonths));
      if (monthly <= 0) continue;

      const already = await trx`
        SELECT COALESCE(SUM(amount_base), 0) as total
        FROM depreciation_lines
        WHERE org_id = ${orgId} AND asset_id = ${a.id}
      `;
      const alreadyTotal = Number((already[0] as any).total);
      const remaining = round2(depBase - alreadyTotal);
      const amount = Math.max(0, Math.min(monthly, remaining));
      if (amount <= 0) continue;

      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${a.depExpenseAccountId}, 'Depreciation expense', ${amount}, 0, ${amount}, 0, ${a.id})
      `;
      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${a.accumDepAccountId}, 'Accumulated depreciation', 0, ${amount}, 0, ${amount}, ${a.id})
      `;

      await trx`
        INSERT INTO depreciation_lines (org_id, run_id, asset_id, amount_base, entry_id)
        VALUES (${orgId}, ${run.id}, ${a.id}, ${amount}, ${entry.id})
      `;
      createdCount += 1;
    }

    return { runId: run.id, entryId: entry.id, assetCount: createdCount };
  });

  res.status(200).json({ success: true, data: created });
});

router.post("/:id/dispose", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    date: z.string().min(10),
    proceedsBase: z.number().nonnegative().default(0),
    cashAccountId: z.string().uuid(),
    gainLossAccountId: z.string().uuid().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const assetId = req.params.id;
  const assets = await sql`
    SELECT
      id,
      cost_base as "costBase",
      status,
      asset_account_id as "assetAccountId",
      accum_dep_account_id as "accumDepAccountId"
    FROM fixed_assets
    WHERE id = ${assetId} AND org_id = ${orgId}
    LIMIT 1
  `;
  const asset = assets[0] as any;
  if (!asset) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  if (asset.status !== "active") {
    res.status(409).json({ success: false, error: "Asset is not active" });
    return;
  }

  const gainLossAccId = parsed.data.gainLossAccountId
    ? parsed.data.gainLossAccountId
    : (
        await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '7000' LIMIT 1`
      )[0]?.id;
  if (!gainLossAccId) {
    res.status(400).json({ success: false, error: "Missing gain/loss account" });
    return;
  }

  const depRows = await sql`
    SELECT COALESCE(SUM(amount_base), 0) as total
    FROM depreciation_lines
    WHERE org_id = ${orgId} AND asset_id = ${assetId}
  `;
  const accumDep = round2(Number((depRows[0] as any).total));
  const cost = round2(Number(asset.costBase));
  const proceeds = round2(parsed.data.proceedsBase);
  const gainLoss = round2(proceeds + accumDep - cost);

  const created = await sql.begin(async (trx) => {
    const orgRow = (await trx`SELECT base_currency as "baseCurrency" FROM organizations WHERE id = ${orgId} LIMIT 1`)[0] as any;
    const baseCurrency = String(orgRow?.baseCurrency || "BASE").toUpperCase();

    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', ${baseCurrency}, 1, 'Fixed asset disposal', ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    let lineNo = 1;
    if (proceeds > 0) {
      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${parsed.data.cashAccountId}, 'Disposal proceeds', ${proceeds}, 0, ${proceeds}, 0, ${assetId})
      `;
    }
    if (accumDep > 0) {
      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${asset.accumDepAccountId}, 'Reverse accumulated depreciation', ${accumDep}, 0, ${accumDep}, 0, ${assetId})
      `;
    }
    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
      VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${asset.assetAccountId}, 'Remove asset cost', 0, ${cost}, 0, ${cost}, ${assetId})
    `;

    if (gainLoss !== 0) {
      if (gainLoss > 0) {
        await trx`
          INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
          VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${gainLossAccId}, 'Gain on disposal', 0, ${gainLoss}, 0, ${gainLoss}, ${assetId})
        `;
      } else {
        await trx`
          INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id)
          VALUES (${orgId}, ${entry.id}, ${lineNo++}, ${gainLossAccId}, 'Loss on disposal', ${Math.abs(gainLoss)}, 0, ${Math.abs(gainLoss)}, 0, ${assetId})
        `;
      }
    }

    await trx`UPDATE fixed_assets SET status = 'disposed', disposed_at = ${parsed.data.date} WHERE id = ${assetId} AND org_id = ${orgId}`;
    return { entryId: entry.id, gainLoss, accumDep };
  });

  res.status(200).json({ success: true, data: created });
});

export default router;
