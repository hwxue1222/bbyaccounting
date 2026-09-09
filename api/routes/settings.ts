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

router.get("/accounts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrg(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT id, code, name, type, normal_balance as "normalBalance", is_active as "isActive"
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
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const row = (
    await sql`
      INSERT INTO accounts (org_id, code, name, type, normal_balance)
      VALUES (${orgId}, ${parsed.data.code.trim()}, ${parsed.data.name.trim()}, ${parsed.data.type}, ${parsed.data.normalBalance})
      RETURNING id, code, name, type, normal_balance as "normalBalance", is_active as "isActive"
    `
  )[0];
  res.status(200).json({ success: true, data: { account: row } });
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
  const bodySchema = z.object({ isEnabled: z.boolean() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const id = req.params.id;
  const row = (
    await sql`
      UPDATE currencies
      SET is_enabled = ${parsed.data.isEnabled}
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING id, code, is_enabled as "isEnabled"
    `
  )[0];
  if (!row) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  res.status(200).json({ success: true, data: { currency: row } });
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

export default router;
