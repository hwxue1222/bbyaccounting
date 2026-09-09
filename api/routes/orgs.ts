import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, setSessionCookie, type AuthedRequest } from "../lib/auth.js";
import { signSession } from "../lib/security.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const sql = getSql();
  const rows = await sql`
    SELECT
      o.id as "orgId",
      o.name as "orgName",
      o.base_currency as "baseCurrency",
      m.role as "role"
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ${req.auth!.userId} AND m.status = 'active'
    ORDER BY o.created_at ASC
  `;
  res.status(200).json({ success: true, data: { orgs: rows, activeOrgId: req.auth!.orgId } });
});

router.post("/switch", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const bodySchema = z.object({ orgId: z.string().uuid() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const ok = await sql`
    SELECT id FROM memberships
    WHERE user_id = ${req.auth!.userId} AND org_id = ${parsed.data.orgId} AND status = 'active'
    LIMIT 1
  `;
  if (!ok.length) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: parsed.data.orgId }));
  res.status(200).json({ success: true, data: { orgId: parsed.data.orgId } });
});

export default router;
