import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2, round6 } from "../lib/nums.js";

const router = Router();

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

router.get("/items", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT id, sku, name, uom as "uom", inventory_account_id as "inventoryAccountId", cogs_account_id as "cogsAccountId"
    FROM inventory_items
    WHERE org_id = ${orgId} AND is_active = true
    ORDER BY name ASC
  `;
  res.status(200).json({ success: true, data: { items: rows } });
});

router.post("/items", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    sku: z.string().optional(),
    name: z.string().min(1),
    uom: z.string().min(1).default("EA"),
    inventoryAccountId: z.string().uuid().optional(),
    cogsAccountId: z.string().uuid().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const row = (
    await sql`
      INSERT INTO inventory_items (org_id, sku, name, uom, inventory_account_id, cogs_account_id)
      VALUES (
        ${orgId},
        ${parsed.data.sku || null},
        ${parsed.data.name.trim()},
        ${parsed.data.uom.trim()},
        ${parsed.data.inventoryAccountId || null},
        ${parsed.data.cogsAccountId || null}
      )
      RETURNING id, sku, name, uom as "uom", inventory_account_id as "inventoryAccountId", cogs_account_id as "cogsAccountId"
    `
  )[0];
  res.status(200).json({ success: true, data: { item: row } });
});

router.get("/stock", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const itemId = typeof req.query.itemId === "string" ? req.query.itemId : null;
  if (!itemId) {
    res.status(400).json({ success: false, error: "Missing itemId" });
    return;
  }
  const sql = getSql();
  const rows = await sql`
    SELECT
      COALESCE(SUM(qty_remaining), 0) as qty,
      COALESCE(SUM(qty_remaining * unit_cost_base), 0) as "valueBase"
    FROM inventory_layers
    WHERE org_id = ${orgId} AND item_id = ${itemId}
  `;
  const qty = Number((rows[0] as any).qty);
  const valueBase = Number((rows[0] as any).valueBase);
  res.status(200).json({ success: true, data: { itemId, qty, valueBase } });
});

router.get("/moves", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const itemId = typeof req.query.itemId === "string" ? req.query.itemId : null;
  const limit = typeof req.query.limit === "string" ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50;
  const sql = getSql();

  const rows =
    status === "draft" || status === "posted"
      ? await sql`
          SELECT
            m.id,
            m.move_type as "moveType",
            to_char(m.move_date, 'YYYY-MM-DD') as "moveDate",
            m.qty,
            m.unit_cost_base as "unitCostBase",
            m.unit_cost_txn as "unitCostTxn",
            m.currency_code as "currency",
            m.fx_rate as "fxRate",
            m.status,
            m.entry_id as "entryId",
            i.id as "itemId",
            i.name as "itemName",
            i.uom as "uom"
          FROM inventory_moves m
          JOIN inventory_items i ON i.id = m.item_id AND i.org_id = m.org_id
          WHERE m.org_id = ${orgId} AND m.status = ${status} ${itemId ? sql`AND m.item_id = ${itemId}` : sql``}
          ORDER BY m.move_date DESC, m.created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT
            m.id,
            m.move_type as "moveType",
            to_char(m.move_date, 'YYYY-MM-DD') as "moveDate",
            m.qty,
            m.unit_cost_base as "unitCostBase",
            m.unit_cost_txn as "unitCostTxn",
            m.currency_code as "currency",
            m.fx_rate as "fxRate",
            m.status,
            m.entry_id as "entryId",
            i.id as "itemId",
            i.name as "itemName",
            i.uom as "uom"
          FROM inventory_moves m
          JOIN inventory_items i ON i.id = m.item_id AND i.org_id = m.org_id
          WHERE m.org_id = ${orgId} ${itemId ? sql`AND m.item_id = ${itemId}` : sql``}
          ORDER BY m.move_date DESC, m.created_at DESC
          LIMIT ${limit}
        `;

  res.status(200).json({ success: true, data: { moves: rows } });
});

router.get("/shipments/quote", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const itemId = typeof req.query.itemId === "string" ? req.query.itemId : null;
  const qty = typeof req.query.qty === "string" ? Number(req.query.qty) : NaN;
  if (!itemId) {
    res.status(400).json({ success: false, error: "Missing itemId" });
    return;
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    res.status(400).json({ success: false, error: "Invalid qty" });
    return;
  }

  const sql = getSql();
  const layers = await sql`
    SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
    FROM inventory_layers
    WHERE org_id = ${orgId} AND item_id = ${itemId} AND qty_remaining > 0
    ORDER BY received_date ASC, created_at ASC
  `;

  let remaining = qty;
  const breakdown: Array<{ layerId: string; receivedDate: string; qty: number; unitCostBase: number; amountBase: number }> = [];
  for (const row of layers as any[]) {
    if (remaining <= 0) break;
    const qtyAvail = Number(row.qtyRemaining);
    const take = Math.min(remaining, qtyAvail);
    const unitCostBase = Number(row.unitCostBase);
    const amountBase = round2(take * unitCostBase);
    breakdown.push({ layerId: row.id, receivedDate: row.receivedDate, qty: take, unitCostBase, amountBase });
    remaining = round6(remaining - take);
  }
  if (remaining > 0) {
    res.status(400).json({ success: false, error: "Insufficient stock" });
    return;
  }
  const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));
  res.status(200).json({ success: true, data: { itemId, qty, totalBase, breakdown } });
});

router.post("/receipts", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const bodySchema = z.object({
    itemId: z.string().uuid(),
    date: z.string().min(10),
    qty: z.number().positive(),
    unitCostTxn: z.number().positive(),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    offsetAccountId: z.string().uuid(),
    memo: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();

  const itemRows = await sql`
    SELECT id, inventory_account_id as "inventoryAccountId"
    FROM inventory_items
    WHERE id = ${parsed.data.itemId} AND org_id = ${orgId}
    LIMIT 1
  `;
  const item = itemRows[0] as any;
  if (!item) {
    res.status(404).json({ success: false, error: "Item not found" });
    return;
  }
  if (!item.inventoryAccountId) {
    const invAcc = await sql`
      SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1500' LIMIT 1
    `;
    item.inventoryAccountId = invAcc[0]?.id || null;
  }
  if (!item.inventoryAccountId) {
    res.status(400).json({ success: false, error: "Missing inventory account" });
    return;
  }

  const unitCostBase = round6(parsed.data.unitCostTxn * parsed.data.fxRate);
  const totalBase = round2(unitCostBase * parsed.data.qty);

  const created = await sql.begin(async (trx) => {
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', ${parsed.data.currency.toUpperCase()}, ${parsed.data.fxRate}, ${parsed.data.memo || 'Inventory receipt'}, ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
      VALUES (${orgId}, ${entry.id}, 1, ${item.inventoryAccountId}, 'Inventory receipt', ${round2(parsed.data.unitCostTxn * parsed.data.qty)}, 0, ${totalBase}, 0, ${parsed.data.itemId})
    `;
    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base)
      VALUES (${orgId}, ${entry.id}, 2, ${parsed.data.offsetAccountId}, 'Inventory receipt offset', 0, ${round2(parsed.data.unitCostTxn * parsed.data.qty)}, 0, ${totalBase})
    `;

    await trx`
      INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id)
      VALUES (${orgId}, ${parsed.data.itemId}, ${parsed.data.date}, ${parsed.data.qty}, ${unitCostBase}, ${entry.id})
    `;
    await trx`
      INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, entry_id)
      VALUES (${orgId}, ${parsed.data.itemId}, 'receipt', ${parsed.data.date}, ${parsed.data.qty}, ${unitCostBase}, ${entry.id})
    `;
    await trx`
      UPDATE inventory_moves
      SET unit_cost_txn = ${round6(parsed.data.unitCostTxn)}, currency_code = ${parsed.data.currency.toUpperCase()}, fx_rate = ${parsed.data.fxRate}, status = 'posted'
      WHERE org_id = ${orgId} AND entry_id = ${entry.id} AND item_id = ${parsed.data.itemId} AND move_type = 'receipt'
    `;

    return { entryId: entry.id };
  });

  res.status(200).json({ success: true, data: { entryId: created.entryId, totalBase, unitCostBase } });
});

router.post("/shipments", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    itemId: z.string().uuid(),
    date: z.string().min(10),
    qty: z.number().positive(),
    memo: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();

  const itemRows = await sql`
    SELECT id, inventory_account_id as "inventoryAccountId", cogs_account_id as "cogsAccountId"
    FROM inventory_items
    WHERE id = ${parsed.data.itemId} AND org_id = ${orgId}
    LIMIT 1
  `;
  const item = itemRows[0] as any;
  if (!item) {
    res.status(404).json({ success: false, error: "Item not found" });
    return;
  }
  if (!item.inventoryAccountId) {
    const invAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1500' LIMIT 1`;
    item.inventoryAccountId = invAcc[0]?.id || null;
  }
  if (!item.cogsAccountId) {
    const cogsAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '5000' LIMIT 1`;
    item.cogsAccountId = cogsAcc[0]?.id || null;
  }
  if (!item.inventoryAccountId || !item.cogsAccountId) {
    res.status(400).json({ success: false, error: "Missing inventory/COGS accounts" });
    return;
  }

  const layers = await sql`
    SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
    FROM inventory_layers
    WHERE org_id = ${orgId} AND item_id = ${parsed.data.itemId} AND qty_remaining > 0
    ORDER BY received_date ASC, created_at ASC
  `;

  let remaining = parsed.data.qty;
  const breakdown: Array<{ layerId: string; receivedDate: string; qty: number; unitCostBase: number; amountBase: number }> = [];
  for (const row of layers as any[]) {
    if (remaining <= 0) break;
    const qtyAvail = Number(row.qtyRemaining);
    const take = Math.min(remaining, qtyAvail);
    const unitCostBase = Number(row.unitCostBase);
    const amountBase = round2(take * unitCostBase);
    breakdown.push({ layerId: row.id, receivedDate: row.receivedDate, qty: take, unitCostBase, amountBase });
    remaining = round6(remaining - take);
  }
  if (remaining > 0) {
    res.status(400).json({ success: false, error: "Insufficient stock" });
    return;
  }
  const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));

  const created = await sql.begin(async (trx) => {
    for (const b of breakdown) {
      await trx`
        UPDATE inventory_layers
        SET qty_remaining = qty_remaining - ${b.qty}
        WHERE id = ${b.layerId} AND org_id = ${orgId}
      `;
    }

    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', 'BASE', 1, ${parsed.data.memo || 'Inventory shipment (FIFO COGS)'}, ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
      VALUES (${orgId}, ${entry.id}, 1, ${item.cogsAccountId}, 'COGS (FIFO)', 0, 0, ${totalBase}, 0, ${parsed.data.itemId})
    `;
    await trx`
      INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
      VALUES (${orgId}, ${entry.id}, 2, ${item.inventoryAccountId}, 'Inventory decrease (FIFO)', 0, 0, 0, ${totalBase}, ${parsed.data.itemId})
    `;

    await trx`
      INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, entry_id)
      VALUES (${orgId}, ${parsed.data.itemId}, 'shipment', ${parsed.data.date}, ${parsed.data.qty}, ${round6(totalBase / parsed.data.qty)}, ${entry.id})
    `;
    await trx`
      UPDATE inventory_moves
      SET currency_code = 'BASE', fx_rate = 1, status = 'posted'
      WHERE org_id = ${orgId} AND entry_id = ${entry.id} AND item_id = ${parsed.data.itemId} AND move_type = 'shipment'
    `;

    return { entryId: entry.id };
  });

  res.status(200).json({ success: true, data: { entryId: created.entryId, totalBase, breakdown } });
});

export default router;
