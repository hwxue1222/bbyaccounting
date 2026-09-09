import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2, round6 } from "../lib/nums.js";

const router = Router();
const upload = multer({ limits: { fileSize: 2 * 1024 * 1024 } });

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
      (SELECT COALESCE(SUM(debit_base),0) FROM journal_lines l WHERE l.entry_id = e.id) as totalDebitBase
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
  let invDebitTxn = 0;
  let invCreditTxn = 0;

  if (inventoryImpact) {
    if (!inventoryDetails?.length) {
      res.status(400).json({ success: false, error: "Missing inventoryDetails" });
      return;
    }

    const detailTypes = Array.from(new Set(inventoryDetails.map((d) => d.moveType)));
    if (detailTypes.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory details must be all receipt or all shipment" });
      return;
    }

    const invAcc = await sql`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1500' LIMIT 1`;
    const invAccId = invAcc[0]?.id as string | undefined;
    if (!invAccId) {
      res.status(400).json({ success: false, error: "Missing inventory account (code 1500)" });
      return;
    }
    const invLines = normalizedLines.filter((l) => l.accountId === invAccId);
    if (invLines.length !== 1) {
      res.status(400).json({ success: false, error: "Inventory impact requires exactly one Inventory (1500) line" });
      return;
    }

    invDebitTxn = round2(invLines[0].debitTxn);
    invCreditTxn = round2(invLines[0].creditTxn);
    if (invDebitTxn > 0 && invCreditTxn > 0) {
      res.status(400).json({ success: false, error: "Inventory (1500) line cannot have both debit and credit" });
      return;
    }

    if (invDebitTxn > 0) {
      inventoryMode = "receipt";
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
      if (round2(invDebitTxn) !== round2(expectedTxn)) {
        res.status(400).json({ success: false, error: `Inventory total mismatch: entry ${round2(invDebitTxn)} vs receipt ${expectedTxn}` });
        return;
      }
    } else if (invCreditTxn > 0) {
      inventoryMode = "shipment";
      const shipmentDetails = inventoryDetails.filter((d) => d.moveType === "shipment");
      if (!shipmentDetails.length) {
        res.status(400).json({ success: false, error: "Missing shipment inventoryDetails" });
        return;
      }
    } else {
      res.status(400).json({ success: false, error: "Inventory (1500) line amount must be greater than 0" });
      return;
    }

    if (detailTypes[0] !== inventoryMode) {
      res.status(400).json({ success: false, error: "Inventory details type does not match 1500 Inventory debit/credit" });
      return;
    }
  }

  const created = await sql.begin(async (trx) => {
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by, inventory_impact)
        VALUES (${orgId}, ${entryDate}, 'draft', ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId}, ${inventoryImpact})
        RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, currency_code as "currency", fx_rate as "fxRate", memo
      `
    )[0];

    if (inventoryImpact && inventoryDetails?.length) {
      for (const d of inventoryDetails) {
        if (d.moveType === "receipt") {
          const unitCostBase = round6(d.unitCostTxn * fxRate);
          await trx`
            INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id)
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
              ${entry.id}
            )
          `;
        }
        if (d.moveType === "shipment") {
          await trx`
            INSERT INTO inventory_moves (org_id, item_id, move_type, move_date, qty, unit_cost_base, unit_cost_txn, currency_code, fx_rate, status, entry_id)
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
              ${entry.id}
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
      SELECT id, move_type as "moveType"
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
  }

  try {
    await sql.begin(async (trx) => {
      if (entry.inventoryImpact) {
        const moves = await trx`
          SELECT id, item_id as "itemId", move_type as "moveType", qty, unit_cost_base as "unitCostBase"
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
          const invAcc = await trx`SELECT id FROM accounts WHERE org_id = ${orgId} AND code = '1500' LIMIT 1`;
          const invAccId = (invAcc[0] as any)?.id as string | undefined;
          if (!invAccId) {
            throw new Error("Missing inventory account (code 1500)");
          }
          const invLineRows = await trx`
            SELECT debit_base as "debitBase", credit_base as "creditBase"
            FROM journal_lines
            WHERE org_id = ${orgId} AND entry_id = ${id} AND account_id = ${invAccId}
            LIMIT 1
          `;
          const invLine = (invLineRows as any[])[0];
          const expectedBase = round2(Number(invLine?.creditBase || 0));
          if (round2(Number(invLine?.debitBase || 0)) > 0 || expectedBase <= 0) {
            throw new Error("Inventory shipment requires credit on Inventory (1500) line");
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
