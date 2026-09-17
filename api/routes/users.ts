import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { requireOrgAccess, requireOrgRole } from "../lib/orgAccess.js";

const router = Router();

const ALLOWED_ROLE_PERMS = new Set([
  "settings.view",
  "settings.edit",
  "journal.view",
  "journal.edit",
  "inventory.view",
  "inventory.edit",
  "fixedAssets.view",
  "fixedAssets.edit",
  "vendors.view",
  "vendors.edit",
  "customers.view",
  "customers.edit",
  "reports.view",
  "users.manage",
]);

async function getMyMembershipRole(sql: ReturnType<typeof getSql>, orgId: string, userId: string): Promise<string | null> {
  const rows = await sql`
    SELECT role
    FROM memberships
    WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'active'
    LIMIT 1
  `;
  return rows.length ? String((rows[0] as any).role) : null;
}

async function isGlobalAdmin(sql: ReturnType<typeof getSql>, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${userId} AND status = 'active' AND role = 'admin' AND is_global = true
    LIMIT 1
  `;
  return rows.length > 0;
}

router.get("/members", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const guard = await requireOrgRole(req, res, orgId, "admin");
  if (guard === null) return;

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

router.get("/role-permissions", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const guard = await requireOrgRole(req, res, orgId, "admin");
  if (guard === null) return;

  const sql = getSql();
  const rows = await sql`
    SELECT role, permissions
    FROM role_permissions
    WHERE org_id = ${orgId}
    ORDER BY role ASC
  `;
  res.status(200).json({ success: true, data: { roles: rows } });
});

router.patch("/role-permissions", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const guard = await requireOrgRole(req, res, orgId, "admin");
  if (guard === null) return;

  const bodySchema = z.object({
    role: z.enum(["owner", "admin", "accountant", "viewer", "auditor"]),
    permissions: z
      .array(z.string())
      .refine((arr) => arr.every((p) => ALLOWED_ROLE_PERMS.has(p)), { message: "Invalid permissions" }),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const globalAdmin = await isGlobalAdmin(sql, req.auth!.userId);
  const myRole = globalAdmin ? "admin" : await getMyMembershipRole(sql, orgId, req.auth!.userId);
  if (!myRole) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  if (myRole !== "owner") {
    res.status(403).json({ success: false, error: "Only owner can change role permissions" });
    return;
  }

  const updated = (
    await sql`
      INSERT INTO role_permissions (org_id, role, permissions, updated_at)
      VALUES (${orgId}, ${parsed.data.role}, ${sql.array(parsed.data.permissions)}, now())
      ON CONFLICT (org_id, role)
      DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()
      RETURNING role, permissions
    `
  )[0];

  res.status(200).json({ success: true, data: { role: updated } });
});

router.patch("/members/:membershipId", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const orgId = await requireOrgAccess(req, res);
  if (!orgId) return;

  const guard = await requireOrgRole(req, res, orgId, "admin");
  if (guard === null) return;

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

  const sql = getSql();
  const globalAdmin = await isGlobalAdmin(sql, req.auth!.userId);
  const myRole = globalAdmin ? "admin" : await getMyMembershipRole(sql, orgId, req.auth!.userId);
  if (!myRole) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }

  if (myRole !== "owner" && parsed.data.role) {
    res.status(403).json({ success: false, error: "Only owner can change roles" });
    return;
  }

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
