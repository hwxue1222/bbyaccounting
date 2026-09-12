import { round2, round6 } from "../lib/nums.js";
import { sha256 } from "../lib/migrate.js";
import { signSession, verifySession } from "../lib/security.js";
import { buildHeuristicSuggestion } from "../lib/assistRules.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  assert(round2(1.005) === 1, "round2 should be stable");
  assert(round2(1.015) === 1.01, "round2 should round to 2 decimals");
  assert(round6(1.0000004) === 1, "round6 should round to 6 decimals");

  const h = sha256("abc");
  assert(typeof h === "string" && h.length === 64, "sha256 should return hex");

  const jwt = signSession({ userId: "u1", orgId: "o1" });
  const claims = verifySession(jwt);
  assert(claims.userId === "u1", "session userId should match");
  assert(claims.orgId === "o1", "session orgId should match");

  const accounts = [
    { id: "a1000", code: "1000", name: "Cash", type: "asset" },
    { id: "a1500", code: "1500", name: "Inventory", type: "asset" },
    { id: "a1200", code: "1200", name: "Accounts Receivable", type: "asset" },
    { id: "a1600", code: "1600", name: "Fixed Assets", type: "asset" },
    { id: "a1610", code: "1610", name: "Accumulated Depreciation", type: "asset" },
    { id: "a2000", code: "2000", name: "Accounts Payable", type: "liability" },
    { id: "a4000", code: "4000", name: "Sales", type: "income" },
    { id: "a7000", code: "7000", name: "Gain on Disposal", type: "income" },
    { id: "a6000", code: "6000", name: "Expense", type: "expense" },
  ];
  const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id] as const));
  const accountNameByCode = new Map(accounts.map((a) => [a.code, a.name] as const));

  const s1 = buildHeuristicSuggestion({
    text: "公司，未支付，卖了一辆汽车，售价 50000 MYR，原值 80000，累计折旧 30000",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(s1.draft?.lines?.length === 3, "disposal draft should have 3 lines when no gain/loss");
  assert(String(s1.preview.lines[0].accountCode) === "1200", "unpaid disposal should debit AR 1200");
  assert(String(s1.preview.lines[1].accountCode) === "1610", "disposal should debit accum dep");
  assert(String(s1.preview.lines[2].accountCode) === "1600", "disposal should credit fixed asset cost");

  const s2 = buildHeuristicSuggestion({
    text: "公司，现金，卖了一辆汽车，售价 50000 MYR，原值 80000，累计折旧 30000",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(String(s2.preview.lines[0].accountCode) === "1000", "cash disposal should debit cash 1000");
  assert(String(s2.preview.lines[1].accountCode) === "1610", "disposal should debit accum dep");
  assert(String(s2.preview.lines[2].accountCode) === "1600", "disposal should credit fixed asset cost");

  const s4 = buildHeuristicSuggestion({
    text: "公司，未支付，卖了一辆汽车，售价 60000 MYR，原值 80000，累计折旧 30000",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(s4.draft?.lines?.length === 4, "disposal with gain should have 4 lines");
  assert(String(s4.preview.lines[3].accountCode) === "7000", "disposal gain should use 7000");

  const s5 = buildHeuristicSuggestion({
    text: "公司，未支付，卖了一辆汽车，售价 30000 MYR，原值 80000，累计折旧 30000",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(s5.draft?.lines?.length === 4, "disposal with loss should have 4 lines");
  assert(String(s5.preview.lines[3].accountCode) === "7000", "disposal loss should use 7000 on debit");
  assert(Number(s5.preview.lines[3].debitTxn) > 0, "disposal loss should be debit");

  const accountsNoIncome = accounts.filter((a) => a.type !== "income");
  const accountIdByCodeNoIncome = new Map(accountsNoIncome.map((a) => [a.code, a.id] as const));
  const accountNameByCodeNoIncome = new Map(accountsNoIncome.map((a) => [a.code, a.name] as const));
  const s3 = buildHeuristicSuggestion({
    text: "公司，未支付，卖了一项服务，50000 MYR",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts: accountsNoIncome,
    accountIdByCode: accountIdByCodeNoIncome,
    accountNameByCode: accountNameByCodeNoIncome,
  });
  assert(s3.draft == null, "sale should return null draft when income account missing");
  assert(Array.isArray(s3.missing) && s3.missing.length > 0, "missing should include income account hint");

  const s6 = buildHeuristicSuggestion({
    text: "公司，未支付，买了现有存货 ST0001 knife，15 MYR",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(s6.draft?.lines?.length === 2, "inventory purchase should have 2 lines");
  assert(String(s6.preview.lines[0].accountCode) === "1500", "inventory purchase should debit 1500");
  assert(String(s6.preview.lines[1].accountCode) === "2000", "unpaid inventory purchase should credit 2000");
}

main()
  .then(() => {
    process.stdout.write("OK\n");
  })
  .catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n");
    process.exit(1);
  });
