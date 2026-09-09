import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";

export type SessionClaims = {
  userId: string;
  orgId: string | null;
};

export function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev_jwt_secret_change_me";
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, getJwtSecret(), { expiresIn: "30d" });
}

export function verifySession(token: string): SessionClaims {
  const decoded = jwt.verify(token, getJwtSecret());
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Invalid session");
  }
  const userId = typeof (decoded as any).userId === "string" ? (decoded as any).userId : null;
  const orgId = typeof (decoded as any).orgId === "string" ? (decoded as any).orgId : null;
  if (!userId) {
    throw new Error("Invalid session");
  }
  return { userId, orgId };
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

