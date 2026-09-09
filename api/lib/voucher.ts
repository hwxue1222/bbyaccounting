export async function issueVoucherNo(
  trx: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>,
  orgId: string,
): Promise<string> {
  const row = (
    await trx`
      INSERT INTO org_counters (org_id, key, next_int)
      SELECT
        ${orgId} as org_id,
        'JV' as key,
        (
          COALESCE(
            (
              SELECT
                COALESCE(MAX(CASE WHEN voucher_no ~ '^JV[0-9]+$' THEN substring(voucher_no from 3)::bigint ELSE 0 END), 0) + 1
              FROM journal_entries
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
  return `JV${issued.toString().padStart(5, "0")}`;
}
