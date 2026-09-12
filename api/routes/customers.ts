import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";

const router = Router();

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
    SELECT id, code, name, notes, is_active as "isActive", created_at as "createdAt"
    FROM customers
    WHERE org_id = ${orgId}
    ORDER BY is_active DESC, code ASC NULLS LAST, name ASC
  `;
  res.status(200).json({ success: true, data: { customers: rows } });
});

router.post("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const body = z
    .object({
      code: z
        .preprocess(
          (v) => {
            if (typeof v !== "string") return undefined;
            const s = v.trim().toUpperCase();
            return s ? s : undefined;
          },
          z.string().min(2).max(32).optional(),
        )
        .optional(),
      name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(128)),
      notes: z.preprocess(
        (v) => {
          if (typeof v !== "string") return undefined;
          const s = v.trim();
          return s ? s : undefined;
        },
        z.string().max(2000).optional(),
      ),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const userId = req.auth!.userId;

  const row = (
    await sql`
      INSERT INTO customers (org_id, code, name, notes, is_active, created_at)
      VALUES (${orgId}, ${body.data.code || null}, ${body.data.name}, ${body.data.notes || null}, true, now())
      RETURNING id, code, name, notes, is_active as "isActive", created_at as "createdAt"
    `
  )[0] as any;

  res.status(200).json({ success: true, data: { customer: row, createdBy: userId } });
});

router.patch("/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;

  const body = z
    .object({
      code: z
        .preprocess(
          (v) => {
            if (v === null) return null;
            if (typeof v !== "string") return undefined;
            const s = v.trim().toUpperCase();
            return s ? s : null;
          },
          z.string().min(2).max(32).nullable().optional(),
        )
        .optional(),
      name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(1).max(128)).optional(),
      notes: z
        .preprocess(
          (v) => {
            if (v === null) return null;
            if (typeof v !== "string") return undefined;
            const s = v.trim();
            return s ? s : null;
          },
          z.string().max(2000).nullable().optional(),
        )
        .optional(),
      isActive: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const existing = await sql`SELECT id FROM customers WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`;
  if (!existing.length) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  const patch = body.data;
  const code = typeof patch.code === "string" ? patch.code.trim().toUpperCase() : undefined;
  const name = typeof patch.name === "string" ? patch.name.trim() : undefined;
  const notes = typeof patch.notes === "string" ? patch.notes.trim() : undefined;
  const isActive = patch.isActive;
  const next = (
    await sql`
      UPDATE customers
      SET
        code = COALESCE(${code ?? null}, code),
        name = COALESCE(${name ?? null}, name),
        notes = COALESCE(${notes ?? null}, notes),
        is_active = COALESCE(${isActive ?? null}, is_active)
      WHERE org_id = ${orgId} AND id = ${id}
      RETURNING id, code, name, notes, is_active as "isActive", created_at as "createdAt"
    `
  )[0] as any;

  res.status(200).json({ success: true, data: { customer: next } });
});

export default router;
