import postgres, { type Sql } from "postgres";

let cached: Sql | null = null;

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}

export function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Missing DATABASE_URL");
  }
  if (!cached) {
    const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
    const max = parsePositiveInt(process.env.DB_POOL_MAX) ?? (isServerless ? 1 : 5);
    const connectTimeout = parsePositiveInt(process.env.DB_CONNECT_TIMEOUT) ?? (isServerless ? 5 : 10);
    const idleTimeout = parsePositiveInt(process.env.DB_IDLE_TIMEOUT) ?? 20;
    cached = postgres(url, {
      max,
      connect_timeout: connectTimeout,
      idle_timeout: idleTimeout,
    });
  }
  return cached;
}
