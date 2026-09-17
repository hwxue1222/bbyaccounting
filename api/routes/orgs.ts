import { Router, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated } from "../lib/migrate.js";
import { requireAuth, setSessionCookie, type AuthedRequest } from "../lib/auth.js";
import { signSession } from "../lib/security.js";
import { seedOrgDefaults } from "../lib/seed.js";
import { roleAtLeast, type Role } from "../lib/roles.js";
import { requireOrgRole } from "../lib/orgAccess.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const sql = getSql();

  const defRows = await sql`SELECT org_id as "orgId" FROM user_default_org WHERE user_id = ${req.auth!.userId} LIMIT 1`;
  const defaultOrgId = defRows.length ? String((defRows[0] as any).orgId) : null;

  const superRows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  const isSuperAdmin = superRows.length > 0;
  const globalAdminRows = isSuperAdmin
    ? ([] as any[])
    : await sql`
        SELECT id
        FROM memberships
        WHERE user_id = ${req.auth!.userId} AND status = 'active' AND role = 'admin' AND is_global = true
        LIMIT 1
      `;
  const isGlobalAdmin = isSuperAdmin || globalAdminRows.length > 0;

  const rows = isGlobalAdmin
    ? await sql`
        SELECT
          o.id as "orgId",
          o.name as "orgName",
          o.registration_no as "registrationNo",
          o.base_currency as "baseCurrency",
          'admin' as "role"
        FROM organizations o
        WHERE o.deleted_at IS NULL
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
          AND o.deleted_at IS NULL
        ORDER BY o.created_at ASC
      `;

  const isMemberOfActive = req.auth!.orgId ? rows.some((r: any) => String(r.orgId) === String(req.auth!.orgId)) : false;
  const nextActive = isMemberOfActive ? req.auth!.orgId : defaultOrgId || (rows.length ? String((rows[0] as any).orgId) : null);

  if (nextActive !== req.auth!.orgId) {
    setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: nextActive }));
  }

  res.status(200).json({ success: true, data: { orgs: rows, activeOrgId: nextActive } });
});

router.post("/create", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const bodySchema = z.object({
    name: z.string().min(2),
    registrationNo: z.string().trim().min(1).optional(),
    baseCurrency: z.string().min(3).max(3).default("SGD"),
    industry: z.enum(["restaurant", "trading", "service"]).default("restaurant"),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();

  const superRows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  if (!superRows.length) {
    res.status(403).json({ success: false, error: "Only superadmin can create organizations" });
    return;
  }
  const created = await sql.begin(async (trx) => {
    const org = (
      await trx`
        INSERT INTO organizations (name, registration_no, base_currency, industry)
        VALUES (
          ${parsed.data.name.trim()},
          ${parsed.data.registrationNo || null},
          ${parsed.data.baseCurrency.toUpperCase()},
          ${parsed.data.industry}
        )
        RETURNING id, name, registration_no as "registrationNo", base_currency as "baseCurrency", industry
      `
    )[0] as any;
    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${org.id}, ${req.auth!.userId}, 'admin', 'active')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
    `;
    await trx`
      INSERT INTO user_default_org (user_id, org_id)
      VALUES (${req.auth!.userId}, ${org.id})
      ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
    `;
    return org;
  });

  await seedOrgDefaults(sql, created.id, created.baseCurrency, created.industry);

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
  const superRows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  const isSuperAdmin = superRows.length > 0;

  const globalAdminRows = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${req.auth!.userId} AND status = 'active' AND role = 'admin' AND is_global = true
    LIMIT 1
  `;
  const isGlobalAdmin = globalAdminRows.length > 0;

  if (!isGlobalAdmin && !isSuperAdmin) {
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
            WHERE id = ${parsed.data.orgId} AND deleted_at IS NULL
            RETURNING id as "orgId", name as "orgName", registration_no as "registrationNo", base_currency as "baseCurrency"
          `
        )[0]
      : (
          await sql`
            UPDATE organizations
            SET name = ${parsed.data.name.trim()}, registration_no = ${parsed.data.registrationNo}
            WHERE id = ${parsed.data.orgId} AND deleted_at IS NULL
            RETURNING id as "orgId", name as "orgName", registration_no as "registrationNo", base_currency as "baseCurrency"
          `
        )[0];

  if (!updated) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return;
  }

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

  const superRows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  const isSuperAdmin = superRows.length > 0;

  const orgRows = await sql`SELECT id FROM organizations WHERE id = ${parsed.data.orgId} AND deleted_at IS NULL LIMIT 1`;
  if (!orgRows.length) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return;
  }

  const ok = await sql`
    SELECT id FROM memberships
    WHERE user_id = ${req.auth!.userId} AND org_id = ${parsed.data.orgId} AND status = 'active'
    LIMIT 1
  `;
  if (!ok.length) {
    if (!isSuperAdmin) {
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
  }
  await sql`
    INSERT INTO user_default_org (user_id, org_id)
    VALUES (${req.auth!.userId}, ${parsed.data.orgId})
    ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
  `;
  setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: parsed.data.orgId }));
  res.status(200).json({ success: true, data: { orgId: parsed.data.orgId } });
});

router.post("/delete", requireAuth, async (req: AuthedRequest, res: Response) => {
  await ensureMigrated();
  const bodySchema = z.object({ orgId: z.string().uuid() });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const sql = getSql();

  const guard = await requireOrgRole(req, res, parsed.data.orgId, "admin");
  if (guard === null) return;

  const r = await sql.begin(async (trx) => {
    const updated = await trx`
      UPDATE organizations
      SET deleted_at = now()
      WHERE id = ${parsed.data.orgId} AND deleted_at IS NULL
      RETURNING id
    `;
    if (!updated.length) {
      return { deleted: false, nextOrgId: null as string | null };
    }

    await trx`UPDATE memberships SET status = 'inactive' WHERE org_id = ${parsed.data.orgId}`;
    await trx`DELETE FROM user_default_org WHERE org_id = ${parsed.data.orgId}`;

    let nextOrgId: string | null = null;
    if (req.auth!.orgId === parsed.data.orgId) {
      const fallback = await trx`
        SELECT m.org_id as "orgId"
        FROM memberships m
        JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ${req.auth!.userId}
          AND m.status = 'active'
          AND m.org_id <> ${parsed.data.orgId}
          AND o.deleted_at IS NULL
        ORDER BY o.created_at ASC
        LIMIT 1
      `;
      nextOrgId = fallback.length ? String((fallback[0] as any).orgId) : null;
      if (nextOrgId) {
        await trx`
          INSERT INTO user_default_org (user_id, org_id)
          VALUES (${req.auth!.userId}, ${nextOrgId})
          ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
        `;
      }
    }

    return { deleted: true, nextOrgId };
  });

  if (!r.deleted) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return;
  }

  if (req.auth!.orgId === parsed.data.orgId) {
    setSessionCookie(res, signSession({ userId: req.auth!.userId, orgId: r.nextOrgId }));
  }

  res.status(200).json({ success: true, data: { orgId: parsed.data.orgId, nextOrgId: r.nextOrgId } });
});

export default router;
