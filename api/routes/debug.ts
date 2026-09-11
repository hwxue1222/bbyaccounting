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

router.get("/errors/:id", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const schema = z.object({ id: z.string().uuid() });
  const parsed = schema.safeParse({ id: req.params.id });
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid id" });
    return;
  }

  const sql = getSql();
  const rows = await sql`
    SELECT id, route, message, created_at as "createdAt"
    FROM error_logs
    WHERE id = ${parsed.data.id} AND (org_id = ${orgId} OR org_id IS NULL)
    LIMIT 1
  `;
  if (!rows.length) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const r = rows[0] as any;
  res.status(200).json({ success: true, data: { error: { id: String(r.id), route: r.route, message: r.message, createdAt: r.createdAt } } });
});

router.get("/errors", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;
  const limit = typeof req.query.limit === "string" ? Math.min(50, Math.max(1, Number(req.query.limit) || 10)) : 10;
  const sql = getSql();
  const rows = await sql`
    SELECT id, route, message, created_at as "createdAt"
    FROM error_logs
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  res.status(200).json({
    success: true,
    data: {
      errors: (rows as any[]).map((r) => ({ id: String(r.id), route: r.route, message: r.message, createdAt: r.createdAt })),
    },
  });
});

export default router;

