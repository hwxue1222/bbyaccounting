import postgres, { type Sql } from "postgres";

let cached: Sql | null = null;

export function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Missing DATABASE_URL");
  }
  if (!cached) {
    cached = postgres(url, {
      max: 5,
      connect_timeout: 10,
      idle_timeout: 20,
    });
  }
  return cached;
}

