import type { Request, Response, NextFunction } from "express";
import { verifySession, type SessionClaims } from "./security.js";

export type AuthedRequest = Request & {
  auth?: SessionClaims;
};

export function readSessionCookie(req: Request): string | null {
  const raw = (req as any).cookies?.bby_session;
  return typeof raw === "string" ? raw : null;
}

export function setSessionCookie(res: Response, jwtToken: string): void {
  res.cookie("bby_session", jwtToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie("bby_session", { path: "/" });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = readSessionCookie(req);
  if (!token) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  try {
    req.auth = verifySession(token);
    next();
  } catch {
    res.status(401).json({ success: false, error: "Unauthorized" });
  }
}

