import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "crypto";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2, round6 } from "../lib/nums.js";
import { issueVoucherNo } from "../lib/voucher.js";
import { FIXED_ASSET_CATEGORIES, issueFixedAssetNo, normalizeFixedAssetCategory } from "../lib/fixedAssetNo.js";

const router = Router();
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

const recurringSchema = z.object({
  everyMonths: z.number().int().min(1).max(24),
  count: z.number().int().min(1).max(120),
});

const fixedAssetDisposalSchema = z.object({
  costLineNo: z.number().int().positive(),
  accumDepLineNo: z.number().int().positive(),
});

function makeErrorId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function mapPgError(e: any): { status: number; message: string; errorId: string } | null {
  const code = typeof e?.code === "string" ? e.code : null;
  if (!code) return null;

  const id = makeErrorId();

  if (code === "22P02") return { status: 400, message: `字段格式不正确（ID ${id}）`, errorId: id };
  if (code === "22023") return { status: 400, message: `参数不合法（ID ${id}）`, errorId: id };
  if (code === "23502") return { status: 400, message: `缺少必填字段（ID ${id}）`, errorId: id };
  if (code === "23505") return { status: 409, message: `数据重复（唯一约束冲突，ID ${id}）`, errorId: id };
  if (code === "40001") return { status: 409, message: `并发冲突，请重试（ID ${id}）`, errorId: id };
  if (code === "42P01") return { status: 500, message: `数据库表缺失（可能迁移未完成，ID ${id}）`, errorId: id };
  if (code === "42703") return { status: 500, message: `数据库字段缺失（可能迁移未完成，ID ${id}）`, errorId: id };
  return { status: 500, message: `数据库错误 ${code}（ID ${id}）`, errorId: id };
}

async function tryLogError(sql: any, input: { id: string; orgId: string | null; userId: string | null; route: string; message: string; stack?: string | null }) {
  try {
    await sql`
      INSERT INTO error_logs (id, org_id, user_id, route, message, stack)
      VALUES (${input.id}, ${input.orgId}, ${input.userId}, ${input.route}, ${input.message}, ${input.stack || null})
    `;
  } catch {
    // ignore
  }
}

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
}

function isSystemAutoLine(desc: unknown): boolean {
  const d = typeof desc === "string" ? desc.trim() : "";
  return d === "COGS (FIFO)" || d === "Inventory (FIFO)";
}

async function insertPostedInventoryReceipts(
  trx: any,
  orgId: string,
  entryId: string,
  linkLineNo: number,
  entryDate: string,
  currency: string,
  fxRate: number,
  details: Array<{ itemId: string; qty: number; unitCostTxn: number }>,
) {
  if (!details.length) return;
  const fx = Number(fxRate) || 1;
  const currencyCode = String(currency || "BASE").toUpperCase();

  const itemIds = details.map((d) => String(d.itemId));
  const qtys = details.map((d) => Number(d.qty));
  const unitCostsTxn = details.map((d) => round6(Number(d.unitCostTxn)));
  const unitCostsBase = details.map((d, i) => round6(Number(unitCostsTxn[i]) * fx));
  const entrySeqs = details.map((_, i) => i + 1);

  await trx`
    WITH ins_moves AS (
      INSERT INTO inventory_moves (
        org_id, item_id, move_type, move_date, qty,
        unit_cost_base, unit_cost_txn, currency_code, fx_rate,
        status, entry_id, entry_line_no, entry_seq
      )
      SELECT
        ${orgId},
        x.item_id,
        'receipt',
        ${entryDate},
        x.qty,
        x.unit_cost_base,
        x.unit_cost_txn,
        ${currencyCode},
        ${fx},
        'posted',
        ${entryId},
        ${linkLineNo},
        x.entry_seq
      FROM (
        SELECT
          unnest(${itemIds}::uuid[]) as item_id,
          unnest(${qtys}::numeric[]) as qty,
          unnest(${unitCostsBase}::numeric[]) as unit_cost_base,
          unnest(${unitCostsTxn}::numeric[]) as unit_cost_txn,
          unnest(${entrySeqs}::int[]) as entry_seq
      ) x
      RETURNING id, org_id, item_id, move_date, qty, unit_cost_base, entry_id
    ),
    ins_layers AS (
      INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id, source_move_id)
      SELECT org_id, item_id, move_date, qty, unit_cost_base, entry_id, id
      FROM ins_moves
      RETURNING id, source_move_id
    )
    UPDATE inventory_moves m
    SET created_layer_id = l.id
    FROM ins_layers l
    WHERE m.org_id = ${orgId} AND m.id = l.source_move_id
  `;
}

async function rollbackInventoryByEntryId(trx: any, orgId: string, entryId: string) {
  const shipmentAgg = (await trx`
    SELECT
      source_layer_id as "layerId",
      SUM(qty) as "qty"
    FROM inventory_moves
    WHERE org_id = ${orgId} AND entry_id = ${entryId} AND status = 'posted' AND move_type = 'shipment'
    GROUP BY source_layer_id
  `) as any[];

  for (const r of shipmentAgg) {
    const layerId = r.layerId ? String(r.layerId) : null;
    const qty = Number(r.qty);
    if (!layerId) throw new Error("Cannot rollback shipment without source_layer_id");
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Invalid shipment qty");
  }

  if (shipmentAgg.length) {
    const layerIds = shipmentAgg.map((r) => String(r.layerId));
    const qtys = shipmentAgg.map((r) => Number(r.qty));
    const rows = await trx`
      SELECT id
      FROM inventory_layers
      WHERE org_id = ${orgId} AND id = ANY(${layerIds}::uuid[])
      FOR UPDATE
    `;
    const exists = new Set((rows as any[]).map((x) => String(x.id)));
    for (const id of layerIds) {
      if (!exists.has(id)) throw new Error("Shipment layer missing");
    }
    await trx`
      UPDATE inventory_layers l
      SET qty_remaining = l.qty_remaining + x.qty
      FROM (
        SELECT unnest(${layerIds}::uuid[]) as id, unnest(${qtys}::numeric[]) as qty
      ) x
      WHERE l.org_id = ${orgId} AND l.id = x.id
    `;
  }

  const receiptMoves = (await trx`
    SELECT
      id,
      created_layer_id as "createdLayerId",
      item_id as "itemId",
      move_date as "moveDate",
      unit_cost_base as "unitCostBase",
      qty
    FROM inventory_moves
    WHERE org_id = ${orgId} AND entry_id = ${entryId} AND status = 'posted' AND move_type = 'receipt'
  `) as any[];

  if (receiptMoves.length) {
    const missingMoveIds: string[] = [];
    const layerIdByMoveId = new Map<string, string>();

    for (const m of receiptMoves) {
      const moveId = String(m.id);
      const layerId = m.createdLayerId ? String(m.createdLayerId) : null;
      if (layerId) {
        layerIdByMoveId.set(moveId, layerId);
      } else {
        missingMoveIds.push(moveId);
      }
    }

    if (missingMoveIds.length) {
      const rows = (await trx`
        SELECT source_move_id as "moveId", id as "layerId", qty_remaining as "qtyRemaining"
        FROM inventory_layers
        WHERE org_id = ${orgId} AND source_move_id = ANY(${missingMoveIds}::uuid[])
        FOR UPDATE
      `) as any[];

      const foundByMove = new Map<string, { layerId: string; qtyRemaining: number }>();
      for (const r of rows) {
        const moveId = String(r.moveId);
        const layerId = String(r.layerId);
        const qtyRemaining = Number(r.qtyRemaining);
        if (foundByMove.has(moveId)) {
          throw new Error("Cannot rollback receipt: multiple layers for one move");
        }
        foundByMove.set(moveId, { layerId, qtyRemaining });
      }

      const entryLayers = (await trx`
        SELECT id as "layerId", item_id as "itemId", received_date as "receivedDate", unit_cost_base as "unitCostBase", qty_remaining as "qtyRemaining"
        FROM inventory_layers
        WHERE org_id = ${orgId} AND source_entry_id = ${entryId}
        FOR UPDATE
      `) as any[];

      for (const moveId of missingMoveIds) {
        const found = foundByMove.get(moveId);
        if (!found) {
          const m = receiptMoves.find((x) => String(x.id) === moveId);
          const qty = m ? Number(m.qty) : NaN;
          const unitCostBase = m?.unitCostBase == null ? null : Number(m.unitCostBase);
          const candidates = m
            ? entryLayers.filter((l) => {
                if (String(l.itemId) !== String(m.itemId)) return false;
                if (String(l.receivedDate) !== String(m.moveDate)) return false;
                const rem = Number(l.qtyRemaining);
                if (!Number.isFinite(rem) || !Number.isFinite(qty)) return false;
                if (round6(rem) !== round6(qty)) return false;
                if (unitCostBase == null) return true;
                const uc = Number(l.unitCostBase);
                return Number.isFinite(uc) && round6(uc) === round6(unitCostBase);
              })
            : [];

          if (candidates.length === 1) {
            const layerId = String(candidates[0].layerId);
            layerIdByMoveId.set(moveId, layerId);
            await trx`
              UPDATE inventory_moves
              SET created_layer_id = ${layerId}
              WHERE org_id = ${orgId} AND id = ${moveId} AND created_layer_id IS NULL
            `;
            continue;
          }

          if (entryLayers.length === 0) {
            continue;
          }

          throw new Error("Cannot rollback receipt without created_layer_id (legacy entry)");
        }
        layerIdByMoveId.set(moveId, found.layerId);
        await trx`
          UPDATE inventory_moves
          SET created_layer_id = ${found.layerId}
          WHERE org_id = ${orgId} AND id = ${moveId} AND created_layer_id IS NULL
        `;
      }
    }

    const layerIds = receiptMoves
      .map((m) => {
        const moveId = String(m.id);
        const layerId = layerIdByMoveId.get(moveId);
        return layerId ? String(layerId) : null;
      })
      .filter(Boolean) as string[];

    if (layerIds.length) {
      const layers = (await trx`
        SELECT id, qty_remaining as "qtyRemaining"
        FROM inventory_layers
        WHERE org_id = ${orgId} AND id = ANY(${layerIds}::uuid[])
        FOR UPDATE
      `) as any[];

      const remainingById = new Map<string, number>();
      for (const l of layers) {
        remainingById.set(String(l.id), Number(l.qtyRemaining));
      }

      for (const m of receiptMoves) {
        const moveId = String(m.id);
        const layerId = layerIdByMoveId.get(moveId);
        if (!layerId) continue;
        const qty = Number(m.qty);
        const remaining = remainingById.get(layerId);
        if (remaining == null || !Number.isFinite(remaining)) throw new Error("Receipt layer missing");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("Invalid receipt qty");
        if (round6(remaining) !== round6(qty)) {
          throw new Error("Cannot rollback receipt: layer already consumed");
        }
      }

      await trx`DELETE FROM inventory_layers WHERE org_id = ${orgId} AND id = ANY(${layerIds}::uuid[])`;
    }
  }

  await trx`DELETE FROM inventory_moves WHERE org_id = ${orgId} AND entry_id = ${entryId} AND status = 'posted'`;
}

async function upsertSystemCogsEntry(
  trx: any,
  orgId: string,
  userId: string,
  parentEntryId: string,
  parentVoucherNo: string,
  entryDate: string,
  currency: string,
  fxRate: number,
  cogsAccId: string,
  invAccId: string,
  costCenterId: string | null,
  costTxn: number,
  costBase: number,
) {
  const voucherNo = `${parentVoucherNo}A`;

  const existing = await trx`
    SELECT id
    FROM journal_entries
    WHERE org_id = ${orgId} AND parent_entry_id = ${parentEntryId} AND is_system = true
    LIMIT 1
  `;
  if (existing.length) {
    const sysId = String((existing[0] as any).id);
    await trx`DELETE FROM journal_lines WHERE org_id = ${orgId} AND entry_id = ${sysId}`;
    await trx`DELETE FROM attachments WHERE org_id = ${orgId} AND entry_id = ${sysId}`;
    await trx`DELETE FROM journal_entries WHERE org_id = ${orgId} AND id = ${sysId}`;
  }

  const sysEntry = (
    await trx`
      INSERT INTO journal_entries (
        org_id, entry_date, status, voucher_no, parent_entry_id, is_system,
        currency_code, fx_rate, memo, created_by, inventory_impact, posted_at
      ) VALUES (
        ${orgId}, ${entryDate}, 'posted', ${voucherNo}, ${parentEntryId}, true,
        ${currency.toUpperCase()}, ${fxRate}, ${`Auto COGS for ${parentVoucherNo}`}, ${userId}, false, now()
      )
      RETURNING id
    `
  )[0] as any;

  await trx`
    INSERT INTO journal_lines (
      org_id, entry_id, line_no, account_id, description, cost_center_id,
      debit_txn, credit_txn, debit_base, credit_base
    ) VALUES (
      ${orgId}, ${sysEntry.id}, 1, ${cogsAccId}, 'COGS (FIFO)', ${costCenterId},
      ${costTxn}, 0, ${costBase}, 0
    )
  `;
  await trx`
    INSERT INTO journal_lines (
      org_id, entry_id, line_no, account_id, description, cost_center_id,
      debit_txn, credit_txn, debit_base, credit_base
    ) VALUES (
      ${orgId}, ${sysEntry.id}, 2, ${invAccId}, 'Inventory (FIFO)', ${costCenterId},
      0, ${costTxn}, 0, ${costBase}
    )
  `;
}

async function deleteSystemEntriesForParent(trx: any, orgId: string, parentEntryId: string) {
  const rows = (await trx`
    SELECT id
    FROM journal_entries
    WHERE org_id = ${orgId} AND parent_entry_id = ${parentEntryId} AND is_system = true
  `) as any[];
  if (!rows.length) return;
  const ids = rows.map((r) => String(r.id));
  await trx`DELETE FROM journal_lines WHERE org_id = ${orgId} AND entry_id = ANY(${ids}::uuid[])`;
  await trx`DELETE FROM attachments WHERE org_id = ${orgId} AND entry_id = ANY(${ids}::uuid[])`;
  await trx`DELETE FROM journal_entries WHERE org_id = ${orgId} AND id = ANY(${ids}::uuid[])`;
}

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const rows = await sql`
    SELECT
      e.id,
      to_char(e.entry_date, 'YYYY-MM-DD') as "entryDate",
      e.status,
      e.voucher_no as "voucherNo",
      e.parent_entry_id as "parentEntryId",
      e.is_system as "isSystem",
      e.currency_code as "currency",
      e.fx_rate as "fxRate",
      e.memo,
      e.vendor_id as "vendorId",
      e.customer_id as "customerId",
      e.inventory_impact as "inventoryImpact",
      e.created_at as "createdAt",
      (SELECT COALESCE(SUM(debit_txn),0) FROM journal_lines l WHERE l.entry_id = e.id) as "totalDebitTxn",
      (SELECT COALESCE(SUM(debit_base),0) FROM journal_lines l WHERE l.entry_id = e.id) as "totalDebitBase"
    FROM journal_entries e
    WHERE e.org_id = ${orgId}
    ORDER BY e.entry_date DESC, e.created_at DESC
    LIMIT 200
  `;
  res.status(200).json({ success: true, data: { entries: rows } });
});

router.get("/voucher/next", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();

  const counterRows = await sql`
    SELECT next_int as "nextInt"
    FROM org_counters
    WHERE org_id = ${orgId} AND key = 'JV'
    LIMIT 1
  `;
  const counterNextInt = counterRows.length ? Number((counterRows[0] as any).nextInt) : NaN;
  let nextInt: number;
  if (Number.isFinite(counterNextInt) && counterNextInt > 0) {
    nextInt = counterNextInt;
  } else {
    const rows = await sql`
      SELECT
        COALESCE(MAX(CASE WHEN voucher_no ~ '^JV[0-9]+$' THEN substring(voucher_no from 3)::bigint ELSE 0 END), 0) as "maxInt"
      FROM journal_entries
      WHERE org_id = ${orgId}
    `;
    const maxInt = Number((rows[0] as any).maxInt) || 0;
    nextInt = maxInt + 1;
  }

  const voucherNo = `JV${String(nextInt).padStart(5, "0")}`;
  res.status(200).json({ success: true, data: { voucherNo, nextInt } });
});

router.get("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const id = req.params.id;
  const entries = await sql`
    SELECT id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", parent_entry_id as "parentEntryId", is_system as "isSystem", currency_code as "currency", fx_rate as "fxRate", memo, inventory_impact as "inventoryImpact", vendor_id as "vendorId", customer_id as "customerId"
    FROM journal_entries
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `;
  const entry = entries[0];
  if (!entry) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const isSystem = Boolean((entry as any).isSystem);
  const lines =
    isSystem
      ? await sql`
          SELECT
            id,
            line_no as "lineNo",
            account_id as "accountId",
            description,
            cost_center_id as "costCenterId",
            debit_txn as "debitTxn",
            credit_txn as "creditTxn",
            debit_base as "debitBase",
            credit_base as "creditBase"
          FROM journal_lines
          WHERE entry_id = ${id} AND org_id = ${orgId}
          ORDER BY line_no ASC
        `
      : await sql`
          SELECT
            id,
            line_no as "lineNo",
            account_id as "accountId",
            description,
            cost_center_id as "costCenterId",
            debit_txn as "debitTxn",
            credit_txn as "creditTxn",
            debit_base as "debitBase",
            credit_base as "creditBase"
          FROM journal_lines
          WHERE entry_id = ${id} AND org_id = ${orgId} AND (description IS NULL OR description NOT IN ('COGS (FIFO)', 'Inventory (FIFO)'))
          ORDER BY line_no ASC
        `;
  const atts = await sql`
    SELECT id, file_name as "fileName", mime_type as "mimeType", size_bytes as "sizeBytes", created_at as "createdAt"
    FROM attachments
    WHERE entry_id = ${id} AND org_id = ${orgId}
    ORDER BY created_at DESC
  `;
  res.status(200).json({ success: true, data: { entry, lines, attachments: atts } });
});

router.put("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;

  const lineSchema = z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    costCenterId: z.string().uuid().nullable().optional(),
    debitTxn: z.number().nonnegative().default(0),
    creditTxn: z.number().nonnegative().default(0),
    fixedAssetId: z.string().uuid().optional(),
  });

  const fixedAssetPurchaseSchema = z.object({
    lineNo: z.number().int().positive(),
    category: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z.enum(FIXED_ASSET_CATEGORIES as unknown as [string, ...string[]]),
    ),
    assetNo: z
      .preprocess(
        (v) => {
          if (typeof v !== "string") return undefined;
          const s = v.trim().toUpperCase();
          return s ? s : undefined;
        },
        z.string().min(5).max(32).optional(),
      )
      .optional(),
    name: z.string().min(1),
    acquisitionDate: z.string().min(10),
    usefulLifeMonths: z.number().int().positive(),
    salvageBase: z.number().nonnegative().default(0),
  });

  const inventoryDetailReceiptSchema = z.object({
    moveType: z.literal("receipt"),
    itemId: z.string().uuid(),
    qty: z.number().positive().finite(),
    unitCostTxn: z.number().positive().finite(),
  });
  const inventoryDetailShipmentSchema = z.object({
    moveType: z.literal("shipment"),
    itemId: z.string().uuid(),
    qty: z.number().positive().finite(),
  });
  const inventoryDetailsSchema = z.array(z.union([inventoryDetailReceiptSchema, inventoryDetailShipmentSchema])).min(1).optional();

  const bodySchema = z.object({
    entryDate: z.string().min(10),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    vendorId: z.string().uuid().nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
    voucherNo: z.string().trim().min(1).max(32).optional(),
    memo: z.string().optional(),
    inventoryDetails: inventoryDetailsSchema,
    inventoryLinkLineNo: z.number().int().positive().optional(),
    shipmentInventoryAccountId: z.string().uuid().optional(),
    shipmentCogsAccountId: z.string().uuid().optional(),
    fixedAssetPurchases: z.array(fixedAssetPurchaseSchema).optional(),
    lines: z.array(lineSchema).min(2),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const { entryDate, currency, fxRate, memo, lines } = parsed.data;
  const vendorId = parsed.data.vendorId ?? null;
  const customerId = parsed.data.customerId ?? null;
  const inventoryDetails = parsed.data.inventoryDetails;
  const inventoryLinkLineNo = parsed.data.inventoryLinkLineNo;
  const shipmentInventoryAccountId = parsed.data.shipmentInventoryAccountId;
  const shipmentCogsAccountId = parsed.data.shipmentCogsAccountId;
  const fixedAssetPurchases = parsed.data.fixedAssetPurchases;
  const effectiveInventoryImpact = Boolean(inventoryDetails && inventoryDetails.length);

  const userLines = lines.filter((l) => !isSystemAutoLine(l.description));

  const normalizedLines = userLines.map((l, idx) => {
    const debit = l.debitTxn || 0;
    const credit = l.creditTxn || 0;
    const debitBase = round2(debit * fxRate);
    const creditBase = round2(credit * fxRate);
    return {
      lineNo: idx + 1,
      accountId: l.accountId,
      description: l.description || null,
      costCenterId: l.costCenterId ?? null,
      debitTxn: debit,
      creditTxn: credit,
      debitBase,
      creditBase,
      fixedAssetId: l.fixedAssetId ? String(l.fixedAssetId) : null,
    };
  });

  const sumDebitBase = round2(normalizedLines.reduce((s, l) => s + Number(l.debitBase || 0), 0));
  const sumCreditBase = round2(normalizedLines.reduce((s, l) => s + Number(l.creditBase || 0), 0));
  if (round2(sumDebitBase) !== round2(sumCreditBase)) {
    res.status(400).json({ success: false, error: `Unbalanced entry: debit ${sumDebitBase} credit ${sumCreditBase}` });
    return;
  }
  if (round2(sumDebitBase) <= 0) {
    res.status(400).json({ success: false, error: "Entry amount must be greater than 0" });
    return;
  }

  let inventoryMode: "none" | "receipt" | "shipment" = "none";
  let linkLineNo: number | null = null;
  if (effectiveInventoryImpact) {
    if (!inventoryDetails?.length) {
      res.status(400).json({ success: false, error: "Missing inventoryDetails" });
      return;
    }
    if (!inventoryLinkLineNo) {
      res.status(400).json({ success: false, error: "Missing inventoryLinkLineNo" });
      return;
    }
    linkLineNo = inventoryLinkLineNo;
    const detailTypes = Array.from(new Set(inventoryDetails.map((d) => d.moveType)));
    if (detailTypes.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory details must be all receipt or all shipment" });
      return;
    }
    const linkedLine = normalizedLines.find((l) => l.lineNo === inventoryLinkLineNo);
    if (!linkedLine) {
      res.status(400).json({ success: false, error: "Invalid inventoryLinkLineNo" });
      return;
    }
    const debitBase = round2(linkedLine.debitBase);
    const creditBase = round2(linkedLine.creditBase);
    if (debitBase > 0 && creditBase > 0) {
      res.status(400).json({ success: false, error: "Inventory link line cannot have both debit and credit" });
      return;
    }
    inventoryMode = detailTypes[0];
    if (inventoryMode === "receipt") {
      const receiptDetails = inventoryDetails.filter((d) => d.moveType === "receipt") as Array<{
        moveType: "receipt";
        itemId: string;
        qty: number;
        unitCostTxn: number;
      }>;
      const expectedTxn = round2(receiptDetails.reduce((s, d) => s + round2(d.qty * d.unitCostTxn), 0));
      const debitTxn = round2(linkedLine.debitTxn);
      const creditTxn = round2(linkedLine.creditTxn);
      const existingTxn = debitTxn > 0 ? debitTxn : creditTxn > 0 ? creditTxn : 0;
      if (existingTxn > 0 && round2(existingTxn) !== round2(expectedTxn)) {
        res.status(400).json({ success: false, error: `Inventory total mismatch: entry ${round2(existingTxn)} vs receipt ${expectedTxn}` });
        return;
      }
    }
    if (inventoryMode === "shipment") {
      const expectedBase = debitBase > 0 ? debitBase : creditBase;
      if (expectedBase <= 0) {
        res.status(400).json({ success: false, error: "Inventory shipment linked line amount must be greater than 0" });
        return;
      }
    }
  }

  let accumDepAccountId: string | null = null;
  let depExpenseAccountId: string | null = null;
  if (fixedAssetPurchases?.length) {
    const uniqueLineNos = new Set(fixedAssetPurchases.map((p) => p.lineNo));
    if (uniqueLineNos.size !== fixedAssetPurchases.length) {
      res.status(400).json({ success: false, error: "Duplicate fixed asset purchase lineNo" });
      return;
    }
    const maxLineNo = Math.max(...normalizedLines.map((l) => l.lineNo));
    for (const p of fixedAssetPurchases) {
      if (!(p.lineNo >= 1 && p.lineNo <= maxLineNo)) {
        res.status(400).json({ success: false, error: "Invalid fixed asset purchase lineNo" });
        return;
      }
    }
    const accumAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1610' LIMIT 1`;
    const depExpAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '6100' LIMIT 1`;
    accumDepAccountId = accumAcc[0]?.id || null;
    depExpenseAccountId = depExpAcc[0]?.id || null;
    if (!accumDepAccountId || !depExpenseAccountId) {
      res.status(400).json({ success: false, error: "Missing default fixed asset accounts" });
      return;
    }
  }

  const fixedAssetIds = Array.from(new Set(normalizedLines.map((l) => (l.fixedAssetId ? String(l.fixedAssetId) : "")).filter(Boolean)));
  let fixedAssetById = new Map<string, { id: string; status: string; assetAccountId: string | null; accumDepAccountId: string | null; depExpenseAccountId: string | null }>();
  if (fixedAssetIds.length) {
    const rows = (await sql`
      SELECT id, status, asset_account_id as "assetAccountId", accum_dep_account_id as "accumDepAccountId", dep_expense_account_id as "depExpenseAccountId"
      FROM fixed_assets
      WHERE org_id = ${orgId} AND id = ANY(${fixedAssetIds}::uuid[])
    `) as any[];
    fixedAssetById = new Map(
      rows.map((r) => [String(r.id), { id: String(r.id), status: String(r.status || ""), assetAccountId: r.assetAccountId ? String(r.assetAccountId) : null, accumDepAccountId: r.accumDepAccountId ? String(r.accumDepAccountId) : null, depExpenseAccountId: r.depExpenseAccountId ? String(r.depExpenseAccountId) : null }]),
    );
    if (fixedAssetById.size !== fixedAssetIds.length) {
      res.status(400).json({ success: false, error: "Invalid fixedAssetId" });
      return;
    }
    for (const l of normalizedLines) {
      if (!l.fixedAssetId) continue;
      const a = fixedAssetById.get(String(l.fixedAssetId));
      if (!a) {
        res.status(400).json({ success: false, error: "Invalid fixedAssetId" });
        return;
      }
      if (a.status !== "active") {
        res.status(409).json({ success: false, error: "Asset is not active" });
        return;
      }
      const okAccount = l.accountId === a.assetAccountId || l.accountId === a.accumDepAccountId || l.accountId === a.depExpenseAccountId;
      if (!okAccount) {
        res.status(400).json({ success: false, error: "Fixed asset linked line account mismatch" });
        return;
      }
    }
  }

  try {
    const updated = await sql.begin(async (trx) => {
      const existingRows = await trx`
        SELECT status, voucher_no as "voucherNo", inventory_impact as "inventoryImpact", is_system as "isSystem"
        FROM journal_entries
        WHERE org_id = ${orgId} AND id = ${id}
        LIMIT 1
      `;
      const existing = existingRows[0] as any;
      if (!existing) {
        throw new Error("Not found");
      }
      if (existing.isSystem) {
        throw new Error("System entries cannot be edited directly");
      }
      if (String(existing.status) !== "posted") {
        throw new Error("Only posted entries can be edited currently");
      }

      const existingFixedAssets = await trx`
        SELECT line_no as "lineNo", account_id as "accountId", debit_base as "debitBase", credit_base as "creditBase", fixed_asset_id as "fixedAssetId"
        FROM journal_lines
        WHERE org_id = ${orgId} AND entry_id = ${id} AND fixed_asset_id IS NOT NULL
      `;
      const preservedFixedAssetIdByKey = new Map<string, string>();
      for (const r of existingFixedAssets as any[]) {
        const k = `${Number(r.lineNo)}:${String(r.accountId)}:${round2(Number(r.debitBase || 0))}:${round2(Number(r.creditBase || 0))}`;
        if (r.fixedAssetId) preservedFixedAssetIdByKey.set(k, String(r.fixedAssetId));
      }

      await rollbackInventoryByEntryId(trx, orgId, id);

      await trx`DELETE FROM journal_lines WHERE org_id = ${orgId} AND entry_id = ${id}`;

      const voucherNo = parsed.data.voucherNo?.trim() || String(existing.voucherNo || "").trim() || (await issueVoucherNo(trx, orgId));
      await trx`
        UPDATE journal_entries
        SET entry_date = ${entryDate},
            voucher_no = ${voucherNo},
            currency_code = ${currency.toUpperCase()},
            fx_rate = ${fxRate},
            memo = ${memo || null},
            vendor_id = ${vendorId},
            customer_id = ${customerId},
            inventory_impact = ${effectiveInventoryImpact},
            posted_at = now()
        WHERE org_id = ${orgId} AND id = ${id}
      `;

      const fixedAssetIdByLineNo = new Map<number, string>();
      if (fixedAssetPurchases?.length && accumDepAccountId && depExpenseAccountId) {
        for (const p of fixedAssetPurchases) {
          const line = normalizedLines.find((l) => l.lineNo === p.lineNo);
          if (!line) {
            throw new Error("Invalid fixed asset purchase lineNo");
          }
          const category = normalizeFixedAssetCategory(p.category);
          const costBase = round2(Number(line.debitBase) > 0 ? line.debitBase : line.creditBase);
          if (!(costBase > 0)) {
            throw new Error("Fixed asset cost must be greater than 0");
          }

          const desiredNo = p.assetNo ? String(p.assetNo).trim().toUpperCase() : "";
          if (desiredNo) {
            const exists = await trx`
              SELECT id
              FROM fixed_assets
              WHERE org_id = ${orgId} AND asset_no = ${desiredNo}
              LIMIT 1
            `;
            if (exists.length) {
              throw new Error("固定资产编号已存在");
            }
          }
          const assetNo = desiredNo || (await issueFixedAssetNo(trx, orgId, category));
          const asset = (
            await trx`
              INSERT INTO fixed_assets (
                org_id, name, acquisition_date, cost_base, useful_life_months, salvage_value_base,
                status, asset_account_id, accum_dep_account_id, dep_expense_account_id,
                category, asset_no
              ) VALUES (
                ${orgId}, ${p.name.trim()}, ${p.acquisitionDate}, ${costBase}, ${p.usefulLifeMonths}, ${p.salvageBase},
                'active', ${line.accountId}, ${accumDepAccountId}, ${depExpenseAccountId},
                ${category}, ${assetNo}
              )
              RETURNING id
            `
          )[0] as any;
          fixedAssetIdByLineNo.set(p.lineNo, asset.id);
        }
      }

      for (const l of normalizedLines) {
        const key = `${l.lineNo}:${l.accountId}:${round2(Number(l.debitBase || 0))}:${round2(Number(l.creditBase || 0))}`;
        const fixedAssetId = l.fixedAssetId || fixedAssetIdByLineNo.get(l.lineNo) || preservedFixedAssetIdByKey.get(key) || null;
        await trx`
          INSERT INTO journal_lines (
            org_id, entry_id, line_no, account_id, description, cost_center_id,
            debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id
          ) VALUES (
            ${orgId}, ${id}, ${l.lineNo}, ${l.accountId}, ${l.description}, ${l.costCenterId},
            ${l.debitTxn}, ${l.creditTxn}, ${l.debitBase}, ${l.creditBase}, ${fixedAssetId}
          )
        `;
      }

      if (effectiveInventoryImpact && inventoryDetails?.length && linkLineNo) {
        if (inventoryMode === "receipt") {
          await insertPostedInventoryReceipts(
            trx,
            orgId,
            String(id),
            Number(linkLineNo),
            entryDate,
            currency,
            Number(fxRate),
            (inventoryDetails as any[]).map((d) => ({ itemId: String(d.itemId), qty: Number(d.qty), unitCostTxn: Number(d.unitCostTxn) })),
          );
        }

        if (inventoryMode === "shipment") {
          const fx = Number(fxRate);
          let totalBaseAll = 0;
          const linkedCostCenterId =
            normalizedLines.find((l) => l.lineNo === linkLineNo)?.costCenterId ?? null;
          for (const d of inventoryDetails as any[]) {
            const itemId = String(d.itemId);
            const qtyRequested = Number(d.qty);
            if (!Number.isFinite(qtyRequested) || qtyRequested <= 0) {
              throw new Error("Invalid shipment qty");
            }
            const layers = await trx`
              SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
              FROM inventory_layers
              WHERE org_id = ${orgId} AND item_id = ${itemId} AND qty_remaining > 0
              ORDER BY received_date ASC, created_at ASC, id ASC
              FOR UPDATE
            `;
            let remaining = qtyRequested;
            const breakdown: Array<{ layerId: string; qty: number; unitCostBase: number; amountBase: number }> = [];
            for (const row of layers as any[]) {
              if (remaining <= 0) break;
              const qtyAvail = Number(row.qtyRemaining);
              const take = Math.min(remaining, qtyAvail);
              const layerUnitCostBase = Number(row.unitCostBase);
              const amountBase = round2(take * layerUnitCostBase);
              breakdown.push({ layerId: row.id, qty: take, unitCostBase: layerUnitCostBase, amountBase });
              remaining = round6(remaining - take);
            }
            if (remaining > 0) {
              throw new Error("Insufficient stock");
            }
            const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));
            totalBaseAll = round2(totalBaseAll + totalBase);
            const layerIds = breakdown.map((b) => String(b.layerId));
            const qtys = breakdown.map((b) => Number(b.qty));
            const unitCostsBase = breakdown.map((b) => Number(b.unitCostBase));
            const unitCostsTxn = breakdown.map((b) => (fx > 0 ? round6(Number(b.unitCostBase) / fx) : null));
            const entrySeqs = breakdown.map((_, i) => i + 1);

            await trx`
              UPDATE inventory_layers l
              SET qty_remaining = l.qty_remaining - x.qty
              FROM (
                SELECT unnest(${layerIds}::uuid[]) as id, unnest(${qtys}::numeric[]) as qty
              ) x
              WHERE l.org_id = ${orgId} AND l.id = x.id
            `;

            await trx`
              INSERT INTO inventory_moves (
                org_id, item_id, move_type, move_date, qty,
                unit_cost_base, unit_cost_txn, currency_code, fx_rate, status,
                entry_id, entry_line_no, source_layer_id, entry_seq
              )
              SELECT
                ${orgId},
                ${itemId},
                'shipment',
                ${entryDate},
                x.qty,
                x.unit_cost_base,
                x.unit_cost_txn,
                ${currency.toUpperCase()},
                ${fxRate},
                'posted',
                ${id},
                ${linkLineNo},
                x.layer_id,
                x.entry_seq
              FROM (
                SELECT
                  unnest(${layerIds}::uuid[]) as layer_id,
                  unnest(${qtys}::numeric[]) as qty,
                  unnest(${unitCostsBase}::numeric[]) as unit_cost_base,
                  unnest(${unitCostsTxn as any}::numeric[]) as unit_cost_txn,
                  unnest(${entrySeqs}::int[]) as entry_seq
              ) x
            `;
          }

          try {
            const activeAccounts = (await trx`
              SELECT id, code, name, type
              FROM accounts
              WHERE org_id = ${orgId} AND (is_active IS NULL OR is_active = true)
              ORDER BY code ASC
            `) as any[];
            const invAccId =
              shipmentInventoryAccountId ||
              activeAccounts.find((a) => String(a.code || "").startsWith("15"))?.id ||
              activeAccounts.find((a) => String(a.name || "").toLowerCase().includes("inventory"))?.id ||
              activeAccounts.find((a) => String(a.type || "") === "asset")?.id ||
              null;
            const cogsAccId =
              shipmentCogsAccountId ||
              activeAccounts.find((a) => String(a.type || "") === "cogs")?.id ||
              activeAccounts.find((a) => String(a.name || "").toLowerCase().includes("cogs"))?.id ||
              activeAccounts.find((a) => String(a.code || "").startsWith("50"))?.id ||
              null;
            if (invAccId && cogsAccId) {
              const costBase = round2(totalBaseAll);
              const costTxn = fx > 0 ? round2(costBase / fx) : round2(costBase);
              await upsertSystemCogsEntry(
                trx,
                orgId,
                String(req.auth!.userId),
                id,
                voucherNo,
                entryDate,
                currency,
                fxRate,
                cogsAccId,
                invAccId,
                linkedCostCenterId,
                costTxn,
                costBase,
              );
            } else {
              await deleteSystemEntriesForParent(trx, orgId, id);
            }
          } catch {
            // ignore
          }
        }
      }

      if (!effectiveInventoryImpact) {
        await deleteSystemEntriesForParent(trx, orgId, id);
      }

      const entry = (
        await trx`
          SELECT id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", currency_code as "currency", fx_rate as "fxRate", memo, inventory_impact as "inventoryImpact"
          FROM journal_entries
          WHERE org_id = ${orgId} AND id = ${id}
          LIMIT 1
        `
      )[0] as any;
      return entry;
    });

    res.status(200).json({ success: true, data: { entry: updated } });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Update failed";
    if (msg === "Not found") {
      res.status(404).json({ success: false, error: msg });
      return;
    }
    if (
      msg.includes("Cannot rollback") ||
      msg.includes("Insufficient stock") ||
      msg.includes("Unbalanced") ||
      msg.includes("Only posted") ||
      msg.toLowerCase().includes("fixed asset")
    ) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    const mapped = mapPgError(e);
    if (mapped) {
      console.error("[journals/put]", { orgId, userId: req.auth?.userId, pgCode: e?.code, message: msg });
      res.status(mapped.status).json({ success: false, error: mapped.message, errorId: mapped.errorId });
      return;
    }
    const errorId = makeErrorId();
    console.error("[journals/put]", { orgId, userId: req.auth?.userId, errorId, message: msg });
    await tryLogError(sql, { id: errorId, orgId, userId: req.auth?.userId || null, route: "journals/put", message: msg, stack: e?.stack || null });
    res.status(500).json({ success: false, error: `Server internal error (ID ${errorId})`, errorId });
  }
});

router.post("/post", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const lineSchema = z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    costCenterId: z.string().uuid().nullable().optional(),
    debitTxn: z.number().nonnegative().default(0),
    creditTxn: z.number().nonnegative().default(0),
    fixedAssetId: z.string().uuid().optional(),
  });

  const fixedAssetPurchaseSchema = z.object({
    lineNo: z.number().int().positive(),
    category: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z.enum(FIXED_ASSET_CATEGORIES as unknown as [string, ...string[]]),
    ),
    assetNo: z
      .preprocess(
        (v) => {
          if (typeof v !== "string") return undefined;
          const s = v.trim().toUpperCase();
          return s ? s : undefined;
        },
        z.string().min(5).max(32).optional(),
      )
      .optional(),
    name: z.string().min(1),
    acquisitionDate: z.string().min(10),
    usefulLifeMonths: z.number().int().positive(),
    salvageBase: z.number().nonnegative().default(0),
  });

  const inventoryDetailReceiptSchema = z.object({
    moveType: z.literal("receipt"),
    itemId: z.string().uuid(),
    qty: z.number().positive().finite(),
    unitCostTxn: z.number().positive().finite(),
  });
  const inventoryDetailShipmentSchema = z.object({
    moveType: z.literal("shipment"),
    itemId: z.string().uuid(),
    qty: z.number().positive().finite(),
  });
  const inventoryDetailsSchema = z.array(z.union([inventoryDetailReceiptSchema, inventoryDetailShipmentSchema])).min(1).optional();

  const bodySchema = z.object({
    entryDate: z.string().min(10),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    vendorId: z.string().uuid().nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
    voucherNo: z.string().trim().min(1).max(32).optional(),
    memo: z.string().optional(),
    inventoryDetails: inventoryDetailsSchema,
    inventoryLinkLineNo: z.number().int().positive().optional(),
    shipmentInventoryAccountId: z.string().uuid().optional(),
    shipmentCogsAccountId: z.string().uuid().optional(),
    fixedAssetPurchases: z.array(fixedAssetPurchaseSchema).optional(),
    fixedAssetDisposal: fixedAssetDisposalSchema.optional(),
    recurring: recurringSchema.optional(),
    lines: z.array(lineSchema).min(2),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const { entryDate, currency, fxRate, memo, lines } = parsed.data;
  const vendorId = parsed.data.vendorId ?? null;
  const customerId = parsed.data.customerId ?? null;
  const inventoryDetails = parsed.data.inventoryDetails;
  const inventoryLinkLineNo = parsed.data.inventoryLinkLineNo;
  const shipmentInventoryAccountId = parsed.data.shipmentInventoryAccountId;
  const shipmentCogsAccountId = parsed.data.shipmentCogsAccountId;
  const fixedAssetPurchases = parsed.data.fixedAssetPurchases;
  const fixedAssetDisposal = parsed.data.fixedAssetDisposal;
  const recurring = parsed.data.recurring;
  const effectiveInventoryImpact = Boolean(inventoryDetails && inventoryDetails.length);

  const addMonthsYmd = (ymd: string, monthsToAdd: number) => {
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(ymd);
    if (!m) throw new Error("Invalid entryDate");
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const baseFirst = new Date(Date.UTC(y, mo - 1, 1));
    const targetFirst = new Date(Date.UTC(baseFirst.getUTCFullYear(), baseFirst.getUTCMonth() + monthsToAdd, 1));
    const lastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    const out = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), day));
    const yy = out.getUTCFullYear();
    const mm = String(out.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(out.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  };

  if (recurring && (effectiveInventoryImpact || fixedAssetPurchases?.length)) {
    res.status(400).json({ success: false, error: "Recurring 暂不支持库存/购置自动生成，请用普通过账。" });
    return;
  }

  if (recurring && fixedAssetDisposal) {
    res.status(400).json({ success: false, error: "Recurring 暂不支持处置自动生成，请用普通过账。" });
    return;
  }

  const userLines = lines.filter((l) => !isSystemAutoLine(l.description));

  const normalizedLines = userLines.map((l, idx) => {
    const debit = l.debitTxn || 0;
    const credit = l.creditTxn || 0;
    const debitBase = round2(debit * fxRate);
    const creditBase = round2(credit * fxRate);
    return {
      lineNo: idx + 1,
      accountId: l.accountId,
      description: l.description || null,
      costCenterId: l.costCenterId ?? null,
      debitTxn: debit,
      creditTxn: credit,
      debitBase,
      creditBase,
      fixedAssetId: l.fixedAssetId ? String(l.fixedAssetId) : null,
    };
  });

  const sumDebitBase = round2(normalizedLines.reduce((s, l) => s + Number(l.debitBase || 0), 0));
  const sumCreditBase = round2(normalizedLines.reduce((s, l) => s + Number(l.creditBase || 0), 0));
  if (round2(sumDebitBase) !== round2(sumCreditBase)) {
    res.status(400).json({ success: false, error: `Unbalanced entry: debit ${sumDebitBase} credit ${sumCreditBase}` });
    return;
  }
  if (round2(sumDebitBase) <= 0) {
    res.status(400).json({ success: false, error: "Entry amount must be greater than 0" });
    return;
  }

  let inventoryMode: "none" | "receipt" | "shipment" = "none";
  let linkLineNo: number | null = null;

  if (effectiveInventoryImpact) {
    if (!inventoryDetails?.length) {
      res.status(400).json({ success: false, error: "Missing inventoryDetails" });
      return;
    }
    if (!inventoryLinkLineNo) {
      res.status(400).json({ success: false, error: "Missing inventoryLinkLineNo" });
      return;
    }
    linkLineNo = inventoryLinkLineNo;

    const detailTypes = Array.from(new Set(inventoryDetails.map((d) => d.moveType)));
    if (detailTypes.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory details must be all receipt or all shipment" });
      return;
    }

    const linkedLine = normalizedLines.find((l) => l.lineNo === inventoryLinkLineNo);
    if (!linkedLine) {
      res.status(400).json({ success: false, error: "Invalid inventoryLinkLineNo" });
      return;
    }
    const debitBase = round2(linkedLine.debitBase);
    const creditBase = round2(linkedLine.creditBase);
    if (debitBase > 0 && creditBase > 0) {
      res.status(400).json({ success: false, error: "Inventory link line cannot have both debit and credit" });
      return;
    }

    const requestedMode = detailTypes[0];
    inventoryMode = requestedMode;
    if (requestedMode === "receipt") {
      const receiptDetails = inventoryDetails.filter((d) => d.moveType === "receipt") as Array<{
        moveType: "receipt";
        itemId: string;
        qty: number;
        unitCostTxn: number;
      }>;
      const expectedTxn = round2(receiptDetails.reduce((s, d) => s + round2(d.qty * d.unitCostTxn), 0));
      const debitTxn = round2(linkedLine.debitTxn);
      const creditTxn = round2(linkedLine.creditTxn);
      const existingTxn = debitTxn > 0 ? debitTxn : creditTxn > 0 ? creditTxn : 0;
      if (existingTxn > 0 && round2(existingTxn) !== round2(expectedTxn)) {
        res.status(400).json({ success: false, error: `Inventory total mismatch: entry ${round2(existingTxn)} vs receipt ${expectedTxn}` });
        return;
      }
    }
    if (requestedMode === "shipment") {
      const shipmentDetails = inventoryDetails.filter((d) => d.moveType === "shipment");
      if (!shipmentDetails.length) {
        res.status(400).json({ success: false, error: "Missing shipment inventoryDetails" });
        return;
      }
      const expectedBase = debitBase > 0 ? debitBase : creditBase;
      if (expectedBase <= 0) {
        res.status(400).json({ success: false, error: "Inventory shipment linked line amount must be greater than 0" });
        return;
      }
    }
  }

  let accumDepAccountId: string | null = null;
  let depExpenseAccountId: string | null = null;
  if (fixedAssetPurchases?.length) {
    const uniqueLineNos = new Set(fixedAssetPurchases.map((p) => p.lineNo));
    if (uniqueLineNos.size !== fixedAssetPurchases.length) {
      res.status(400).json({ success: false, error: "Duplicate fixed asset purchase lineNo" });
      return;
    }
    const maxLineNo = Math.max(...normalizedLines.map((l) => l.lineNo));
    for (const p of fixedAssetPurchases) {
      if (!(p.lineNo >= 1 && p.lineNo <= maxLineNo)) {
        res.status(400).json({ success: false, error: "Invalid fixed asset purchase lineNo" });
        return;
      }
    }
    const accumAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1610' LIMIT 1`;
    const depExpAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '6100' LIMIT 1`;
    accumDepAccountId = accumAcc[0]?.id || null;
    depExpenseAccountId = depExpAcc[0]?.id || null;
    if (!accumDepAccountId || !depExpenseAccountId) {
      res.status(400).json({ success: false, error: "Missing default fixed asset accounts" });
      return;
    }
  }

  const fixedAssetIds = Array.from(new Set(normalizedLines.map((l) => (l.fixedAssetId ? String(l.fixedAssetId) : "")).filter(Boolean)));
  let fixedAssetById = new Map<
    string,
    {
      id: string;
      status: string;
      assetAccountId: string | null;
      accumDepAccountId: string | null;
      depExpenseAccountId: string | null;
    }
  >();
  if (fixedAssetIds.length) {
    const rows = (await sql`
      SELECT id, status, asset_account_id as "assetAccountId", accum_dep_account_id as "accumDepAccountId", dep_expense_account_id as "depExpenseAccountId"
      FROM fixed_assets
      WHERE org_id = ${orgId} AND id = ANY(${fixedAssetIds}::uuid[])
    `) as any[];
    fixedAssetById = new Map(
      rows.map((r) => [
        String(r.id),
        {
          id: String(r.id),
          status: String(r.status || ""),
          assetAccountId: r.assetAccountId ? String(r.assetAccountId) : null,
          accumDepAccountId: r.accumDepAccountId ? String(r.accumDepAccountId) : null,
          depExpenseAccountId: r.depExpenseAccountId ? String(r.depExpenseAccountId) : null,
        },
      ]),
    );
    if (fixedAssetById.size !== fixedAssetIds.length) {
      res.status(400).json({ success: false, error: "Invalid fixedAssetId" });
      return;
    }
    for (const l of normalizedLines) {
      if (!l.fixedAssetId) continue;
      const a = fixedAssetById.get(String(l.fixedAssetId));
      if (!a) {
        res.status(400).json({ success: false, error: "Invalid fixedAssetId" });
        return;
      }
      if (a.status !== "active") {
        res.status(409).json({ success: false, error: "Asset is not active" });
        return;
      }
      const okAccount = l.accountId === a.assetAccountId || l.accountId === a.accumDepAccountId || l.accountId === a.depExpenseAccountId;
      if (!okAccount) {
        res.status(400).json({ success: false, error: "Fixed asset linked line account mismatch" });
        return;
      }
    }
  }

  try {
    const created = await sql.begin(async (trx) => {
      const issuedVoucherNo = await issueVoucherNo(trx, orgId);
      const providedVoucherNo = parsed.data.voucherNo?.trim() || "";
      const candidates = Array.from(new Set([providedVoucherNo, issuedVoucherNo].filter(Boolean)));
      let entry: any = null;

      for (const vn of candidates) {
        try {
          entry = (
            await trx`
              INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, parent_entry_id, is_system, currency_code, fx_rate, memo, created_by, inventory_impact, posted_at, vendor_id, customer_id)
              VALUES (${orgId}, ${entryDate}, 'posted', ${vn}, NULL, false, ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${effectiveInventoryImpact}, now(), ${vendorId}, ${customerId})
              RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", currency_code as "currency", fx_rate as "fxRate", memo
            `
          )[0] as any;
          break;
        } catch (e: any) {
          if (String(e?.code || "") === "23505" && vn === providedVoucherNo && candidates.length > 1) {
            continue;
          }
          throw e;
        }
      }

      while (!entry) {
        const vn = await issueVoucherNo(trx, orgId);
        try {
          entry = (
            await trx`
              INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, parent_entry_id, is_system, currency_code, fx_rate, memo, created_by, inventory_impact, posted_at, vendor_id, customer_id)
              VALUES (${orgId}, ${entryDate}, 'posted', ${vn}, NULL, false, ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${effectiveInventoryImpact}, now(), ${vendorId}, ${customerId})
              RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", currency_code as "currency", fx_rate as "fxRate", memo
            `
          )[0] as any;
          break;
        } catch (e: any) {
          if (String(e?.code || "") === "23505") continue;
          throw e;
        }
      }

      if (recurring) {
        const entries: any[] = [];
        const rootEntryId = String(entry.id);
        entries.push(entry);

        for (const l of normalizedLines) {
          await trx`
            INSERT INTO journal_lines (
              org_id, entry_id, line_no, account_id, description, cost_center_id,
              debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id
            ) VALUES (
              ${orgId}, ${entry.id}, ${l.lineNo}, ${l.accountId}, ${l.description}, ${l.costCenterId},
              ${l.debitTxn}, ${l.creditTxn}, ${l.debitBase}, ${l.creditBase}, ${l.fixedAssetId || null}
            )
          `;
        }

        const everyMonths = Number(recurring.everyMonths);
        const count = Number(recurring.count);
        for (let i = 1; i < count; i += 1) {
          const nextDate = addMonthsYmd(entryDate, i * everyMonths);
          let nextEntry: any = null;
          while (!nextEntry) {
            const vn = await issueVoucherNo(trx, orgId);
            try {
              nextEntry = (
                await trx`
                  INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, parent_entry_id, is_system, currency_code, fx_rate, memo, created_by, inventory_impact, posted_at, vendor_id, customer_id)
                  VALUES (${orgId}, ${nextDate}, 'posted', ${vn}, ${rootEntryId}, false, ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, false, now(), ${vendorId}, ${customerId})
                  RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", currency_code as "currency", fx_rate as "fxRate", memo
                `
              )[0] as any;
              break;
            } catch (e: any) {
              if (String(e?.code || "") === "23505") continue;
              throw e;
            }
          }

          for (const l of normalizedLines) {
            await trx`
              INSERT INTO journal_lines (
                org_id, entry_id, line_no, account_id, description, cost_center_id,
                debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id
              ) VALUES (
                ${orgId}, ${nextEntry.id}, ${l.lineNo}, ${l.accountId}, ${l.description}, ${l.costCenterId},
                ${l.debitTxn}, ${l.creditTxn}, ${l.debitBase}, ${l.creditBase}, ${l.fixedAssetId || null}
              )
            `;
          }
          entries.push(nextEntry);
        }

        return { entry: entries[0], entries };
      }

      const fixedAssetIdByLineNo = new Map<number, string>();
      if (fixedAssetPurchases?.length && accumDepAccountId && depExpenseAccountId) {
        for (const p of fixedAssetPurchases) {
          const line = normalizedLines.find((l) => l.lineNo === p.lineNo);
          if (!line) {
            throw new Error("Invalid fixed asset purchase lineNo");
          }
          const costBase = round2(Number(line.debitBase) > 0 ? line.debitBase : line.creditBase);
          if (!(costBase > 0)) {
            throw new Error("Fixed asset cost must be greater than 0");
          }
          const category = normalizeFixedAssetCategory(p.category);

          const desiredNo = p.assetNo ? String(p.assetNo).trim().toUpperCase() : "";
          if (desiredNo) {
            const exists = await trx`
              SELECT id
              FROM fixed_assets
              WHERE org_id = ${orgId} AND asset_no = ${desiredNo}
              LIMIT 1
            `;
            if (exists.length) {
              throw new Error("固定资产编号已存在");
            }
          }
          const assetNo = desiredNo || (await issueFixedAssetNo(trx, orgId, category));
          const asset = (
            await trx`
              INSERT INTO fixed_assets (
                org_id, name, acquisition_date, cost_base, useful_life_months, salvage_value_base,
                status, asset_account_id, accum_dep_account_id, dep_expense_account_id,
                category, asset_no
              ) VALUES (
                ${orgId}, ${p.name.trim()}, ${p.acquisitionDate}, ${costBase}, ${p.usefulLifeMonths}, ${p.salvageBase},
                'active', ${line.accountId}, ${accumDepAccountId}, ${depExpenseAccountId},
                ${category}, ${assetNo}
              )
              RETURNING id
            `
          )[0] as any;
          fixedAssetIdByLineNo.set(p.lineNo, asset.id);
        }
      }

      for (const l of normalizedLines) {
        await trx`
          INSERT INTO journal_lines (
            org_id, entry_id, line_no, account_id, description, cost_center_id,
            debit_txn, credit_txn, debit_base, credit_base, fixed_asset_id
          ) VALUES (
            ${orgId}, ${entry.id}, ${l.lineNo}, ${l.accountId}, ${l.description}, ${l.costCenterId},
            ${l.debitTxn}, ${l.creditTxn}, ${l.debitBase}, ${l.creditBase}, ${fixedAssetIdByLineNo.get(l.lineNo) || l.fixedAssetId || null}
          )
        `;
      }

      if (effectiveInventoryImpact && inventoryDetails?.length && linkLineNo) {
        if (inventoryMode === "receipt") {
          await insertPostedInventoryReceipts(
            trx,
            orgId,
            String(entry.id),
            Number(linkLineNo),
            entryDate,
            currency,
            Number(fxRate),
            (inventoryDetails as any[]).map((d) => ({ itemId: String(d.itemId), qty: Number(d.qty), unitCostTxn: Number(d.unitCostTxn) })),
          );
        }

        if (inventoryMode === "shipment") {
          const fx = Number(fxRate);
          let totalBaseAll = 0;
          const linkedCostCenterId =
            normalizedLines.find((l) => l.lineNo === linkLineNo)?.costCenterId ?? null;

          for (const d of inventoryDetails as any[]) {
            const itemId = String(d.itemId);
            const qtyRequested = Number(d.qty);
            if (!Number.isFinite(qtyRequested) || qtyRequested <= 0) {
              throw new Error("Invalid shipment qty");
            }
            const layers = await trx`
              SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
              FROM inventory_layers
              WHERE org_id = ${orgId} AND item_id = ${itemId} AND qty_remaining > 0
              ORDER BY received_date ASC, created_at ASC, id ASC
              FOR UPDATE
            `;

            let remaining = qtyRequested;
            const breakdown: Array<{ layerId: string; qty: number; unitCostBase: number; amountBase: number }> = [];
            for (const row of layers as any[]) {
              if (remaining <= 0) break;
              const qtyAvail = Number(row.qtyRemaining);
              const take = Math.min(remaining, qtyAvail);
              const layerUnitCostBase = Number(row.unitCostBase);
              const amountBase = round2(take * layerUnitCostBase);
              breakdown.push({ layerId: row.id, qty: take, unitCostBase: layerUnitCostBase, amountBase });
              remaining = round6(remaining - take);
            }
            if (remaining > 0) {
              throw new Error("Insufficient stock");
            }
            const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));
            totalBaseAll = round2(totalBaseAll + totalBase);

            const layerIds = breakdown.map((b) => String(b.layerId));
            const qtys = breakdown.map((b) => Number(b.qty));
            const unitCostsBase = breakdown.map((b) => Number(b.unitCostBase));
            const unitCostsTxn = breakdown.map((b) => (fx > 0 ? round6(Number(b.unitCostBase) / fx) : null));
            const entrySeqs = breakdown.map((_, i) => i + 1);

            await trx`
              UPDATE inventory_layers l
              SET qty_remaining = l.qty_remaining - x.qty
              FROM (
                SELECT unnest(${layerIds}::uuid[]) as id, unnest(${qtys}::numeric[]) as qty
              ) x
              WHERE l.org_id = ${orgId} AND l.id = x.id
            `;

            await trx`
              INSERT INTO inventory_moves (
                org_id, item_id, move_type, move_date, qty,
                unit_cost_base, unit_cost_txn, currency_code, fx_rate, status,
                entry_id, entry_line_no, source_layer_id, entry_seq
              )
              SELECT
                ${orgId},
                ${itemId},
                'shipment',
                ${entryDate},
                x.qty,
                x.unit_cost_base,
                x.unit_cost_txn,
                ${currency.toUpperCase()},
                ${fxRate},
                'posted',
                ${entry.id},
                ${linkLineNo},
                x.layer_id,
                x.entry_seq
              FROM (
                SELECT
                  unnest(${layerIds}::uuid[]) as layer_id,
                  unnest(${qtys}::numeric[]) as qty,
                  unnest(${unitCostsBase}::numeric[]) as unit_cost_base,
                  unnest(${unitCostsTxn as any}::numeric[]) as unit_cost_txn,
                  unnest(${entrySeqs}::int[]) as entry_seq
              ) x
            `;
          }

          try {
            const activeAccounts = (await trx`
              SELECT id, code, name, type
              FROM accounts
              WHERE org_id = ${orgId} AND (is_active IS NULL OR is_active = true)
              ORDER BY code ASC
            `) as any[];

            const invAccId =
              shipmentInventoryAccountId ||
              activeAccounts.find((a) => String(a.code || "").startsWith("15"))?.id ||
              activeAccounts.find((a) => String(a.name || "").toLowerCase().includes("inventory"))?.id ||
              activeAccounts.find((a) => String(a.type || "") === "asset")?.id ||
              null;

            const cogsAccId =
              shipmentCogsAccountId ||
              activeAccounts.find((a) => String(a.type || "") === "cogs")?.id ||
              activeAccounts.find((a) => String(a.name || "").toLowerCase().includes("cogs"))?.id ||
              activeAccounts.find((a) => String(a.code || "").startsWith("50"))?.id ||
              null;

            if (invAccId && cogsAccId) {
              const costBase = round2(totalBaseAll);
              const costTxn = fx > 0 ? round2(costBase / fx) : round2(costBase);
              await upsertSystemCogsEntry(
                trx,
                orgId,
                String(req.auth!.userId),
                entry.id,
                entry.voucherNo,
                entryDate,
                currency,
                fxRate,
                cogsAccId,
                invAccId,
                linkedCostCenterId,
                costTxn,
                costBase,
              );
            }
          } catch {
            // ignore
          }
        }
      }

      if (fixedAssetDisposal) {
        const costLine = normalizedLines.find((l) => l.lineNo === Number(fixedAssetDisposal.costLineNo));
        const accumLine = normalizedLines.find((l) => l.lineNo === Number(fixedAssetDisposal.accumDepLineNo));
        if (!costLine || !accumLine) {
          throw new Error("Invalid fixed asset disposal lineNo");
        }
        const costAssetId = costLine.fixedAssetId ? String(costLine.fixedAssetId) : "";
        const accumAssetId = accumLine.fixedAssetId ? String(accumLine.fixedAssetId) : "";
        if (!costAssetId || !accumAssetId || costAssetId !== accumAssetId) {
          throw new Error("处置固定资产不一致，无法过账");
        }
        const a = fixedAssetById.get(costAssetId);
        if (!a) {
          throw new Error("Invalid fixedAssetId");
        }
        if (!a.assetAccountId || !a.accumDepAccountId) {
          throw new Error("Fixed asset accounts not set");
        }
        if (String(costLine.accountId) !== String(a.assetAccountId)) {
          throw new Error("处置成本行科目不匹配");
        }
        if (String(accumLine.accountId) !== String(a.accumDepAccountId)) {
          throw new Error("处置累计折旧行科目不匹配");
        }
        if (!(Number(costLine.creditBase) > 0) || !(Number(accumLine.debitBase) > 0)) {
          throw new Error("处置金额必须大于 0");
        }

        const updated = await trx`
          UPDATE fixed_assets
          SET status = 'disposed', disposed_at = ${entryDate}
          WHERE org_id = ${orgId} AND id = ${costAssetId} AND status = 'active'
          RETURNING id
        `;
        if (!updated.length) {
          const recheck = await trx`SELECT status FROM fixed_assets WHERE org_id = ${orgId} AND id = ${costAssetId} LIMIT 1`;
          if (!recheck.length) {
            throw new Error("Invalid fixedAssetId");
          }
          throw new Error("Asset is not active");
        }
      }

      return entry;
    });

    if ((created as any)?.entries) {
      res.status(200).json({ success: true, data: created });
    } else {
      res.status(200).json({ success: true, data: { entry: created } });
    }
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Post failed";
    if (
      msg.includes("Insufficient stock") ||
      msg.includes("Missing shipment cost accounts") ||
      msg.includes("Inventory cost mismatch") ||
      msg.includes("Inventory") ||
      msg.toLowerCase().includes("fixed asset")
    ) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    const mapped = mapPgError(e);
    if (mapped) {
      console.error("[journals/post]", { orgId, userId: req.auth?.userId, pgCode: e?.code, message: msg });
      res.status(mapped.status).json({ success: false, error: mapped.message, errorId: mapped.errorId });
      return;
    }
    const errorId = makeErrorId();
    console.error("[journals/post]", { orgId, userId: req.auth?.userId, errorId, message: msg });
    await tryLogError(sql, { id: errorId, orgId, userId: req.auth?.userId || null, route: "journals/post", message: msg, stack: e?.stack || null });
    res.status(500).json({ success: false, error: `Server internal error (ID ${errorId})`, errorId });
  }
});

router.delete("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;
  const sql = getSql();

  const entryRows = await sql`
    SELECT status
    FROM journal_entries
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `;
  const status = entryRows.length ? String((entryRows[0] as any).status) : null;
  if (!status) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  try {
    await sql.begin(async (trx) => {
      const fixedAssetRows = (await trx`
        SELECT DISTINCT fixed_asset_id as "assetId"
        FROM journal_lines
        WHERE org_id = ${orgId} AND entry_id = ${id} AND fixed_asset_id IS NOT NULL
      `) as any[];
      const fixedAssetIds = fixedAssetRows.map((r) => String(r.assetId));

      const purchaseAssetIds = new Set<string>();
      if (fixedAssetIds.length) {
        const purchaseRows = (await trx`
          SELECT DISTINCT l.fixed_asset_id as "assetId"
          FROM journal_lines l
          JOIN fixed_assets fa ON fa.id = l.fixed_asset_id
          WHERE l.org_id = ${orgId}
            AND l.entry_id = ${id}
            AND l.fixed_asset_id = ANY(${fixedAssetIds}::uuid[])
            AND fa.org_id = ${orgId}
            AND l.account_id = fa.asset_account_id
            AND COALESCE(l.debit_base, 0) > 0
        `) as any[];
        for (const r of purchaseRows) purchaseAssetIds.add(String(r.assetId));
      }

      if (status === "posted") {
        await rollbackInventoryByEntryId(trx, orgId, id);
      await deleteSystemEntriesForParent(trx, orgId, id);
      } else {
        await trx`DELETE FROM inventory_moves WHERE org_id = ${orgId} AND entry_id = ${id} AND status = 'draft'`;
      }
      await trx`DELETE FROM attachments WHERE org_id = ${orgId} AND entry_id = ${id}`;
      await trx`DELETE FROM journal_lines WHERE org_id = ${orgId} AND entry_id = ${id}`;
      await trx`DELETE FROM journal_entries WHERE org_id = ${orgId} AND id = ${id}`;

      for (const assetId of purchaseAssetIds) {
        const remaining = await trx`
          SELECT COUNT(1) as cnt
          FROM journal_lines
          WHERE org_id = ${orgId} AND fixed_asset_id = ${assetId}
        `;
        const cnt = Number((remaining[0] as any)?.cnt || 0);
        if (cnt === 0) {
          await trx`DELETE FROM depreciation_lines WHERE org_id = ${orgId} AND asset_id = ${assetId}`;
          await trx`DELETE FROM fixed_assets WHERE org_id = ${orgId} AND id = ${assetId}`;
        }
      }
    });

    res.status(200).json({ success: true, data: { id } });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Delete failed";
    if (msg.includes("Cannot rollback") || msg.includes("layer") || msg.includes("Insufficient")) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    const mapped = mapPgError(e);
    if (mapped) {
      console.error("[journals/delete]", { orgId, userId: req.auth?.userId, pgCode: e?.code, message: msg });
      res.status(mapped.status).json({ success: false, error: mapped.message, errorId: mapped.errorId });
      return;
    }
    const errorId = makeErrorId();
    console.error("[journals/delete]", { orgId, userId: req.auth?.userId, errorId, message: msg });
    await tryLogError(sql, { id: errorId, orgId, userId: req.auth?.userId || null, route: "journals/delete", message: msg, stack: e?.stack || null });
    res.status(500).json({ success: false, error: `Server internal error (ID ${errorId})`, errorId });
  }
});

router.post("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const lineSchema = z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    costCenterId: z.string().uuid().nullable().optional(),
    debitTxn: z.number().nonnegative().default(0),
    creditTxn: z.number().nonnegative().default(0),
  });
  const inventoryReceiptSchema = z
    .object({
      itemId: z.string().uuid(),
      qty: z.number().positive(),
      unitCostTxn: z.number().positive(),
    })
    .optional();

  const inventoryShipmentSchema = z
    .object({
      itemId: z.string().uuid(),
      qty: z.number().positive(),
    })
    .optional();

  const inventoryDetailReceiptSchema = z.object({
    moveType: z.literal("receipt"),
    itemId: z.string().uuid(),
    qty: z.number().positive(),
    unitCostTxn: z.number().positive(),
  });

  const inventoryDetailShipmentSchema = z.object({
    moveType: z.literal("shipment"),
    itemId: z.string().uuid(),
    qty: z.number().positive(),
  });

  const inventoryDetailsSchema = z.array(z.union([inventoryDetailReceiptSchema, inventoryDetailShipmentSchema])).min(1).optional();

  const bodySchema = z.object({
    entryDate: z.string().min(10),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    memo: z.string().optional(),
    inventoryImpact: z.boolean().optional().default(false),
    inventoryReceipt: inventoryReceiptSchema,
    inventoryShipment: inventoryShipmentSchema,
    inventoryDetails: inventoryDetailsSchema,
    inventoryLinkLineNo: z.number().int().positive().optional(),
    lines: z.array(lineSchema).min(2),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const { entryDate, currency, fxRate, memo, lines, inventoryImpact, inventoryReceipt, inventoryShipment } = parsed.data;

  const inventoryDetails:
    | Array<
        | { moveType: "receipt"; itemId: string; qty: number; unitCostTxn: number }
        | { moveType: "shipment"; itemId: string; qty: number }
      >
    | undefined =
    parsed.data.inventoryDetails ||
    (inventoryReceipt ? [{ moveType: "receipt", ...inventoryReceipt }] : inventoryShipment ? [{ moveType: "shipment", ...inventoryShipment }] : undefined);

  const inventoryLinkLineNo = parsed.data.inventoryLinkLineNo;
  const effectiveInventoryImpact = Boolean(inventoryImpact || (inventoryDetails && inventoryDetails.length));

  const normalizedLines = lines.map((l, idx) => {
    const debit = l.debitTxn || 0;
    const credit = l.creditTxn || 0;
    const debitBase = round2(debit * fxRate);
    const creditBase = round2(credit * fxRate);
    return {
      lineNo: idx + 1,
      accountId: l.accountId,
      description: l.description || null,
      costCenterId: l.costCenterId ?? null,
      debitTxn: debit,
      creditTxn: credit,
      debitBase,
      creditBase,
    };
  });

  if (effectiveInventoryImpact) {
    if (!inventoryDetails?.length) {
      res.status(400).json({ success: false, error: "Missing inventoryDetails" });
      return;
    }
    if (!inventoryLinkLineNo) {
      res.status(400).json({ success: false, error: "Missing inventoryLinkLineNo" });
      return;
    }

    const detailTypes = Array.from(new Set(inventoryDetails.map((d) => d.moveType)));
    if (detailTypes.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory details must be all receipt or all shipment" });
      return;
    }

    const linkedLine = normalizedLines.find((l) => l.lineNo === inventoryLinkLineNo);
    if (!linkedLine) {
      res.status(400).json({ success: false, error: "Invalid inventoryLinkLineNo" });
      return;
    }

    const debit = round2(linkedLine.debitTxn);
    const credit = round2(linkedLine.creditTxn);
    if (debit > 0 && credit > 0) {
      res.status(400).json({ success: false, error: "Inventory link line cannot have both debit and credit" });
      return;
    }
    const requestedMode = detailTypes[0];

    if (requestedMode === "receipt") {
      const receiptDetails = inventoryDetails.filter((d) => d.moveType === "receipt") as Array<{
        moveType: "receipt";
        itemId: string;
        qty: number;
        unitCostTxn: number;
      }>;
      if (!receiptDetails.length) {
        res.status(400).json({ success: false, error: "Missing receipt inventoryDetails" });
        return;
      }
      const expectedTxn = round2(receiptDetails.reduce((s, d) => s + round2(d.qty * d.unitCostTxn), 0));
      const existingTxn = debit > 0 ? debit : credit > 0 ? credit : 0;
      if (existingTxn > 0 && round2(existingTxn) !== round2(expectedTxn)) {
        res.status(400).json({ success: false, error: `Inventory total mismatch: entry ${round2(existingTxn)} vs receipt ${expectedTxn}` });
        return;
      }
    } else if (requestedMode === "shipment") {
      const shipmentDetails = inventoryDetails.filter((d) => d.moveType === "shipment");
      if (!shipmentDetails.length) {
        res.status(400).json({ success: false, error: "Missing shipment inventoryDetails" });
        return;
      }
    }
  }

  const created = await sql.begin(async (trx) => {
    const voucherNo = await issueVoucherNo(trx, orgId);
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, voucher_no, parent_entry_id, is_system, currency_code, fx_rate, memo, created_by, inventory_impact)
        VALUES (${orgId}, ${entryDate}, 'draft', ${voucherNo}, NULL, false, ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${effectiveInventoryImpact})
        RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, voucher_no as "voucherNo", currency_code as "currency", fx_rate as "fxRate", memo
      `
    )[0];

    if (effectiveInventoryImpact && inventoryDetails?.length) {
      for (const d of inventoryDetails) {
        if (d.moveType === "receipt") {
          const unitCostBase = round6(d.unitCostTxn * fxRate);
          await trx`
            INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id, entry_line_no)
            VALUES (
              ${orgId},
              ${d.itemId},
              'receipt',
              ${entryDate},
              ${d.qty},
              ${unitCostBase},
              ${round6(d.unitCostTxn)},
              ${currency.toUpperCase()},
              ${fxRate},
              'draft',
              ${entry.id},
              ${inventoryLinkLineNo || null}
            )
          `;
        }
        if (d.moveType === "shipment") {
          await trx`
            INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id, entry_line_no)
            VALUES (
              ${orgId},
              ${d.itemId},
              'shipment',
              ${entryDate},
              ${d.qty},
              ${null},
              ${null},
              ${currency.toUpperCase()},
              ${fxRate},
              'draft',
              ${entry.id},
              ${inventoryLinkLineNo || null}
            )
          `;
        }
      }
    }

    for (const l of normalizedLines) {
      await trx`
        INSERT INTO journal_lines (
          org_id, entry_id, line_no, account_id, description, cost_center_id,
          debit_txn, credit_txn, debit_base, credit_base
        ) VALUES (
          ${orgId}, ${entry.id}, ${l.lineNo}, ${l.accountId}, ${l.description}, ${l.costCenterId},
          ${l.debitTxn}, ${l.creditTxn}, ${l.debitBase}, ${l.creditBase}
        )
      `;
    }
    return entry;
  });

  res.status(200).json({ success: true, data: { entry: created } });
});

router.post("/:id/post", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const id = req.params.id;

  const fixedAssetPurchaseSchema = z.object({
    lineNo: z.number().int().positive(),
    category: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z.enum(FIXED_ASSET_CATEGORIES as unknown as [string, ...string[]]),
    ),
    assetNo: z
      .preprocess(
        (v) => {
          if (typeof v !== "string") return undefined;
          const s = v.trim().toUpperCase();
          return s ? s : undefined;
        },
        z.string().min(5).max(32).optional(),
      )
      .optional(),
    name: z.string().min(1),
    acquisitionDate: z.string().min(10),
    usefulLifeMonths: z.number().int().positive(),
    salvageBase: z.number().nonnegative().default(0),
  });
  const parsedBody = z
    .object({
      fixedAssetPurchases: z.array(fixedAssetPurchaseSchema).optional(),
    })
    .safeParse(req.body && typeof req.body === "object" ? req.body : {});
  if (!parsedBody.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const fixedAssetPurchases = parsedBody.data.fixedAssetPurchases;

  const entryRows = await sql`
    SELECT id, status, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", currency_code as "currency", fx_rate as "fxRate", inventory_impact as "inventoryImpact"
    FROM journal_entries
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `;
  const entry = entryRows[0] as any;
  if (!entry) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  if (entry.status !== "draft") {
    res.status(409).json({ success: false, error: "Already posted" });
    return;
  }

  const sums = await sql`
    SELECT
      COALESCE(SUM(debit_base), 0) as debit,
      COALESCE(SUM(credit_base), 0) as credit
    FROM journal_lines
    WHERE entry_id = ${id} AND org_id = ${orgId}
  `;
  const debit = Number((sums[0] as any).debit);
  const credit = Number((sums[0] as any).credit);
  if (round2(debit) !== round2(credit)) {
    res.status(400).json({ success: false, error: `Unbalanced entry: debit ${debit} credit ${credit}` });
    return;
  }
  if (round2(debit) <= 0) {
    res.status(400).json({ success: false, error: "Entry amount must be greater than 0" });
    return;
  }
  if (entry.inventoryImpact) {
    const moveRows = await sql`
      SELECT id, move_type as "moveType", entry_line_no as "entryLineNo"
      FROM inventory_moves
      WHERE org_id = ${orgId} AND entry_id = ${id} AND status = 'draft'
      ORDER BY created_at ASC
    `;
    if (!moveRows.length) {
      res.status(400).json({ success: false, error: "Inventory impact entry missing draft inventory move" });
      return;
    }
    const types = Array.from(new Set((moveRows as any[]).map((m) => String(m.moveType || ""))));
    if (types.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory moves must be all receipt or all shipment" });
      return;
    }
    const mt = types[0];
    if (mt !== "receipt" && mt !== "shipment") {
      res.status(400).json({ success: false, error: "Unsupported inventory move type" });
      return;
    }

    const linkLines = Array.from(new Set((moveRows as any[]).map((m) => Number(m.entryLineNo) || 0).filter((x) => x > 0)));
    if (linkLines.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory moves must share exactly one linked journal line" });
      return;
    }
  }

  let accumDepAccountId: string | null = null;
  let depExpenseAccountId: string | null = null;
  if (fixedAssetPurchases?.length) {
    const uniqueLineNos = new Set(fixedAssetPurchases.map((p) => p.lineNo));
    if (uniqueLineNos.size !== fixedAssetPurchases.length) {
      res.status(400).json({ success: false, error: "Duplicate fixed asset purchase lineNo" });
      return;
    }
    const lineNos = fixedAssetPurchases.map((p) => p.lineNo);
    const existingLines = await sql`
      SELECT DISTINCT line_no as "lineNo"
      FROM journal_lines
      WHERE org_id = ${orgId} AND entry_id = ${id} AND line_no = ANY(${lineNos}::int[])
    `;
    const existingSet = new Set((existingLines as any[]).map((r) => Number(r.lineNo)));
    for (const ln of lineNos) {
      if (!existingSet.has(Number(ln))) {
        res.status(400).json({ success: false, error: "Invalid fixed asset purchase lineNo" });
        return;
      }
    }
    const accumAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1610' LIMIT 1`;
    const depExpAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '6100' LIMIT 1`;
    accumDepAccountId = accumAcc[0]?.id || null;
    depExpenseAccountId = depExpAcc[0]?.id || null;
    if (!accumDepAccountId || !depExpenseAccountId) {
      res.status(400).json({ success: false, error: "Missing default fixed asset accounts" });
      return;
    }
  }

  try {
    await sql.begin(async (trx) => {
      const vRows = await trx`SELECT voucher_no as "voucherNo" FROM journal_entries WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`;
      const currentVoucherNo = (vRows[0] as any)?.voucherNo as string | null | undefined;
      if (!currentVoucherNo) {
        const voucherNo = await issueVoucherNo(trx, orgId);
        await trx`UPDATE journal_entries SET voucher_no = ${voucherNo} WHERE id = ${id} AND org_id = ${orgId}`;
      }

      if (fixedAssetPurchases?.length && accumDepAccountId && depExpenseAccountId) {
        for (const p of fixedAssetPurchases) {
          const lineRows = await trx`
            SELECT account_id as "accountId", debit_base as "debitBase", credit_base as "creditBase"
            FROM journal_lines
            WHERE org_id = ${orgId} AND entry_id = ${id} AND line_no = ${p.lineNo}
            LIMIT 1
          `;
          const line = (lineRows as any[])[0];
          if (!line) {
            throw new Error("Invalid fixed asset purchase lineNo");
          }
          const category = normalizeFixedAssetCategory(p.category);
          const costBase = round2(Number(line.debitBase) > 0 ? Number(line.debitBase) : Number(line.creditBase));
          if (!(costBase > 0)) {
            throw new Error("Fixed asset cost must be greater than 0");
          }

          const desiredNo = p.assetNo ? String(p.assetNo).trim().toUpperCase() : "";
          if (desiredNo) {
            const exists = await trx`
              SELECT id
              FROM fixed_assets
              WHERE org_id = ${orgId} AND asset_no = ${desiredNo}
              LIMIT 1
            `;
            if (exists.length) {
              throw new Error("固定资产编号已存在");
            }
          }
          const assetNo = desiredNo || (await issueFixedAssetNo(trx, orgId, category));
          const asset = (
            await trx`
              INSERT INTO fixed_assets (
                org_id, name, acquisition_date, cost_base, useful_life_months, salvage_value_base,
                status, asset_account_id, accum_dep_account_id, dep_expense_account_id,
                category, asset_no
              ) VALUES (
                ${orgId}, ${p.name.trim()}, ${p.acquisitionDate}, ${costBase}, ${p.usefulLifeMonths}, ${p.salvageBase},
                'active', ${String(line.accountId)}, ${accumDepAccountId}, ${depExpenseAccountId},
                ${category}, ${assetNo}
              )
              RETURNING id
            `
          )[0] as any;
          await trx`
            UPDATE journal_lines
            SET fixed_asset_id = ${asset.id}
            WHERE org_id = ${orgId} AND entry_id = ${id} AND line_no = ${p.lineNo}
          `;
        }
      }

      if (entry.inventoryImpact) {
        const moves = await trx`
          SELECT id, item_id as "itemId", move_type as "moveType", qty, unit_cost_base as "unitCostBase", entry_line_no as "entryLineNo"
          FROM inventory_moves
          WHERE org_id = ${orgId} AND entry_id = ${id} AND status = 'draft'
          ORDER BY created_at ASC
        `;
        const ms = moves as any[];
        if (!ms.length) {
          throw new Error("Inventory impact entry missing draft inventory move");
        }

        const types = Array.from(new Set(ms.map((m) => String(m.moveType || ""))));
        if (types.length !== 1) {
          throw new Error("Inventory moves must be all receipt or all shipment");
        }
        const moveType = types[0];

        const linkLines = Array.from(new Set(ms.map((m) => Number(m.entryLineNo) || 0).filter((x) => x > 0)));
        if (linkLines.length !== 1) {
          throw new Error("Inventory moves must share exactly one linked journal line");
        }
        const linkLineNo = linkLines[0];

        if (moveType === "receipt") {
          const moveIds = ms.map((m) => String(m.id));
          await trx`
            WITH m AS (
              SELECT id, org_id, item_id, move_date, qty, unit_cost_base
              FROM inventory_moves
              WHERE org_id = ${orgId} AND id = ANY(${moveIds}::uuid[])
              FOR UPDATE
            ),
            ins_layers AS (
              INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id, source_move_id)
              SELECT org_id, item_id, move_date, qty, unit_cost_base, ${id}, id
              FROM m
              RETURNING id, source_move_id
            )
            UPDATE inventory_moves mv
            SET status = 'posted', created_layer_id = l.id
            FROM ins_layers l
            WHERE mv.org_id = ${orgId} AND mv.id = l.source_move_id
          `;
        }

        if (moveType === "shipment") {
          const linkedLineRows = await trx`
            SELECT debit_base as "debitBase", credit_base as "creditBase"
            FROM journal_lines
            WHERE org_id = ${orgId} AND entry_id = ${id} AND line_no = ${linkLineNo}
            LIMIT 1
          `;
          const linkedLine = (linkedLineRows as any[])[0];
          const debitBase = round2(Number(linkedLine?.debitBase || 0));
          const creditBase = round2(Number(linkedLine?.creditBase || 0));
          if (debitBase > 0 && creditBase > 0) {
            throw new Error("Inventory shipment linked line cannot have both debit and credit");
          }
          const expectedBase = debitBase > 0 ? debitBase : creditBase;
          if (expectedBase <= 0) {
            throw new Error("Inventory shipment linked line amount must be greater than 0");
          }

          const fx = Number(entry.fxRate);
          let totalBaseAll = 0;
          for (const m of ms) {
            const layers = await trx`
              SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
              FROM inventory_layers
              WHERE org_id = ${orgId} AND item_id = ${m.itemId} AND qty_remaining > 0
              ORDER BY received_date ASC, created_at ASC
              FOR UPDATE
            `;

            let remaining = Number(m.qty);
            const breakdown: Array<{ layerId: string; qty: number; amountBase: number }> = [];
            for (const row of layers as any[]) {
              if (remaining <= 0) break;
              const qtyAvail = Number(row.qtyRemaining);
              const take = Math.min(remaining, qtyAvail);
              const unitCostBase = Number(row.unitCostBase);
              const amountBase = round2(take * unitCostBase);
              breakdown.push({ layerId: row.id, qty: take, amountBase });
              remaining = round6(remaining - take);
            }
            if (remaining > 0) {
              throw new Error("Insufficient stock");
            }
            const totalBase = round2(breakdown.reduce((s, x) => s + x.amountBase, 0));
            totalBaseAll = round2(totalBaseAll + totalBase);

            for (const b of breakdown) {
              await trx`
                UPDATE inventory_layers
                SET qty_remaining = qty_remaining - ${b.qty}
                WHERE id = ${b.layerId} AND org_id = ${orgId}
              `;
            }

            const unitCostBase = round6(totalBase / Number(m.qty));
            const unitCostTxn = fx > 0 ? round6(unitCostBase / fx) : null;
            await trx`
              UPDATE inventory_moves
              SET unit_cost_base = ${unitCostBase}, unit_cost_txn = ${unitCostTxn}, currency_code = ${String(entry.currency || "BASE").toUpperCase()}, fx_rate = ${fx}, status = 'posted'
              WHERE id = ${m.id} AND org_id = ${orgId}
            `;
          }

          if (round2(totalBaseAll) !== round2(expectedBase)) {
            throw new Error(`Inventory cost mismatch: entry ${expectedBase} vs FIFO ${totalBaseAll}`);
          }
        }
      }

      await trx`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = ${id} AND org_id = ${orgId}`;

      const faIds = await trx`
        SELECT DISTINCT fixed_asset_id as id
        FROM journal_lines
        WHERE org_id = ${orgId} AND entry_id = ${id} AND fixed_asset_id IS NOT NULL
      `;
      const ids = (faIds as any[]).map((r) => r.id).filter(Boolean);
      if (ids.length) {
        await trx`UPDATE fixed_assets SET status = 'active' WHERE org_id = ${orgId} AND id = ANY(${ids}::uuid[]) AND status = 'draft'`;
      }
    });

    res.status(200).json({ success: true });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Post failed";
    if (
      msg.includes("Insufficient stock") ||
      msg.includes("Inventory cost mismatch") ||
      msg.includes("Inventory impact") ||
      msg.includes("Inventory shipment") ||
      msg.includes("Missing inventory") ||
      msg.toLowerCase().includes("fixed asset")
    ) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    res.status(500).json({ success: false, error: "Server internal error" });
  }
});

router.post(
  "/:id/attachments",
  requireAuth,
  upload.single("file"),
  async (req: AuthedRequest, res: Response) => {
    await ensureMigrated();
    const orgId = requireOrgId(req, res);
    if (!orgId) return;
    const sql = getSql();
    const id = req.params.id;

    const entryRows = await sql`SELECT id FROM journal_entries WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`;
    if (!entryRows.length) {
      res.status(404).json({ success: false, error: "Not found" });
      return;
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ success: false, error: "Missing file" });
      return;
    }

    const base64 = file.buffer.toString("base64");
    const row = (
      await sql`
        INSERT INTO attachments (org_id, entry_id, file_name, mime_type, size_bytes, data_base64)
        VALUES (${orgId}, ${id}, ${file.originalname}, ${file.mimetype}, ${file.size}, ${base64})
        RETURNING id, file_name as "fileName", mime_type as "mimeType", size_bytes as "sizeBytes", created_at as "createdAt"
      `
    )[0];
    res.status(200).json({ success: true, data: { attachment: row } });
  },
);

router.get("/:id/attachments/:attachmentId", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const row = (
    await sql`
      SELECT file_name as fileName, mime_type as mimeType, data_base64 as dataBase64
      FROM attachments
      WHERE id = ${req.params.attachmentId} AND entry_id = ${req.params.id} AND org_id = ${orgId}
      LIMIT 1
    `
  )[0] as any;
  if (!row) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const buf = Buffer.from(row.dataBase64 || "", "base64");
  res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
  res.status(200).send(buf);
});

export default router;
