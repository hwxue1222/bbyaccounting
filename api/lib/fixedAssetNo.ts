export const FIXED_ASSET_CATEGORIES = [
  "Machinery and Equipment",
  "Vehicles",
  "Computer",
  "Furniture and Fixtures",
  "Renovation",
  "Intangible Fixed Assets",
] as const;

export type FixedAssetCategory = (typeof FIXED_ASSET_CATEGORIES)[number];

function categoryPrefix(category: FixedAssetCategory): string {
  if (category === "Machinery and Equipment") return "ME";
  if (category === "Vehicles") return "VEH";
  if (category === "Computer") return "COM";
  if (category === "Furniture and Fixtures") return "FUR";
  if (category === "Renovation") return "REN";
  return "INT";
}

export function fixedAssetNoPrefixByCategory(category: FixedAssetCategory): string {
  return `FA-${categoryPrefix(category)}`;
}

export function normalizeFixedAssetCategory(category: unknown): FixedAssetCategory {
  const c = typeof category === "string" ? category.trim() : "";
  if ((FIXED_ASSET_CATEGORIES as readonly string[]).includes(c)) {
    return c as FixedAssetCategory;
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
              WHERE org_id = ${orgId} AND category = ${normalized}
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

export async function peekNextFixedAssetNo(
  trx: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>,
  orgId: string,
  category: string,
): Promise<string> {
  const normalized = normalizeFixedAssetCategory(category);
  const fullPrefix = fixedAssetNoPrefixByCategory(normalized);
  const rows = await trx`
    SELECT
      COALESCE(
        MAX(
          CASE
            WHEN asset_no ~ ('^' || ${fullPrefix} || '[0-9]+$') THEN substring(asset_no from (length(${fullPrefix}) + 1))::bigint
            ELSE 0
          END
        ),
        0
      ) as max_no
    FROM fixed_assets
    WHERE org_id = ${orgId} AND category = ${normalized}
  `;
  const maxNo = BigInt((rows[0] as any)?.max_no || 0);
  const next = maxNo + 1n;
  return `${fullPrefix}${next.toString().padStart(5, "0")}`;
}
