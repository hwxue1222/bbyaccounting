export function normalizeOrgName(input: string): string {
  return String(input || "").trim().replace(/\s+/g, " ").toLowerCase();
}

