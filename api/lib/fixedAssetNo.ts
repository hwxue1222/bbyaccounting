function categoryPrefix(category: string): string {
  const c = String(category || "").trim();
  if (c === "Machinery and Equipment") return "MEQ";
  if (c === "Vehicles") return "VEH";
  if (c === "Computer") return "COM";
  if (c === "Furniture and Fixtures") return "FUR";
  if (c === "Renovation") return "REN";
  if (c === "Intangible Fixed Assets") return "INT";
  return "UNC";
}

export function normalizeFixedAssetCategory(category: unknown): string {
  const c = typeof category === "string" ? category.trim() : "";
  if (
    c === "Machinery and Equipment" ||
    c === "Vehicles" ||
    c === "Computer" ||
    c === "Furniture and Fixtures" ||
    c === "Renovation" ||
    c === "Intangible Fixed Assets"
  ) {
    return c;
  }
  return "Machinery and Equipment";
}

export async function issueFixedAssetNo(
  trx: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>,
  orgId: string,
  category: string,
): Promise<string> {
  const normalized = normalizeFixedAssetCategory(category);
  const prefix = categoryPrefix(normalized);
  const key = `FA:${prefix}`;
  const fullPrefix = `FA-${prefix}`;
  const row = (
    await trx`
      INSERT INTO org_counters (org_id, key, next_int)
      SELECT
        ${orgId} as org_id,
        ${key} as key,
        (
          COALESCE(
            (
              SELECT
                COALESCE(
                  MAX(
                    CASE
                      WHEN asset_no ~ ('^' || ${fullPrefix} || '[0-9]+$') THEN substring(asset_no from (length(${fullPrefix}) + 1))::bigint
                      ELSE 0
                    END
                  ),
                  0
                ) + 1
              FROM fixed_assets
              WHERE org_id = ${orgId}
            ),
            1
          ) + 1
        ) as next_int
      ON CONFLICT (org_id, key)
      DO UPDATE SET next_int = org_counters.next_int + 1
      RETURNING next_int
    `
  )[0] as any;

  const nextInt = BigInt(row.next_int);
  const issued = nextInt - 1n;
  return `${fullPrefix}${issued.toString().padStart(5, "0")}`;
}

