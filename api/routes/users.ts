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

async function getMyMembershipRole(sql: ReturnType<typeof getSql>, orgId: string, userId: string): Promise<string | null> {
  const rows = await sql`
    SELECT role
    FROM memberships
    WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'active'
    LIMIT 1
  `;
  return rows.length ? String((rows[0] as any).role) : null;
}

async function requireOwnerOrAdmin(req: AuthedRequest, res: Response, orgId: string): Promise<string | null> {
  const sql = getSql();
  const role = await getMyMembershipRole(sql, orgId, req.auth!.userId);
  if (!role) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
  return role;
}

router.get("/members", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const role = await requireOwnerOrAdmin(req, res, orgId);
  if (!role) return;

  const sql = getSql();
  const rows = await sql`
    SELECT
      m.id,
      m.user_id as "userId",
      u.email,
      m.role,
      m.status,
      m.created_at as "createdAt"
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${orgId}
    ORDER BY m.created_at ASC
  `;
  res.status(200).json({ success: true, data: { members: rows } });
});

router.patch("/members/:membershipId", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = requireOrgId(req, res);
  if (!orgId) return;

  const myRole = await requireOwnerOrAdmin(req, res, orgId);
  if (!myRole) return;

  const bodySchema = z.object({
    role: z.enum(["owner", "admin", "accountant", "viewer", "auditor"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ success: false, error: "No changes" });
    return;
  }

  if (myRole !== "owner" && parsed.data.role) {
    res.status(403).json({ success: false, error: "Only owner can change roles" });
    return;
  }

  const sql = getSql();
  const membershipId = req.params.membershipId;
  const rows = await sql`
    SELECT id, user_id as "userId", role, status
    FROM memberships
    WHERE id = ${membershipId} AND org_id = ${orgId}
    LIMIT 1
  `;
  const target = rows[0] as any;
  if (!target) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }

  if (String(target.userId) === req.auth!.userId) {
    res.status(400).json({ success: false, error: "Cannot modify yourself" });
    return;
  }

  const nextRole = parsed.data.role ?? String(target.role);
  const nextStatus = parsed.data.status ?? String(target.status);

  if (String(target.role) === "owner") {
    res.status(400).json({ success: false, error: "Cannot modify owner membership" });
    return;
  }

  if (nextRole === "owner") {
    res.status(400).json({ success: false, error: "Cannot promote to owner in MVP" });
    return;
  }

  const updated = (
    await sql`
      UPDATE memberships
      SET
        role = ${nextRole},
        status = ${nextStatus},
        is_global = (${nextRole} = 'admin')
      WHERE id = ${membershipId} AND org_id = ${orgId}
      RETURNING id, user_id as "userId", role, status, created_at as "createdAt"
    `
  )[0];

  res.status(200).json({ success: true, data: { member: updated } });
});

export default router;
