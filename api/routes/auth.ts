/**
 * This is a user authentication API route demo.
 * Handle user registration, login, token management, etc.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { sha256 } from "../lib/migrate.js";
import { clearSessionCookie, readSessionCookie, requireAuth, setSessionCookie, type AuthedRequest } from "../lib/auth.js";
import { hashPassword, signSession, verifyPassword, verifySession } from "../lib/security.js";
import { randomToken } from "../lib/security.js";
import { requireOrgPermission } from "../lib/orgAccess.js";
import { seedOrgDefaults } from "../lib/seed.js";

const router = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.post("/register", async (req: Request, res: Response): Promise<void> => {
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    orgName: z.string().min(2),
    baseCurrency: z.string().min(3).max(3).default("SGD"),
    industry: z.enum(["restaurant", "trading", "service"]).default("restaurant"),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const { email, password, orgName, baseCurrency, industry } = parsed.data;
  const sql = getSql();
  const emailNorm = normalizeEmail(email);

  const existing = await sql`SELECT id FROM users WHERE email = ${emailNorm}`;
  if (existing.length) {
    res.status(409).json({ success: false, error: "Email already registered" });
    return;
  }

  const created = await sql.begin(async (trx) => {
    const user = (
      await trx`
        INSERT INTO users (email, password_hash, status)
        VALUES (${emailNorm}, ${await hashPassword(password)}, 'active')
        RETURNING id, email, status
      `
    )[0] as any;

    const org = (
      await trx`
        INSERT INTO organizations (name, base_currency, industry, plan, plan_status, plan_started_at)
        VALUES (${orgName.trim()}, ${baseCurrency.toUpperCase()}, ${industry}, 'basic', 'active', now())
        RETURNING id, name, base_currency as "baseCurrency", industry
      `
    )[0] as any;

    await trx`
      INSERT INTO memberships (org_id, user_id, role, status, is_global)
      VALUES (${org.id}, ${user.id}, 'admin', 'active', false)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin', status = 'active', is_global = false
    `;

    await trx`
      INSERT INTO user_default_org (user_id, org_id)
      VALUES (${user.id}, ${org.id})
      ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()
    `;

    return { user, org };
  });

  await seedOrgDefaults(sql, created.org.id, created.org.baseCurrency, created.org.industry);

  setSessionCookie(res, signSession({ userId: created.user.id, orgId: created.org.id }));
  res.status(200).json({
    success: true,
    data: {
      user: { id: created.user.id, email: created.user.email, status: "active" },
      orgId: created.org.id,
    },
  });
});

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const emailNorm = normalizeEmail(parsed.data.email);

  const rows = await sql`SELECT id, email, password_hash, status, is_superadmin FROM users WHERE email = ${emailNorm}`;
  const user = rows[0];
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }
  const ok = await verifyPassword(parsed.data.password, user.password_hash);
  if (!ok) {
    res.status(401).json({ success: false, error: "Invalid credentials" });
    return;
  }

  const status = String((user as any).status || "active");
  if (status !== "active") {
    setSessionCookie(res, signSession({ userId: user.id, orgId: null }));
    res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email, status }, orgId: null } });
    return;
  }

  const memberships = await sql`
    SELECT m.org_id as "orgId"
    FROM memberships m
    WHERE m.user_id = ${user.id} AND m.status = 'active'
    ORDER BY m.created_at ASC
  `;
  const orgId = memberships.length ? (memberships[0] as any).orgId : null;

  setSessionCookie(res, signSession({ userId: user.id, orgId }));
  res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email, status }, orgId } });
});

router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  clearSessionCookie(res);
  res.status(200).json({ success: true });
});

router.get("/me", requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const sql = getSql();
  const userRows = await sql`SELECT id, email, status, is_superadmin FROM users WHERE id = ${req.auth!.userId}`;
  const user = userRows[0];
  if (!user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  res.status(200).json({
    success: true,
    data: {
      user: { id: user.id, email: user.email, status: String((user as any).status || "active"), isSuperAdmin: Boolean((user as any).is_superadmin) },
      orgId: req.auth!.orgId,
    },
  });
});

router.post(
  "/change-password",
  requireAuth,
  async (req: AuthedRequest, res: Response): Promise<void> => {
    const bodySchema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid input" });
      return;
    }
    const sql = getSql();
    const rows = await sql`SELECT id, password_hash FROM users WHERE id = ${req.auth!.userId}`;
    const user = rows[0];
    if (!user) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
    const ok = await verifyPassword(parsed.data.currentPassword, user.password_hash);
    if (!ok) {
      res.status(400).json({ success: false, error: "Current password is incorrect" });
      return;
    }
    const nextHash = await hashPassword(parsed.data.newPassword);
    await sql`UPDATE users SET password_hash = ${nextHash} WHERE id = ${req.auth!.userId}`;
    res.status(200).json({ success: true });
  },
);

router.post("/accept-invite", async (req: Request, res: Response): Promise<void> => {
  const bodySchema = z.object({
    token: z.string().min(20),
    password: z.string().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const sql = getSql();
  const tokenHash = sha256(parsed.data.token);
  const invRows = await sql`
    SELECT
      id,
      org_id as "orgId",
      email,
      role,
      expires_at as "expiresAt",
      accepted_at as "acceptedAt",
      revoked_at as "revokedAt"
    FROM invitations
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `;
  const inv = invRows[0] as any;
  if (!inv) {
    res.status(404).json({ success: false, error: "Invalid invite" });
    return;
  }
  if (inv.acceptedAt) {
    res.status(409).json({ success: false, error: "Invite already accepted" });
    return;
  }
  if (inv.revokedAt) {
    res.status(410).json({ success: false, error: "Invite revoked" });
    return;
  }
  if (new Date(inv.expiresAt).getTime() < Date.now()) {
    res.status(410).json({ success: false, error: "Invite expired" });
    return;
  }

  const orgRows = await sql`SELECT id FROM organizations WHERE id = ${inv.orgId} AND deleted_at IS NULL LIMIT 1`;
  if (!orgRows.length) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return;
  }

  const emailNorm = normalizeEmail(inv.email);
  const userRows = await sql`SELECT id, email, status FROM users WHERE email = ${emailNorm}`;
  const userExisting = userRows[0] as any;
  const isExisting = Boolean(userExisting);
  if (isExisting) {
    if (String(userExisting.status || "active") !== "active") {
      res.status(400).json({ success: false, error: "User is not active" });
      return;
    }
    const rawToken = readSessionCookie(req);
    if (!rawToken) {
      res.status(401).json({ success: false, error: "Please sign in to accept this invite" });
      return;
    }
    try {
      const claims = verifySession(rawToken);
      if (String(claims.userId) !== String(userExisting.id)) {
        res.status(403).json({ success: false, error: "Please sign in with the invited email" });
        return;
      }
    } catch {
      res.status(401).json({ success: false, error: "Please sign in to accept this invite" });
      return;
    }
  }

  const pass = String(parsed.data.password || "");
  if (!isExisting && pass.trim().length < 8) {
    res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
    return;
  }

  const user = isExisting
    ? userExisting
    : (
        await sql`
          INSERT INTO users (email, password_hash)
          VALUES (${emailNorm}, ${await hashPassword(pass)})
          RETURNING id, email
        `
      )[0];

  const invRoleRaw = String(inv.role || "");
  const invRole = invRoleRaw === "admin" || invRoleRaw === "accountant" || invRoleRaw === "viewer" || invRoleRaw === "auditor" ? invRoleRaw : "admin";

  await sql.begin(async (trx) => {
    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${inv.orgId}, ${user.id}, ${invRole}, 'active')
      ON CONFLICT (org_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, status = 'active', is_global = false
    `;
    await trx`
      INSERT INTO user_default_org (user_id, org_id)
      VALUES (${user.id}, ${inv.orgId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    await trx`UPDATE invitations SET accepted_at = now() WHERE id = ${inv.id}`;
  });

  setSessionCookie(res, signSession({ userId: user.id, orgId: inv.orgId }));
  res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email }, orgId: inv.orgId } });
});

router.post("/create-invite", requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  const bodySchema = z.object({
    email: z.string().email(),
    role: z.enum(["admin", "accountant", "viewer", "auditor"]),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return;
  }
  const sql = getSql();

  const superRows = await sql`SELECT id FROM users WHERE id = ${req.auth!.userId} AND is_superadmin = true LIMIT 1`;
  const isSuperAdmin = superRows.length > 0;
  if (!isSuperAdmin) {
    const g = await requireOrgPermission(req, res, orgId, "users.manage");
    if (g === null) return;
  }
  if (parsed.data.role === "admin" && !isSuperAdmin) {
    res.status(403).json({ success: false, error: "Only superadmin can invite admins" });
    return;
  }

  const orgRows = await sql`SELECT id FROM organizations WHERE id = ${orgId} AND deleted_at IS NULL LIMIT 1`;
  if (!orgRows.length) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return;
  }
  const token = randomToken();
  const tokenHash = sha256(token);
  const emailNorm = normalizeEmail(parsed.data.email);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

  await sql`
    INSERT INTO invitations (org_id, email, role, token_hash, expires_at, revoked_at, created_by)
    VALUES (${orgId}, ${emailNorm}, ${parsed.data.role}, ${tokenHash}, ${expiresAt.toISOString()}, null, ${req.auth!.userId})
  `;
  const appOrigin = process.env.APP_ORIGIN || "http://localhost:5173";
  res.status(200).json({ success: true, data: { token, inviteUrl: `${appOrigin}/auth/invite?token=${token}` } });
});

export default router;
