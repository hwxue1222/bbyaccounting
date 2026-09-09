import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2, round6 } from "../lib/nums.js";
import { issueVoucherNo } from "../lib/voucher.js";

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
    ORDER BY sku ASC NULLS LAST, name ASC
  `;
  res.status(200).json({ success: true, data: { items: rows } });
});

router.post("/items", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    sku: z.string().trim().min(1),
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
        ${parsed.data.sku.trim()},
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
  const entryId = typeof req.query.entryId === "string" ? req.query.entryId : null;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
  const limit = typeof req.query.limit === "string" ? Math.min(200, Math.max(1, Number(req.query.limit) || 50)) : 50;
  const sql = getSql();

  const dateCond =
    startDate && endDate
      ? sql`AND m.move_date >= ${startDate} AND m.move_date <= ${endDate}`
      : startDate
        ? sql`AND m.move_date >= ${startDate}`
        : endDate
          ? sql`AND m.move_date <= ${endDate}`
          : sql``;

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
            m.entry_line_no as "entryLineNo",
            e.voucher_no as "voucherNo",
            i.id as "itemId",
            i.sku as "itemSku",
            i.name as "itemName",
            i.uom as "uom"
          FROM inventory_moves m
          JOIN inventory_items i ON i.id = m.item_id AND i.org_id = m.org_id
          LEFT JOIN journal_entries e ON e.id = m.entry_id AND e.org_id = m.org_id
          WHERE m.org_id = ${orgId} AND m.status = ${status}
            ${itemId ? sql`AND m.item_id = ${itemId}` : sql``}
            ${entryId ? sql`AND m.entry_id = ${entryId}` : sql``}
            ${dateCond}
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
            m.entry_line_no as "entryLineNo",
            e.voucher_no as "voucherNo",
            i.id as "itemId",
            i.sku as "itemSku",
            i.name as "itemName",
            i.uom as "uom"
          FROM inventory_moves m
          JOIN inventory_items i ON i.id = m.item_id AND i.org_id = m.org_id
          LEFT JOIN journal_entries e ON e.id = m.entry_id AND e.org_id = m.org_id
          WHERE m.org_id = ${orgId}
            ${itemId ? sql`AND m.item_id = ${itemId}` : sql``}
            ${entryId ? sql`AND m.entry_id = ${entryId}` : sql``}
            ${dateCond}
          ORDER BY m.move_date DESC, m.created_at DESC
          LIMIT ${limit}
        `;

  res.status(200).json({ success: true, data: { moves: rows } });
});

router.get("/moves/balances", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const itemId = typeof req.query.itemId === "string" ? req.query.itemId : null;
  if (!startDate || !endDate) {
    res.status(400).json({ success: false, error: "Missing startDate/endDate" });
    return;
  }
  const sql = getSql();
  const statusCond = status === "draft" || status === "posted" ? sql`AND m.status = ${status}` : sql``;
  const itemCond = itemId ? sql`AND m.item_id = ${itemId}` : sql``;

  const rows = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN m.move_date < ${startDate} THEN (CASE WHEN m.move_type = 'shipment' THEN -m.qty ELSE m.qty END) ELSE 0 END), 0) as "openingQty",
      COALESCE(SUM(CASE WHEN m.move_date < ${startDate} THEN (CASE WHEN m.move_type = 'shipment' THEN -m.qty * COALESCE(m.unit_cost_base, 0) ELSE m.qty * COALESCE(m.unit_cost_base, 0) END) ELSE 0 END), 0) as "openingValueBase",
      COALESCE(SUM(CASE WHEN m.move_date >= ${startDate} AND m.move_date <= ${endDate} AND m.move_type = 'receipt' THEN m.qty ELSE 0 END), 0) as "inQty",
      COALESCE(SUM(CASE WHEN m.move_date >= ${startDate} AND m.move_date <= ${endDate} AND m.move_type = 'receipt' THEN m.qty * COALESCE(m.unit_cost_base, 0) ELSE 0 END), 0) as "inValueBase",
      COALESCE(SUM(CASE WHEN m.move_date >= ${startDate} AND m.move_date <= ${endDate} AND m.move_type = 'shipment' THEN m.qty ELSE 0 END), 0) as "outQty",
      COALESCE(SUM(CASE WHEN m.move_date >= ${startDate} AND m.move_date <= ${endDate} AND m.move_type = 'shipment' THEN m.qty * COALESCE(m.unit_cost_base, 0) ELSE 0 END), 0) as "outValueBase"
    FROM inventory_moves m
    WHERE m.org_id = ${orgId} ${statusCond} ${itemCond}
  `;

  const r = rows[0] as any;
  const openingQty = Number(r.openingQty) || 0;
  const openingValueBase = Number(r.openingValueBase) || 0;
  const inQty = Number(r.inQty) || 0;
  const inValueBase = Number(r.inValueBase) || 0;
  const outQty = Number(r.outQty) || 0;
  const outValueBase = Number(r.outValueBase) || 0;
  const closingQty = openingQty + inQty - outQty;
  const closingValueBase = openingValueBase + inValueBase - outValueBase;

  res.status(200).json({
    success: true,
    data: {
      startDate,
      endDate,
      openingQty,
      openingValueBase,
      inQty,
      inValueBase,
      outQty,
      outValueBase,
      closingQty,
      closingValueBase,
    },
  });
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
    const voucherNo = await issueVoucherNo(trx, orgId);
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', ${voucherNo}, ${parsed.data.currency.toUpperCase()}, ${parsed.data.fxRate}, ${parsed.data.memo || 'Inventory receipt'}, ${req.auth!.userId}, now())
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

    const insertedMove = (
      await trx`
        INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, entry_id, unit_cost_txn, currency_code, fx_rate, status)
        VALUES (
          ${orgId},
          ${parsed.data.itemId},
          'receipt',
          ${parsed.data.date},
          ${parsed.data.qty},
          ${unitCostBase},
          ${entry.id},
          ${round6(parsed.data.unitCostTxn)},
          ${parsed.data.currency.toUpperCase()},
          ${parsed.data.fxRate},
          'posted'
        )
        RETURNING id
      `
    )[0] as any;
    const layer = (
      await trx`
        INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id, source_move_id)
        VALUES (${orgId}, ${parsed.data.itemId}, ${parsed.data.date}, ${parsed.data.qty}, ${unitCostBase}, ${entry.id}, ${insertedMove.id})
        RETURNING id
      `
    )[0] as any;
    await trx`
      UPDATE inventory_moves
      SET created_layer_id = ${layer.id}
      WHERE org_id = ${orgId} AND id = ${insertedMove.id}
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
    const voucherNo = await issueVoucherNo(trx, orgId);
    for (const b of breakdown) {
      await trx`
        UPDATE inventory_layers
        SET qty_remaining = qty_remaining - ${b.qty}
        WHERE id = ${b.layerId} AND org_id = ${orgId}
      `;
    }

    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', ${voucherNo}, 'BASE', 1, ${parsed.data.memo || 'Inventory shipment (FIFO COGS)'}, ${req.auth!.userId}, now())
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

    for (const b of breakdown) {
      await trx`
        INSERT INTO inventory_moves (
          org_id, item_id, move_type, move_date, qty,
          unit_cost_base, unit_cost_txn, currency_code, fx_rate, status,
          entry_id, source_layer_id
        ) VALUES (
          ${orgId},
          ${parsed.data.itemId},
          'shipment',
          ${parsed.data.date},
          ${b.qty},
          ${b.unitCostBase},
          NULL,
          'BASE',
          1,
          'posted',
          ${entry.id},
          ${b.layerId}
        )
      `;
    }

    return { entryId: entry.id };
  });

  res.status(200).json({ success: true, data: { entryId: created.entryId, totalBase, breakdown } });
});

export default router;
