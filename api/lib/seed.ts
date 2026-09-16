import { getSql } from "./db.js";

export type Industry = "restaurant" | "trading" | "service";

export async function seedOrgDefaults(sql: ReturnType<typeof getSql>, orgId: string, baseCurrency: string, industry?: Industry) {
  const ind: Industry = industry === "trading" || industry === "service" ? industry : "restaurant";

  const base = [
    { code: "1000", name: "Cash", type: "asset", normal_balance: "debit" },
    { code: "1100", name: "Bank", type: "asset", normal_balance: "debit" },
    { code: "1200", name: "Accounts Receivable", type: "asset", normal_balance: "debit" },
    { code: "2000", name: "Accounts Payable", type: "liability", normal_balance: "credit" },
    { code: "2021", name: "Amount due to director", type: "liability", normal_balance: "credit" },
    { code: "3000", name: "Retained Earnings", type: "equity", normal_balance: "credit" },
    { code: "4000", name: "Sales", type: "income", normal_balance: "credit" },
    { code: "5000", name: "Cost of Goods Sold", type: "cogs", normal_balance: "debit" },
    { code: "6000", name: "Operating Expenses", type: "expense", normal_balance: "debit" },
    { code: "6100", name: "Depreciation Expense", type: "expense", normal_balance: "debit" },
    { code: "1600", name: "Fixed Assets", type: "asset", normal_balance: "debit" },
    { code: "1610", name: "Accumulated Depreciation", type: "asset", normal_balance: "credit" },
    { code: "7000", name: "Gain/Loss on Disposal", type: "expense", normal_balance: "debit" },
  ];

  const restaurant = [
    { code: "1500", name: "Inventory", type: "asset", normal_balance: "debit" },
    { code: "5010", name: "Food & Beverage Cost", type: "cogs", normal_balance: "debit" },
    { code: "6020", name: "Rent", type: "expense", normal_balance: "debit" },
    { code: "6030", name: "Utilities", type: "expense", normal_balance: "debit" },
    { code: "6040", name: "Renovation", type: "expense", normal_balance: "debit" },
    { code: "6050", name: "Design Fee", type: "expense", normal_balance: "debit" },
    { code: "6060", name: "Salary", type: "expense", normal_balance: "debit" },
    { code: "6070", name: "Marketing", type: "expense", normal_balance: "debit" },
    { code: "6080", name: "Cleaning", type: "expense", normal_balance: "debit" },
    { code: "6090", name: "POS / Software", type: "expense", normal_balance: "debit" },
  ];

  const trading = [
    { code: "1500", name: "Inventory", type: "asset", normal_balance: "debit" },
    { code: "5010", name: "Purchases", type: "cogs", normal_balance: "debit" },
    { code: "6020", name: "Rent", type: "expense", normal_balance: "debit" },
    { code: "6070", name: "Marketing", type: "expense", normal_balance: "debit" },
  ];

  const service = [
    { code: "6020", name: "Rent", type: "expense", normal_balance: "debit" },
    { code: "6060", name: "Salary", type: "expense", normal_balance: "debit" },
    { code: "6070", name: "Marketing", type: "expense", normal_balance: "debit" },
    { code: "6040", name: "Renovation", type: "expense", normal_balance: "debit" },
  ];

  const accounts = [...base, ...(ind === "restaurant" ? restaurant : ind === "trading" ? trading : service)];
  await sql.begin(async (trx) => {
    for (const a of accounts) {
      const linkInv = String(a.code) === "1500";
      const linkFa = String(a.code).startsWith("16") || String(a.code).startsWith("61");
      await trx`
        INSERT INTO accounts (org_id, code, name, type, normal_balance, link_inventory_fifo, link_fixed_assets)
        VALUES (${orgId}, ${a.code}, ${a.name}, ${a.type}, ${a.normal_balance}, ${linkInv}, ${linkFa})
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
