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

router.get("/stock-take/items", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT
      i.id,
      i.sku,
      i.name,
      i.uom as "uom",
      COALESCE(SUM(l.qty_remaining), 0) as qty,
      COALESCE(SUM(l.qty_remaining * l.unit_cost_base), 0) as "valueBase",
      (
        SELECT m.unit_cost_base
        FROM inventory_moves m
        WHERE m.org_id = i.org_id AND m.item_id = i.id AND m.status = 'posted' AND m.move_type = 'receipt'
        ORDER BY m.move_date DESC, m.created_at DESC, m.id DESC
        LIMIT 1
      ) as "latestUnitCostBase"
    FROM inventory_items i
    LEFT JOIN inventory_layers l ON l.org_id = i.org_id AND l.item_id = i.id
    WHERE i.org_id = ${orgId} AND i.is_active = true
    GROUP BY i.id
    ORDER BY i.sku ASC NULLS LAST, i.name ASC
  `;
  res.status(200).json({ success: true, data: { items: rows } });
});

router.post("/stock-take/preview", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    date: z.string().min(10),
    lines: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          countedQty: z.number().nonnegative(),
          gainUnitCostBase: z.number().nonnegative().optional(),
        }),
      )
      .min(1),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const itemIds = Array.from(new Set(parsed.data.lines.map((l) => l.itemId)));
  const items = (await sql`
    SELECT id, sku, name, uom
    FROM inventory_items
    WHERE org_id = ${orgId} AND id = ANY(${sql.array(itemIds)}::uuid[])
  `) as any[];
  const itemById = new Map(items.map((it) => [String(it.id), it]));
  if (itemById.size !== itemIds.length) {
    res.status(400).json({ success: false, error: "Item not found" });
    return;
  }

  const layersByItem = new Map<string, Array<{ id: string; qtyRemaining: number; unitCostBase: number; receivedDate: string }>>();
  const layers = (await sql`
    SELECT id, item_id as "itemId", qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
    FROM inventory_layers
    WHERE org_id = ${orgId} AND item_id = ANY(${sql.array(itemIds)}::uuid[]) AND qty_remaining > 0
    ORDER BY item_id ASC, received_date ASC, created_at ASC
  `) as any[];
  for (const row of layers) {
    const k = String(row.itemId);
    const arr = layersByItem.get(k) || [];
    arr.push({ id: String(row.id), qtyRemaining: Number(row.qtyRemaining) || 0, unitCostBase: Number(row.unitCostBase) || 0, receivedDate: String(row.receivedDate) });
    layersByItem.set(k, arr);
  }

  const rows = parsed.data.lines.map((l) => {
    const it = itemById.get(l.itemId)!;
    const layers = layersByItem.get(l.itemId) || [];
    const onHandQty = round6(layers.reduce((s, x) => s + (Number(x.qtyRemaining) || 0), 0));
    const onHandValueBase = round2(layers.reduce((s, x) => s + (Number(x.qtyRemaining) || 0) * (Number(x.unitCostBase) || 0), 0));

    const countedQty = round6(Number(l.countedQty) || 0);
    const diffQty = round6(countedQty - onHandQty);

    if (diffQty < 0) {
      let remaining = round6(-diffQty);
      let costRemovedBase = 0;
      for (const row of layers) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(row.qtyRemaining) || 0);
        costRemovedBase = round2(costRemovedBase + take * (Number(row.unitCostBase) || 0));
        remaining = round6(remaining - take);
      }
      const closingValueBase = round2(onHandValueBase - costRemovedBase);
      return {
        itemId: l.itemId,
        itemSku: it.sku,
        itemName: it.name,
        uom: it.uom,
        onHandQty,
        countedQty,
        diffQty,
        adjustmentBase: -costRemovedBase,
        closingValueBase,
      };
    }

    if (diffQty > 0) {
      const gainUnitCostBase = Number(l.gainUnitCostBase) || 0;
      const gainValueBase = round2(diffQty * gainUnitCostBase);
      const closingValueBase = round2(onHandValueBase + gainValueBase);
      return {
        itemId: l.itemId,
        itemSku: it.sku,
        itemName: it.name,
        uom: it.uom,
        onHandQty,
        countedQty,
        diffQty,
        adjustmentBase: gainValueBase,
        closingValueBase,
      };
    }

    return {
      itemId: l.itemId,
      itemSku: it.sku,
      itemName: it.name,
      uom: it.uom,
      onHandQty,
      countedQty,
      diffQty,
      adjustmentBase: 0,
      closingValueBase: onHandValueBase,
    };
  });

  const totals = {
    onHandQty: round6(rows.reduce((s, r) => s + (Number(r.onHandQty) || 0), 0)),
    countedQty: round6(rows.reduce((s, r) => s + (Number(r.countedQty) || 0), 0)),
    adjustmentBase: round2(rows.reduce((s, r) => s + (Number(r.adjustmentBase) || 0), 0)),
    closingValueBase: round2(rows.reduce((s, r) => s + (Number(r.closingValueBase) || 0), 0)),
  };

  res.status(200).json({ success: true, data: { date: parsed.data.date, rows, totals } });
});

router.post("/stock-take", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const bodySchema = z.object({
    date: z.string().min(10),
    memo: z.string().trim().max(200).optional(),
    lines: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          countedQty: z.number().nonnegative(),
          gainUnitCostBase: z.number().nonnegative().optional(),
        }),
      )
      .min(1),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const itemIds = Array.from(new Set(parsed.data.lines.map((l) => l.itemId)));
  const items = (await sql`
    SELECT id, sku, name, uom, inventory_account_id as "inventoryAccountId", cogs_account_id as "cogsAccountId"
    FROM inventory_items
    WHERE org_id = ${orgId} AND id = ANY(${sql.array(itemIds)}::uuid[])
  `) as any[];
  const itemById = new Map(items.map((it) => [String(it.id), it]));
  if (itemById.size !== itemIds.length) {
    res.status(400).json({ success: false, error: "Item not found" });
    return;
  }

  const created = await sql.begin(async (trx) => {
    const invAcc = await trx`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1500' LIMIT 1`;
    const cogsAcc = await trx`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '5000' LIMIT 1`;

    for (const it of itemById.values()) {
      if (!it.inventoryAccountId) it.inventoryAccountId = invAcc[0]?.id || null;
      if (!it.cogsAccountId) it.cogsAccountId = cogsAcc[0]?.id || null;
      if (!it.inventoryAccountId || !it.cogsAccountId) {
        throw new Error("Missing inventory/COGS accounts");
      }
    }

    const voucherNo = await issueVoucherNo(trx, orgId);
    const memo = parsed.data.memo?.trim() ? parsed.data.memo.trim() : `Stock take ${parsed.data.date}`;
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, currency_code, fx_rate, memo, created_by, posted_at)
        VALUES (${orgId}, ${parsed.data.date}, 'posted', ${voucherNo}, 'BASE', 1, ${memo}, ${req.auth!.userId}, now())
        RETURNING id
      `
    )[0] as any;

    let lineNo = 1;
    const rowsOut: any[] = [];

    for (const l of parsed.data.lines) {
      const it = itemById.get(l.itemId)!;
      const layers = (await trx`
        SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
        FROM inventory_layers
        WHERE org_id = ${orgId} AND item_id = ${l.itemId} AND qty_remaining > 0
        ORDER BY received_date ASC, created_at ASC
        FOR UPDATE
      `) as any[];

      const onHandQty = round6(layers.reduce((s, x) => s + (Number(x.qtyRemaining) || 0), 0));
      const countedQty = round6(Number(l.countedQty) || 0);
      const diffQty = round6(countedQty - onHandQty);

      if (diffQty === 0) {
        rowsOut.push({ itemId: l.itemId, itemSku: it.sku, itemName: it.name, uom: it.uom, onHandQty, countedQty, diffQty, adjustmentBase: 0 });
        continue;
      }

      if (diffQty < 0) {
        let remaining = round6(-diffQty);
        const breakdown: Array<{ layerId: string; qty: number; unitCostBase: number; amountBase: number }> = [];
        for (const row of layers as any[]) {
          if (remaining <= 0) break;
          const qtyAvail = Number(row.qtyRemaining) || 0;
          const take = Math.min(remaining, qtyAvail);
          const unitCostBase = Number(row.unitCostBase) || 0;
          const amountBase = round2(take * unitCostBase);
          breakdown.push({ layerId: String(row.id), qty: take, unitCostBase, amountBase });
          remaining = round6(remaining - take);
        }
        if (remaining > 0) {
          throw new Error("Insufficient stock");
        }
        const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));

        for (const b of breakdown) {
          await trx`
            UPDATE inventory_layers
            SET qty_remaining = qty_remaining - ${b.qty}
            WHERE id = ${b.layerId} AND org_id = ${orgId}
          `;
        }

        await trx`
          INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
          VALUES (${orgId}, ${entry.id}, ${lineNo}, ${it.cogsAccountId}, 'Stock take shrinkage', 0, 0, ${totalBase}, 0, ${l.itemId})
        `;
        lineNo += 1;
        await trx`
          INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
          VALUES (${orgId}, ${entry.id}, ${lineNo}, ${it.inventoryAccountId}, 'Stock take inventory decrease', 0, 0, 0, ${totalBase}, ${l.itemId})
        `;
        lineNo += 1;

        let entrySeq = 1;
        for (const b of breakdown) {
          await trx`
            INSERT INTO inventory_moves (
              org_id, item_id, move_type, move_date, qty,
              unit_cost_base, unit_cost_txn, currency_code, fx_rate, status,
              entry_id, source_layer_id, entry_seq
            ) VALUES (
              ${orgId},
              ${l.itemId},
              'shipment',
              ${parsed.data.date},
              ${b.qty},
              ${b.unitCostBase},
              NULL,
              'BASE',
              1,
              'posted',
              ${entry.id},
              ${b.layerId},
              ${entrySeq}
            )
          `;
          entrySeq += 1;
        }

        rowsOut.push({ itemId: l.itemId, itemSku: it.sku, itemName: it.name, uom: it.uom, onHandQty, countedQty, diffQty, adjustmentBase: -totalBase, breakdown });
        continue;
      }

      const gainUnitCostBase = Number(l.gainUnitCostBase) || 0;
      const unitCostBase = round6(gainUnitCostBase);
      const totalBase = round2(unitCostBase * diffQty);

      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo}, ${it.inventoryAccountId}, 'Stock take inventory increase', 0, 0, ${totalBase}, 0, ${l.itemId})
      `;
      lineNo += 1;
      await trx`
        INSERT INTO journal_lines (org_id, entry_id, line_no, account_id, description, debit_txn, credit_txn, debit_base, credit_base, inventory_item_id)
        VALUES (${orgId}, ${entry.id}, ${lineNo}, ${it.cogsAccountId}, 'Stock take gain', 0, 0, 0, ${totalBase}, ${l.itemId})
      `;
      lineNo += 1;

      const insertedMove = (
        await trx`
          INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, entry_id, unit_cost_txn, currency_code, fx_rate, status, entry_seq)
          VALUES (${orgId}, ${l.itemId}, 'receipt', ${parsed.data.date}, ${diffQty}, ${unitCostBase}, ${entry.id}, NULL, 'BASE', 1, 'posted', 1)
          RETURNING id
        `
      )[0] as any;
      const layer = (
        await trx`
          INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id, source_move_id)
          VALUES (${orgId}, ${l.itemId}, ${parsed.data.date}, ${diffQty}, ${unitCostBase}, ${entry.id}, ${insertedMove.id})
          RETURNING id
        `
      )[0] as any;
      await trx`UPDATE inventory_moves SET created_layer_id = ${layer.id} WHERE org_id = ${orgId} AND id = ${insertedMove.id}`;

      rowsOut.push({ itemId: l.itemId, itemSku: it.sku, itemName: it.name, uom: it.uom, onHandQty, countedQty, diffQty, adjustmentBase: totalBase, gainUnitCostBase: unitCostBase });
    }

    const totalAdjustmentBase = round2(rowsOut.reduce((s, r) => s + (Number(r.adjustmentBase) || 0), 0));
    return { entryId: entry.id, voucherNo, rows: rowsOut, totalAdjustmentBase };
  });

  res.status(200).json({ success: true, data: created });
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
            m.entry_seq as "entrySeq",
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
          ORDER BY m.move_date DESC, m.created_at DESC, m.entry_seq DESC NULLS LAST, m.id DESC
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
            m.entry_seq as "entrySeq",
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
          ORDER BY m.move_date DESC, m.created_at DESC, m.entry_seq DESC NULLS LAST, m.id DESC
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
        INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, entry_id, unit_cost_txn, currency_code, fx_rate, status, entry_seq)
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
          , 1
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

    let entrySeq = 1;
    for (const b of breakdown) {
      await trx`
        INSERT INTO inventory_moves (
          org_id, item_id, move_type, move_date, qty,
          unit_cost_base, unit_cost_txn, currency_code, fx_rate, status,
          entry_id, source_layer_id, entry_seq
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
          ${b.layerId},
          ${entrySeq}
        )
      `;
      entrySeq += 1;
    }

    return { entryId: entry.id };
  });

  res.status(200).json({ success: true, data: { entryId: created.entryId, totalBase, breakdown } });
});

export default router;
