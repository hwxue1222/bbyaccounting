import { getSql } from "./db.js";

export async function seedOrgDefaults(sql: ReturnType<typeof getSql>, orgId: string, baseCurrency: string) {
  const accounts = [
    { code: "1000", name: "Cash", type: "asset", normal_balance: "debit" },
    { code: "1200", name: "Accounts Receivable", type: "asset", normal_balance: "debit" },
    { code: "2000", name: "Accounts Payable", type: "liability", normal_balance: "credit" },
    { code: "3000", name: "Retained Earnings", type: "equity", normal_balance: "credit" },
    { code: "4000", name: "Sales", type: "income", normal_balance: "credit" },
    { code: "5000", name: "Cost of Goods Sold", type: "cogs", normal_balance: "debit" },
    { code: "6000", name: "Operating Expenses", type: "expense", normal_balance: "debit" },
    { code: "6100", name: "Depreciation Expense", type: "expense", normal_balance: "debit" },
    { code: "1500", name: "Inventory", type: "asset", normal_balance: "debit" },
    { code: "1600", name: "Fixed Assets", type: "asset", normal_balance: "debit" },
    { code: "1610", name: "Accumulated Depreciation", type: "asset", normal_balance: "credit" },
    { code: "7000", name: "Gain/Loss on Disposal", type: "expense", normal_balance: "debit" },
  ];
  await sql.begin(async (trx) => {
    for (const a of accounts) {
      await trx`
        INSERT INTO accounts (org_id, code, name, type, normal_balance)
        VALUES (${orgId}, ${a.code}, ${a.name}, ${a.type}, ${a.normal_balance})
        ON CONFLICT (org_id, code) DO NOTHING
      `;
    }
    await trx`
      INSERT INTO currencies (org_id, code, is_enabled)
      VALUES (${orgId}, ${baseCurrency.toUpperCase()}, true)
      ON CONFLICT (org_id, code) DO NOTHING
    `;
  });
}

