import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "crypto";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2, round6 } from "../lib/nums.js";

const router = Router();
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

function makeErrorId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function mapPgError(e: any): { status: number; message: string } | null {
  const code = typeof e?.code === "string" ? e.code : null;
  if (!code) return null;

  const id = makeErrorId();

  if (code === "22P02") return { status: 400, message: `字段格式不正确（ID ${id}）` };
  if (code === "23502") return { status: 400, message: `缺少必填字段（ID ${id}）` };
  if (code === "23505") return { status: 409, message: `数据重复（唯一约束冲突，ID ${id}）` };
  if (code === "40001") return { status: 409, message: `并发冲突，请重试（ID ${id}）` };
  if (code === "42P01") return { status: 500, message: `数据库表缺失（可能迁移未完成，ID ${id}）` };
  if (code === "42703") return { status: 500, message: `数据库字段缺失（可能迁移未完成，ID ${id}）` };
  return { status: 500, message: `数据库错误 ${code}（ID ${id}）` };
}

function requireOrgId(req: AuthedRequest, res: Response): string | null {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }
  return orgId;
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
      e.currency_code as "currency",
      e.fx_rate as "fxRate",
      e.memo,
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

router.get("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const sql = getSql();
  const id = req.params.id;
  const entries = await sql`
    SELECT id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, currency_code as "currency", fx_rate as "fxRate", memo, inventory_impact as "inventoryImpact"
    FROM journal_entries
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `;
  const entry = entries[0];
  if (!entry) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const lines = await sql`
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
  `;
  const atts = await sql`
    SELECT id, file_name as "fileName", mime_type as "mimeType", size_bytes as "sizeBytes", created_at as "createdAt"
    FROM attachments
    WHERE entry_id = ${id} AND org_id = ${orgId}
    ORDER BY created_at DESC
  `;
  res.status(200).json({ success: true, data: { entry, lines, attachments: atts } });
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
  });

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
    inventoryDetails: inventoryDetailsSchema,
    inventoryLinkLineNo: z.number().int().positive().optional(),
    shipmentInventoryAccountId: z.string().uuid().optional(),
    shipmentCogsAccountId: z.string().uuid().optional(),
    lines: z.array(lineSchema).min(2),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const { entryDate, currency, fxRate, memo, lines } = parsed.data;
  const inventoryDetails = parsed.data.inventoryDetails;
  const inventoryLinkLineNo = parsed.data.inventoryLinkLineNo;
  const shipmentInventoryAccountId = parsed.data.shipmentInventoryAccountId;
  const shipmentCogsAccountId = parsed.data.shipmentCogsAccountId;
  const effectiveInventoryImpact = Boolean(inventoryDetails && inventoryDetails.length);

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

  try {
    const created = await sql.begin(async (trx) => {
      const entry = (
        await trx`
          INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, inventory_impact, posted_at)
          VALUES (${orgId}, ${entryDate}, 'posted', ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${effectiveInventoryImpact}, now())
          RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, currency_code as "currency", fx_rate as "fxRate", memo
        `
      )[0] as any;

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

      if (effectiveInventoryImpact && inventoryDetails?.length && linkLineNo) {
        if (inventoryMode === "receipt") {
          for (const d of inventoryDetails as any[]) {
            const unitCostBase = round6(Number(d.unitCostTxn) * fxRate);
            await trx`
              INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id, entry_line_no)
              VALUES (
                ${orgId},
                ${d.itemId},
                'receipt',
                ${entryDate},
                ${d.qty},
                ${unitCostBase},
                ${round6(Number(d.unitCostTxn))},
                ${currency.toUpperCase()},
                ${fxRate},
                'posted',
                ${entry.id},
                ${linkLineNo}
              )
            `;
            await trx`
              INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id)
              VALUES (${orgId}, ${d.itemId}, ${entryDate}, ${d.qty}, ${unitCostBase}, ${entry.id})
            `;
          }
        }

        if (inventoryMode === "shipment") {
          const fx = Number(fxRate);
          let totalBaseAll = 0;

          const moveRows = (
            await trx`
              INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id, entry_line_no)
              SELECT
                ${orgId},
                (d->>'itemId')::uuid,
                'shipment',
                ${entryDate},
                (d->>'qty')::numeric,
                NULL,
                NULL,
                ${currency.toUpperCase()},
                ${fxRate},
                'posted',
                ${entry.id},
                ${linkLineNo}
              FROM jsonb_array_elements(${JSON.stringify(inventoryDetails)}::jsonb) d
              RETURNING id, item_id as "itemId", qty
            `
          ) as any[];

          for (const m of moveRows) {
            const layers = await trx`
              SELECT id, qty_remaining as "qtyRemaining", unit_cost_base as "unitCostBase", received_date as "receivedDate"
              FROM inventory_layers
              WHERE org_id = ${orgId} AND item_id = ${m.itemId} AND qty_remaining > 0
              ORDER BY received_date ASC, id ASC
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
              SET unit_cost_base = ${unitCostBase}, unit_cost_txn = ${unitCostTxn}
              WHERE id = ${m.id} AND org_id = ${orgId}
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
              const nextLineNo = normalizedLines.length + 1;
              await trx`
                INSERT INTO journal_lines (
                  org_id, entry_id, line_no, account_id, description, cost_center_id,
                  debit_txn, credit_txn, debit_base, credit_base
                ) VALUES (
                  ${orgId}, ${entry.id}, ${nextLineNo}, ${cogsAccId}, 'COGS (FIFO)', NULL,
                  ${costTxn}, 0, ${costBase}, 0
                )
              `;
              await trx`
                INSERT INTO journal_lines (
                  org_id, entry_id, line_no, account_id, description, cost_center_id,
                  debit_txn, credit_txn, debit_base, credit_base
                ) VALUES (
                  ${orgId}, ${entry.id}, ${nextLineNo + 1}, ${invAccId}, 'Inventory (FIFO)', NULL,
                  0, ${costTxn}, 0, ${costBase}
                )
              `;
            }
          } catch {
            // ignore
          }
        }
      }

      return entry;
    });

    res.status(200).json({ success: true, data: { entry: created } });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Post failed";
    if (msg.includes("Insufficient stock") || msg.includes("Missing shipment cost accounts") || msg.includes("Inventory cost mismatch") || msg.includes("Inventory")) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    const mapped = mapPgError(e);
    if (mapped) {
      console.error("[journals/post]", { orgId, userId: req.auth?.userId, pgCode: e?.code, message: msg });
      res.status(mapped.status).json({ success: false, error: mapped.message });
      return;
    }
    const errorId = makeErrorId();
    console.error("[journals/post]", { orgId, userId: req.auth?.userId, errorId, message: msg });
    res.status(500).json({ success: false, error: `Server internal error (ID ${errorId})` });
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
  if (status !== "draft") {
    res.status(400).json({ success: false, error: "Only draft entries can be deleted" });
    return;
  }

  await sql.begin(async (trx) => {
    await trx`DELETE FROM attachments WHERE org_id = ${orgId} AND entry_id = ${id}`;
    await trx`DELETE FROM inventory_moves WHERE org_id = ${orgId} AND entry_id = ${id} AND status = 'draft'`;
    await trx`DELETE FROM journal_lines WHERE org_id = ${orgId} AND entry_id = ${id}`;
    await trx`DELETE FROM journal_entries WHERE org_id = ${orgId} AND id = ${id}`;
  });

  res.status(200).json({ success: true, data: { id } });
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

  let inventoryMode: "none" | "receipt" | "shipment" = "none";

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
    inventoryMode = requestedMode;

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
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, inventory_impact)
        VALUES (${orgId}, ${entryDate}, 'draft', ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${effectiveInventoryImpact})
        RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, currency_code as "currency", fx_rate as "fxRate", memo
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

  try {
    await sql.begin(async (trx) => {
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
          for (const m of ms) {
            await trx`
              INSERT INTO inventory_layers (org_id, item_id, received_date, qty_remaining, unit_cost_base, source_entry_id)
              VALUES (${orgId}, ${m.itemId}, ${entry.entryDate}, ${m.qty}, ${m.unitCostBase}, ${id})
            `;
            await trx`UPDATE inventory_moves SET status = 'posted' WHERE id = ${m.id} AND org_id = ${orgId}`;
          }
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
    });

    res.status(200).json({ success: true });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Post failed";
    if (
      msg.includes("Insufficient stock") ||
      msg.includes("Inventory cost mismatch") ||
      msg.includes("Inventory impact") ||
      msg.includes("Inventory shipment") ||
      msg.includes("Missing inventory")
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
