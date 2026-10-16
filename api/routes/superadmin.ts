import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, type AuthedRequest } from "../lib/auth.js";
import { seedOrgDefaults } from "../lib/seed.js";
import { signSession } from "../lib/security.js";
import { setSessionCookie } from "../lib/auth.js";

const router = Router();

async function requireSuperAdmin(req: AuthedRequest, res: Response): Promise<void | null> {
  const sql = getSql();
  const rows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  if (!rows.length) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
}

router.get("/pending-signups", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const sql = getSql();
  const rows = await sql`
    SELECT
      r.id,
      r.email,
      r.org_name as "orgName",
      r.base_currency as "baseCurrency",
      r.industry,
      r.status,
      r.user_id as "userId",
      r.created_at as "createdAt"
    FROM signup_requests r
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
  `;
  res.status(200).json({ success: true, data: { requests: rows } });
});

router.get("/orgs", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const sql = getSql();
  const rows = await sql`
    SELECT
      o.id as "orgId",
      o.name as "orgName",
      o.base_currency as "baseCurrency",
      o.created_at as "createdAt",
      COALESCE(array_agg(u.email) FILTER (WHERE u.email IS NOT NULL), '{}') as "adminEmails"
    FROM organizations o
    LEFT JOIN memberships m ON m.org_id = o.id AND m.status = 'active' AND m.role = 'admin'
    LEFT JOIN users u ON u.id = m.user_id
    WHERE o.deleted_at IS NULL
    GROUP BY o.id
    ORDER BY o.created_at ASC
  `;
  res.status(200).json({ success: true, data: { orgs: rows } });
});

router.post("/set-org-admin", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const bodySchema = z.object({ orgId: z.string().uuid(), email: z.string().email() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const email = String(parsed.data.email).trim().toLowerCase();
  const userRows = await sql`SELECT id, status FROM users WHERE email = ${email} LIMIT 1`;
  const u = userRows[0] as any;
  if (!u) {
    res.status(404).json({ success: false, error: "User not found" });
    return;
  }
  if (String(u.status) !== "active") {
    res.status(400).json({ success: false, error: "User is not active" });
    return;
  }

  await sql`
    INSERT INTO memberships (org_id, user_id, role, status, is_global)
    VALUES (${parsed.data.orgId}, ${u.id}, 'admin', 'active', false)
    ON CONFLICT (org_id, user_id)
    DO UPDATE SET role = 'admin', status = 'active', is_global = false
  `;
  res.status(200).json({ success: true, data: { ok: true } });
});

router.post("/approve-signup", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const bodySchema = z.object({ requestId: z.string().uuid() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const created = await sql.begin(async (trx) => {
    const rows = await trx`
      SELECT id, email, org_name as "orgName", base_currency as "baseCurrency", industry, user_id as "userId", status
      FROM signup_requests
      WHERE id = ${parsed.data.requestId}
      LIMIT 1
    `;
    const r = rows[0] as any;
    if (!r) throw new Error("Not found");
    if (String(r.status) !== "pending") throw new Error("Already processed");
    if (!r.userId) throw new Error("Missing user");

    const org = (
      await trx`
        INSERT INTO organizations (name, base_currency, industry)
        VALUES (${String(r.orgName).trim()}, ${String(r.baseCurrency).toUpperCase()}, ${String(r.industry)})
        RETURNING id, name, base_currency as "baseCurrency", industry
      `
    )[0] as any;

    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${org.id}, ${r.userId}, 'admin', 'active')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', is_global = (EXCLUDED.role = 'admin')
    `;

    await trx`
      INSERT INTO user_default_org (user_id, org_id)
      VALUES (${r.userId}, ${org.id})
      ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
    `;

    await trx`UPDATE users SET status = 'active' WHERE id = ${r.userId}`;

    await trx`
      UPDATE signup_requests
      SET status = 'approved', reviewed_by = ${req.auth!.userId}, reviewed_at = now()
      WHERE id = ${parsed.data.requestId}
    `;

    return { org, userId: String(r.userId) };
  });

  await seedOrgDefaults(sql, created.org.id, created.org.baseCurrency, created.org.industry);

  const sessionRows = await sql`SELECT id FROM users WHERE id = ${created.userId} LIMIT 1`;
  if (sessionRows.length) {
    void 0;
  }

  res.status(200).json({ success: true, data: { org: created.org } });
});

router.post("/reject-signup", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const bodySchema = z.object({ requestId: z.string().uuid() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const updated = (
    await sql`
      UPDATE signup_requests
      SET status = 'rejected', reviewed_by = ${req.auth!.userId}, reviewed_at = now()
      WHERE id = ${parsed.data.requestId} AND status = 'pending'
      RETURNING user_id as "userId"
    `
  )[0] as any;

  if (updated?.userId) {
    await sql`UPDATE users SET status = 'disabled' WHERE id = ${updated.userId} AND status = 'pending'`;
  }

  res.status(200).json({ success: true, data: { ok: true } });
});

router.post("/impersonate", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const guard = await requireSuperAdmin(req, res);
  if (guard === null) return;

  const bodySchema = z.object({ userId: z.string().uuid(), orgId: z.string().uuid().nullable().optional() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  setSessionCookie(res, signSession({ userId: parsed.data.userId, orgId: parsed.data.orgId ?? null }));
  res.status(200).json({ success: true, data: { ok: true } });
});

export default router;
