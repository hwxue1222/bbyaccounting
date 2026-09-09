import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { round2 } from "../lib/nums.js";

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
  const bodySchema = z.object({
    entryDate: z.string().min(10),
    currency: z.string().min(3).max(3),
    fxRate: z.number().positive().default(1),
    memo: z.string().optional(),
    inventoryImpact: z.boolean().optional().default(false),
    lines: z.array(lineSchema).min(2),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const { entryDate, currency, fxRate, memo, lines, inventoryImpact } = parsed.data;

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

  const created = await sql.begin(async (trx) => {
    const entry = (
      await trx`
        INSERT INTO journal_entries (org_id, entry_date, status, currency_code, fx_rate, memo, created_by)
        VALUES (${orgId}, ${entryDate}, 'draft', ${currency.toUpperCase()}, ${fxRate}, ${memo || null}, ${req.auth!.userId})
        RETURNING id, to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status, currency_code as "currency", fx_rate as "fxRate", memo
      `
    )[0];
    await trx`UPDATE journal_entries SET inventory_impact = ${inventoryImpact} WHERE id = ${entry.id} AND org_id = ${orgId}`;
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
    SELECT id, status
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
  await sql`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = ${id} AND org_id = ${orgId}`;
  res.status(200).json({ success: true });
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
