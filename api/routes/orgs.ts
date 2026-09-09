import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, setSessionCookie, type AuthedRequest } from "../lib/auth.js";
import { signSession } from "../lib/security.js";
import { seedOrgDefaults } from "../lib/seed.js";
import { roleAtLeast, type Role } from "../lib/roles.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const sql = getSql();

  const defRows = await sql`SELECT org_id as "orgId" FROM user_default_org WHERE user_id = ${req.auth!.userId} LIMIT 1`;
  const defaultOrgId = defRows.length ? String((defRows[0] as any).orgId) : null;

  const globalAdminRows = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${req.auth!.userId} AND status = 'active' AND role = 'admin' AND is_global = true
    LIMIT 1
  `;
  const isGlobalAdmin = globalAdminRows.length > 0;

  const rows = isGlobalAdmin
    ? await sql`
        SELECT
          o.id as "orgId",
          o.name as "orgName",
          o.registration_no as "registrationNo",
          o.base_currency as "baseCurrency",
          'admin' as "role"
        FROM organizations o
        ORDER BY o.created_at ASC
      `
    : await sql`
        SELECT
          o.id as "orgId",
          o.name as "orgName",
          o.registration_no as "registrationNo",
          o.base_currency as "baseCurrency",
          m.role as "role"
        FROM memberships m
        JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ${req.auth!.userId} AND m.status = 'active'
        ORDER BY o.created_at ASC
      `;

  const isMemberOfActive = req.auth!.orgId ? rows.some((r: any) => String(r.orgId) === String(req.auth!.orgId)) : false;
  const nextActive = isMemberOfActive ? req.auth!.orgId : defaultOrgId || (rows.length ? String((rows[0] as any).orgId) : null);

  res.status(200).json({ success: true, data: { orgs: rows, activeOrgId: nextActive } });
});

router.post("/create", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const bodySchema = z.object({
    name: z.string().min(2),
    registrationNo: z.string().trim().min(1).optional(),
    baseCurrency: z.string().min(3).max(3).default("SGD"),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();
  const created = await sql.begin(async (trx) => {
    const org = (
      await trx`
        INSERT INTO organizations (name, registration_no, base_currency)
        VALUES (${parsed.data.name.trim()}, ${parsed.data.registrationNo || null}, ${parsed.data.baseCurrency.toUpperCase()})
        RETURNING id, name, registration_no as "registrationNo", base_currency as "baseCurrency"
      `
    )[0] as any;
    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${org.id}, ${req.auth!.userId}, 'owner', 'active')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
    `;
    await trx`
      INSERT INTO user_default_org (user_id, org_id)
      VALUES (${req.auth!.userId}, ${org.id})
      ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
    `;
    return org;
  });

  await seedOrgDefaults(sql, created.id, created.baseCurrency);

  setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: created.id }));
  res.status(200).json({ success: true, data: { org: created } });
});

router.post("/update", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const bodySchema = z.object({
    orgId: z.string().uuid(),
    name: z.string().trim().min(2),
    registrationNo: z.string().trim().min(1).nullable().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();

  const globalAdminRows = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${req.auth!.userId} AND status = 'active' AND role = 'admin' AND is_global = true
    LIMIT 1
  `;
  const isGlobalAdmin = globalAdminRows.length > 0;

  if (!isGlobalAdmin) {
    const m = await sql`
      SELECT role
      FROM memberships
      WHERE user_id = ${req.auth!.userId} AND org_id = ${parsed.data.orgId} AND status = 'active'
      LIMIT 1
    `;
    const role = (m[0] as any)?.role as Role | undefined;
    if (!role || !roleAtLeast(role, "admin")) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }
  }

  const updated =
    parsed.data.registrationNo === undefined
      ? (
          await sql`
            UPDATE organizations
            SET name = ${parsed.data.name.trim()}
            WHERE id = ${parsed.data.orgId}
            RETURNING id as "orgId", name as "orgName", registration_no as "registrationNo", base_currency as "baseCurrency"
          `
        )[0]
      : (
          await sql`
            UPDATE organizations
            SET name = ${parsed.data.name.trim()}, registration_no = ${parsed.data.registrationNo}
            WHERE id = ${parsed.data.orgId}
            RETURNING id as "orgId", name as "orgName", registration_no as "registrationNo", base_currency as "baseCurrency"
          `
        )[0];

  res.status(200).json({ success: true, data: { org: updated } });
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
    const globalAdminRows = await sql`
      SELECT id
      FROM memberships
      WHERE user_id = ${req.auth!.userId} AND status = 'active' AND role = 'admin' AND is_global = true
      LIMIT 1
    `;
    if (!globalAdminRows.length) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }
  }
  await sql`
    INSERT INTO user_default_org (user_id, org_id)
    VALUES (${req.auth!.userId}, ${parsed.data.orgId})
    ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
  `;
  setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: parsed.data.orgId }));
  res.status(200).json({ success: true, data: { orgId: parsed.data.orgId } });
});

export default router;
