import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";

const router = Router();

async function requireOrg(req: AuthedRequest, res: Response): Promise<string | null> {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

router.get("/bootstrap", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();

  const q = z
    .object({ limit: z.coerce.number().int().min(1).max(500).optional() })
    .safeParse({ limit: req.query.limit });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Invalid query" });
    return;
  }
  const limit = q.data.limit ?? 50;

  const [accounts, costCenters, currencies, fxRates, bankAccounts] = await Promise.all([
    sql`
      SELECT
        id,
        code,
        name,
        type,
        normal_balance as "normalBalance",
        is_active as "isActive",
        link_inventory_fifo as "linkInventoryFifo",
        link_fixed_assets as "linkFixedAssets"
      FROM accounts
      WHERE org_id = ${orgId}
      ORDER BY code ASC
    `,
    sql`
      SELECT id, code, name, is_active as "isActive"
      FROM cost_centers
      WHERE org_id = ${orgId}
      ORDER BY code ASC
    `,
    sql`
      SELECT id, code, is_enabled as "isEnabled"
      FROM currencies
      WHERE org_id = ${orgId}
      ORDER BY code ASC
    `,
    sql`
      SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
      FROM fx_rates
      WHERE org_id = ${orgId}
      ORDER BY rate_date DESC, currency_code ASC
      LIMIT ${limit}
    `,
    sql`
      SELECT
        id,
        bank_name as "bankName",
        account_no as "accountNo",
        account_id as "accountId",
        is_active as "isActive"
      FROM bank_accounts
      WHERE org_id = ${orgId}
      ORDER BY bank_name ASC, account_no ASC
    `,
  ]);

  res.status(200).json({ success: true, data: { accounts, costCenters, currencies, fxRates, bankAccounts } });
});

router.get("/accounts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT
      id,
      code,
      name,
      type,
      normal_balance as "normalBalance",
      is_active as "isActive",
      link_inventory_fifo as "linkInventoryFifo",
      link_fixed_assets as "linkFixedAssets"
    FROM accounts
    WHERE org_id = ${orgId}
    ORDER BY code ASC
  `;
  res.status(200).json({ success: true, data: { accounts: rows } });
});

router.post("/accounts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]),
    normalBalance: z.enum(["debit", "credit"]),
    linkInventoryFifo: z.boolean().optional(),
    linkFixedAssets: z.boolean().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const row = (
    await sql`
      INSERT INTO accounts (org_id, code, name, type, normal_balance, link_inventory_fifo, link_fixed_assets)
      VALUES (
        ${orgId},
        ${parsed.data.code.trim()},
        ${parsed.data.name.trim()},
        ${parsed.data.type},
        ${parsed.data.normalBalance},
        ${parsed.data.linkInventoryFifo ?? false},
        ${parsed.data.linkFixedAssets ?? false}
      )
      RETURNING
        id,
        code,
        name,
        type,
        normal_balance as "normalBalance",
        is_active as "isActive",
        link_inventory_fifo as "linkInventoryFifo",
        link_fixed_assets as "linkFixedAssets"
    `
  )[0];
  res.status(200).json({ success: true, data: { account: row } });
});

router.patch("/accounts/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    type: z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]).optional(),
    normalBalance: z.enum(["debit", "credit"]).optional(),
    isActive: z.boolean().optional(),
    linkInventoryFifo: z.boolean().optional(),
    linkFixedAssets: z.boolean().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ success: false, error: "No changes" });
    return;
  }

  const sql = getSql();
  const id = req.params.id;

  const code = parsed.data.code?.trim();
  const name = parsed.data.name?.trim();
  const type = parsed.data.type;
  const normalBalance = parsed.data.normalBalance;
  const isActive = parsed.data.isActive;
  const linkInventoryFifo = parsed.data.linkInventoryFifo;
  const linkFixedAssets = parsed.data.linkFixedAssets;

  try {
    const row = (
      await sql`
        UPDATE accounts
        SET
          code = COALESCE(${code ?? null}, code),
          name = COALESCE(${name ?? null}, name),
          type = COALESCE(${type ?? null}, type),
          normal_balance = COALESCE(${normalBalance ?? null}, normal_balance),
          is_active = COALESCE(${isActive ?? null}, is_active),
          link_inventory_fifo = COALESCE(${linkInventoryFifo ?? null}, link_inventory_fifo),
          link_fixed_assets = COALESCE(${linkFixedAssets ?? null}, link_fixed_assets)
        WHERE id = ${id} AND org_id = ${orgId}
        RETURNING
          id,
          code,
          name,
          type,
          normal_balance as "normalBalance",
          is_active as "isActive",
          link_inventory_fifo as "linkInventoryFifo",
          link_fixed_assets as "linkFixedAssets"
      `
    )[0];
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    res.status(200).json({ success: true, data: { account: row } });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("duplicate key")) {
      res.status(409).json({ success: false, error: "Account code already exists" });
      return;
    }
    throw e;
  }
});

router.get("/cost-centers", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT id, code, name, is_active as "isActive"
    FROM cost_centers
    WHERE org_id = ${orgId}
    ORDER BY code ASC
  `;
  res.status(200).json({ success: true, data: { costCenters: rows } });
});

router.post("/cost-centers", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const bodySchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const row = (
    await sql`
      INSERT INTO cost_centers (org_id, code, name)
      VALUES (${orgId}, ${parsed.data.code.trim()}, ${parsed.data.name.trim()})
      RETURNING id, code, name, is_active as "isActive"
    `
  )[0];
  res.status(200).json({ success: true, data: { costCenter: row } });
});

router.get("/currencies", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT id, code, is_enabled as "isEnabled"
    FROM currencies
    WHERE org_id = ${orgId}
    ORDER BY code ASC
  `;
  res.status(200).json({ success: true, data: { currencies: rows } });
});

router.post("/currencies", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const bodySchema = z.object({ code: z.string().min(3).max(3), isEnabled: z.boolean().optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const code = parsed.data.code.toUpperCase();
  const isEnabled = parsed.data.isEnabled ?? true;
  const row = (
    await sql`
      INSERT INTO currencies (org_id, code, is_enabled)
      VALUES (${orgId}, ${code}, ${isEnabled})
      ON CONFLICT (org_id, code)
      DO UPDATE SET is_enabled = EXCLUDED.is_enabled
      RETURNING id, code, is_enabled as "isEnabled"
    `
  )[0];
  res.status(200).json({ success: true, data: { currency: row } });
});

router.patch("/currencies/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const bodySchema = z.object({ isEnabled: z.boolean().optional(), code: z.string().min(3).max(3).optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ success: false, error: "No changes" });
    return;
  }
  const sql = getSql();
  const id = req.params.id;

  try {
    const row = await sql.begin(async (trx) => {
      const current = (
        await trx`
          SELECT id, code, is_enabled as "isEnabled"
          FROM currencies
          WHERE id = ${id} AND org_id = ${orgId}
          LIMIT 1
        `
      )[0] as any;

      if (!current) return null;

      const prevCode = String(current.code || "").toUpperCase();
      const prevEnabled = Boolean(current.isEnabled);
      const nextCode = parsed.data.code ? parsed.data.code.trim().toUpperCase() : prevCode;
      const nextEnabled = parsed.data.isEnabled ?? prevEnabled;

      if (nextCode === prevCode && nextEnabled === prevEnabled) {
        throw new Error("__NO_CHANGES__");
      }

      if (nextCode !== prevCode) {
        const orgRow = (
          await trx`
            SELECT base_currency as "baseCurrency"
            FROM organizations
            WHERE id = ${orgId}
            LIMIT 1
          `
        )[0] as any;
        const baseCurrency = String(orgRow?.baseCurrency || "BASE").toUpperCase();
        if (prevCode === baseCurrency) {
          throw new Error("__BASE_CURRENCY__");
        }

        const dup = (
          await trx`
            SELECT 1
            FROM currencies
            WHERE org_id = ${orgId} AND code = ${nextCode} AND id <> ${id}
            LIMIT 1
          `
        )[0];
        if (dup) {
          throw new Error("__DUP_CODE__");
        }

        const fxConflict = (
          await trx`
            SELECT 1
            FROM fx_rates f_old
            JOIN fx_rates f_new
              ON f_new.org_id = f_old.org_id
             AND f_new.rate_date = f_old.rate_date
            WHERE f_old.org_id = ${orgId}
              AND f_old.currency_code = ${prevCode}
              AND f_new.currency_code = ${nextCode}
            LIMIT 1
          `
        )[0];
        if (fxConflict) {
          throw new Error("__FX_CONFLICT__");
        }

        await trx`UPDATE fx_rates SET currency_code = ${nextCode} WHERE org_id = ${orgId} AND currency_code = ${prevCode}`;
        await trx`UPDATE journal_entries SET currency_code = ${nextCode} WHERE org_id = ${orgId} AND currency_code = ${prevCode}`;
        await trx`UPDATE inventory_moves SET currency_code = ${nextCode} WHERE org_id = ${orgId} AND currency_code = ${prevCode}`;
      }

      const updated = (
        await trx`
          UPDATE currencies
          SET code = ${nextCode}, is_enabled = ${nextEnabled}
          WHERE id = ${id} AND org_id = ${orgId}
          RETURNING id, code, is_enabled as "isEnabled"
        `
      )[0];
      return updated;
    });

    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    res.status(200).json({ success: true, data: { currency: row } });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("__NO_CHANGES__")) {
      res.status(400).json({ success: false, error: "No changes" });
      return;
    }
    if (msg.includes("__BASE_CURRENCY__")) {
      res.status(400).json({ success: false, error: "Cannot rename base currency" });
      return;
    }
    if (msg.includes("__DUP_CODE__") || msg.includes("duplicate key")) {
      res.status(409).json({ success: false, error: "Currency code already exists" });
      return;
    }
    if (msg.includes("__FX_CONFLICT__")) {
      res.status(409).json({ success: false, error: "FX rates conflict" });
      return;
    }
    throw e;
  }
});

router.get("/fx-rates", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;

  const q = z
    .object({
      rateDate: z.string().min(10).optional(),
      currencyCode: z.string().min(3).max(3).optional(),
      start: z.string().min(10).optional(),
      end: z.string().min(10).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .safeParse({
      rateDate: req.query.rateDate,
      currencyCode: req.query.currencyCode,
      start: req.query.start,
      end: req.query.end,
      limit: req.query.limit,
    });
  if (!q.success) {
    res.status(400).json({ success: false, error: "Invalid query" });
    return;
  }
  const sql = getSql();

  const currencyCode = q.data.currencyCode ? q.data.currencyCode.toUpperCase() : undefined;
  const limit = q.data.limit ?? 50;

  if (q.data.rateDate && currencyCode) {
    const rows = await sql`
      SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
      FROM fx_rates
      WHERE org_id = ${orgId}
        AND rate_date = ${q.data.rateDate}
        AND currency_code = ${currencyCode}
      LIMIT 1
    `;
    res.status(200).json({ success: true, data: { fxRates: rows } });
    return;
  }

  if (q.data.start && q.data.end) {
    const rows = currencyCode
      ? await sql`
          SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
          FROM fx_rates
          WHERE org_id = ${orgId}
            AND rate_date >= ${q.data.start}
            AND rate_date <= ${q.data.end}
            AND currency_code = ${currencyCode}
          ORDER BY rate_date DESC, currency_code ASC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
          FROM fx_rates
          WHERE org_id = ${orgId}
            AND rate_date >= ${q.data.start}
            AND rate_date <= ${q.data.end}
          ORDER BY rate_date DESC, currency_code ASC
          LIMIT ${limit}
        `;
    res.status(200).json({ success: true, data: { fxRates: rows } });
    return;
  }

  const rows = currencyCode
    ? await sql`
        SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
        FROM fx_rates
        WHERE org_id = ${orgId}
          AND currency_code = ${currencyCode}
        ORDER BY rate_date DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
        FROM fx_rates
        WHERE org_id = ${orgId}
        ORDER BY rate_date DESC, currency_code ASC
        LIMIT ${limit}
      `;
  res.status(200).json({ success: true, data: { fxRates: rows } });
});

router.post("/fx-rates", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    rateDate: z.string().min(10),
    currencyCode: z.string().min(3).max(3),
    fxRate: z.number().positive(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const row = (
    await sql`
      INSERT INTO fx_rates (org_id, rate_date, currency_code, fx_rate)
      VALUES (${orgId}, ${parsed.data.rateDate}, ${parsed.data.currencyCode.toUpperCase()}, ${parsed.data.fxRate})
      ON CONFLICT (org_id, rate_date, currency_code)
      DO UPDATE SET fx_rate = EXCLUDED.fx_rate
      RETURNING id, rate_date as "rateDate", currency_code as "currencyCode", fx_rate as "fxRate"
    `
  )[0];
  res.status(200).json({ success: true, data: { fxRate: row } });
});

router.get("/bank-accounts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT
      id,
      bank_name as "bankName",
      account_no as "accountNo",
      account_id as "accountId",
      is_active as "isActive"
    FROM bank_accounts
    WHERE org_id = ${orgId}
    ORDER BY bank_name ASC, account_no ASC
  `;
  res.status(200).json({ success: true, data: { bankAccounts: rows } });
});

router.post("/bank-accounts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    bankName: z.string().min(1),
    accountNo: z.string().min(1),
    accountId: z.string().uuid(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const bankName = parsed.data.bankName.trim();
  const accountNo = parsed.data.accountNo.trim();
  const accountId = parsed.data.accountId;

  const exists = (
    await sql`
      SELECT 1
      FROM accounts
      WHERE id = ${accountId} AND org_id = ${orgId}
      LIMIT 1
    `
  )[0] as any;
  if (!exists) {
    res.status(400).json({ success: false, error: "Invalid account" });
    return;
  }

  try {
    const row = (
      await sql`
        INSERT INTO bank_accounts (org_id, bank_name, account_no, account_id)
        VALUES (${orgId}, ${bankName}, ${accountNo}, ${accountId})
        RETURNING id, bank_name as "bankName", account_no as "accountNo", account_id as "accountId", is_active as "isActive"
      `
    )[0];
    res.status(200).json({ success: true, data: { bankAccount: row } });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("duplicate key")) {
      res.status(409).json({ success: false, error: "Bank account already exists" });
      return;
    }
    throw e;
  }
});

router.patch("/bank-accounts/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    bankName: z.string().min(1).optional(),
    accountNo: z.string().min(1).optional(),
    accountId: z.string().uuid().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ success: false, error: "No changes" });
    return;
  }

  const sql = getSql();
  const id = req.params.id;

  const bankName = parsed.data.bankName?.trim();
  const accountNo = parsed.data.accountNo?.trim();
  const accountId = parsed.data.accountId;
  const isActive = parsed.data.isActive;

  if (accountId) {
    const exists = (
      await sql`
        SELECT 1
        FROM accounts
        WHERE id = ${accountId} AND org_id = ${orgId}
        LIMIT 1
      `
    )[0] as any;
    if (!exists) {
      res.status(400).json({ success: false, error: "Invalid account" });
      return;
    }
  }

  try {
    const row = (
      await sql`
        UPDATE bank_accounts
        SET
          bank_name = COALESCE(${bankName ?? null}, bank_name),
          account_no = COALESCE(${accountNo ?? null}, account_no),
          account_id = COALESCE(${accountId ?? null}, account_id),
          is_active = COALESCE(${isActive ?? null}, is_active)
        WHERE id = ${id} AND org_id = ${orgId}
        RETURNING id, bank_name as "bankName", account_no as "accountNo", account_id as "accountId", is_active as "isActive"
      `
    )[0];
    if (!row) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }
    res.status(200).json({ success: true, data: { bankAccount: row } });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.includes("duplicate key")) {
      res.status(409).json({ success: false, error: "Bank account already exists" });
      return;
    }
    throw e;
  }
});

export default router;
