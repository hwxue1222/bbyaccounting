import type { Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { getSql } from "./db.js";
import { roleAtLeast, type Role } from "./roles.js";

async function isGlobalAdmin(userId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${userId} AND status = 'active' AND role = 'admin' AND is_global = true
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function requireOrgAccess(req: AuthedRequest, res: Response): Promise<string | null> {
  const orgId = req.auth!.orgId;
  if (!orgId) {
    res.status(400).json({ success: false, error: "No active organization" });
    return null;
  }

  const sql = getSql();
  const orgRows = await sql`
    SELECT id
    FROM organizations
    WHERE id = ${orgId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!orgRows.length) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return null;
  }

  if (await isGlobalAdmin(req.auth!.userId)) {
    return orgId;
  }

  const ok = await sql`
    SELECT id
    FROM memberships
    WHERE user_id = ${req.auth!.userId} AND org_id = ${orgId} AND status = 'active'
    LIMIT 1
  `;
  if (!ok.length) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }

  return orgId;
}

export async function requireOrgRole(req: AuthedRequest, res: Response, orgId: string, minRole: Role): Promise<void | null> {
  const sql = getSql();
  const orgRows = await sql`
    SELECT id
    FROM organizations
    WHERE id = ${orgId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!orgRows.length) {
    res.status(404).json({ success: false, error: "Organization not found" });
    return null;
  }

  if (await isGlobalAdmin(req.auth!.userId)) {
    return;
  }

  const m = await sql`
    SELECT role
    FROM memberships
    WHERE user_id = ${req.auth!.userId} AND org_id = ${orgId} AND status = 'active'
    LIMIT 1
  `;
  const role = (m[0] as any)?.role as Role | undefined;
  if (!role || !roleAtLeast(role, minRole)) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return null;
  }
}

