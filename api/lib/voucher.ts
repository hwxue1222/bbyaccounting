export async function issueVoucherNo(
  trx: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>,
  orgId: string,
): Promise<string> {
  await trx`SELECT pg_advisory_xact_lock(hashtext(${orgId} || ':JV'))`;
  const rows = await trx`
    SELECT
      COALESCE(MAX(CASE WHEN voucher_no ~ '^JV[0-9]+$' THEN substring(voucher_no from 3)::bigint ELSE 0 END), 0) as "maxInt"
    FROM journal_entries
    WHERE org_id = ${orgId}
  `;
  const maxInt = BigInt((rows[0] as any)?.maxInt || 0);
  const next = maxInt + 1n;
  return `JV${next.toString().padStart(5, "0")}`;
}
