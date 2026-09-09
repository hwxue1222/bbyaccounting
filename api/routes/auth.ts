/**
 * This is a user authentication API route demo.
 * Handle user registration, login, token management, etc.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getSql } from "../lib/db.js";
import { ensureMigrated, sha256 } from "../lib/migrate.js";
import { clearSessionCookie, requireAuth, setSessionCookie, type AuthedRequest } from "../lib/auth.js";
import { hashPassword, signSession, verifyPassword } from "../lib/security.js";
import { randomToken } from "../lib/security.js";

const router = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function seedOrgDefaults(sql: ReturnType<typeof getSql>, orgId: string, baseCurrency: string) {
  const accounts = [
    { code: "1000", name: "Cash", type: "asset", normal_balance: "debit" },
    { code: "1200", name: "Accounts Receivable", type: "asset", normal_balance: "debit" },
    { code: "2000", name: "Accounts Payable", type: "liability", normal_balance: "credit" },
    { code: "3000", name: "Retained Earnings", type: "equity", normal_balance: "credit" },
    { code: "4000", name: "Sales", type: "income", normal_balance: "credit" },
    { code: "5000", name: "Cost of Goods Sold", type: "cogs", normal_balance: "debit" },
    { code: "6000", name: "Operating Expenses", type: "expense", normal_balance: "debit" },
    { code: "6100", name: "Depreciation Expense", type: "expense", normal_balance: "debit" },
    { code: "1500", name: "Inventory", type: "asset", normal_balance: "debit" },
    { code: "1600", name: "Fixed Assets", type: "asset", normal_balance: "debit" },
    { code: "1610", name: "Accumulated Depreciation", type: "asset", normal_balance: "credit" },
    { code: "7000", name: "Gain/Loss on Disposal", type: "expense", normal_balance: "debit" },
  ];
  await sql.begin(async (trx) => {
    for (const a of accounts) {
      await trx`
        INSERT INTO accounts (org_id, code, name, type, normal_balance)
        VALUES (${orgId}, ${a.code}, ${a.name}, ${a.type}, ${a.normal_balance})
        ON CONFLICT (org_id, code) DO NOTHING
      `;
    }
    await trx`
      INSERT INTO currencies (org_id, code, is_enabled)
      VALUES (${orgId}, ${baseCurrency.toUpperCase()}, true)
      ON CONFLICT (org_id, code) DO NOTHING
    `;
  });
}

router.post("/register", async (req: Request, res: Response): Promise<void> => {
  await ensureMigrated();
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    orgName: z.string().min(2),
    baseCurrency: z.string().min(3).max(3).default("SGD"),
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid input" });
    return;
  }

  const { email, password, orgName, baseCurrency } = parsed.data;
  const sql = getSql();
  const emailNorm = normalizeEmail(email);

  const existing = await sql`SELECT id FROM users WHERE email = ${emailNorm}`;
  if (existing.length) {
    res.status(409).json({ success: false, error: "Email already registered" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const created = await sql.begin(async (trx) => {
    const userRows = await trx`
      INSERT INTO users (email, password_hash)
      VALUES (${emailNorm}, ${passwordHash})
      RETURNING id, email
    `;
    const user = userRows[0];
    const orgRows = await trx`
      INSERT INTO organizations (name, base_currency)
      VALUES (${orgName.trim()}, ${baseCurrency.toUpperCase()})
      RETURNING id, name, base_currency
    `;
    const org = orgRows[0];
    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${org.id}, ${user.id}, 'owner', 'active')
    `;
    return { user, org };
  });

  await seedOrgDefaults(sql, created.org.id, created.org.base_currency);

  setSessionCookie(res, signSession({ userId: created.user.id, orgId: created.org.id }));
  res.status(200).json({
    success: true,
    data: {
      user: { id: created.user.id, email: created.user.email },
      org: { id: created.org.id, name: created.org.name, baseCurrency: created.org.base_currency },
    },
  });
});

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  await ensureMigrated();
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

  const rows = await sql`SELECT id, email, password_hash FROM users WHERE email = ${emailNorm}`;
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

  const memberships = await sql`
    SELECT m.org_id as "orgId"
    FROM memberships m
    WHERE m.user_id = ${user.id} AND m.status = 'active'
    ORDER BY m.created_at ASC
  `;
  const orgId = memberships.length ? (memberships[0] as any).orgId : null;

  setSessionCookie(res, signSession({ userId: user.id, orgId }));
  res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email }, orgId } });
});

router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  clearSessionCookie(res);
  res.status(200).json({ success: true });
});

router.get("/me", requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await ensureMigrated();
  const sql = getSql();
  const userRows = await sql`SELECT id, email FROM users WHERE id = ${req.auth!.userId}`;
  const user = userRows[0];
  if (!user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email }, orgId: req.auth!.orgId } });
});

router.post(
  "/change-password",
  requireAuth,
  async (req: AuthedRequest, res: Response): Promise<void> => {
    await ensureMigrated();
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
  await ensureMigrated();
  const bodySchema = z.object({
    token: z.string().min(20),
    password: z.string().min(8),
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
      accepted_at as "acceptedAt"
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
  if (new Date(inv.expiresAt).getTime() < Date.now()) {
    res.status(410).json({ success: false, error: "Invite expired" });
    return;
  }

  const emailNorm = normalizeEmail(inv.email);
  const userRows = await sql`SELECT id, email FROM users WHERE email = ${emailNorm}`;
  const userExisting = userRows[0];
  const user = userExisting
    ? userExisting
    : (
        await sql`
          INSERT INTO users (email, password_hash)
          VALUES (${emailNorm}, ${await hashPassword(parsed.data.password)})
          RETURNING id, email
        `
      )[0];

  await sql.begin(async (trx) => {
    await trx`
      INSERT INTO memberships (org_id, user_id, role, status)
      VALUES (${inv.orgId}, ${user.id}, ${inv.role}, 'active')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
    `;
    await trx`UPDATE invitations SET accepted_at = now() WHERE id = ${inv.id}`;
  });

  setSessionCookie(res, signSession({ userId: user.id, orgId: inv.orgId }));
  res.status(200).json({ success: true, data: { user: { id: user.id, email: user.email }, orgId: inv.orgId } });
});

router.post("/create-invite", requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await ensureMigrated();
  const bodySchema = z.object({
    email: z.string().email(),
    role: z.enum(["owner", "admin", "accountant", "viewer", "auditor"]),
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
  const token = randomToken();
  const tokenHash = sha256(token);
  const emailNorm = normalizeEmail(parsed.data.email);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

  await sql`
    INSERT INTO invitations (org_id, email, role, token_hash, expires_at, created_by)
    VALUES (${orgId}, ${emailNorm}, ${parsed.data.role}, ${tokenHash}, ${expiresAt.toISOString()}, ${req.auth!.userId})
  `;
  const appOrigin = process.env.APP_ORIGIN || "http://localhost:5173";
  res.status(200).json({ success: true, data: { token, inviteUrl: `${appOrigin}/auth/invite?token=${token}` } });
});

export default router;
