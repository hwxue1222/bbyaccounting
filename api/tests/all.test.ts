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
    { id: "a1200", code: "1200", name: "Accounts Receivable", type: "asset" },
    { id: "a1600", code: "1600", name: "Fixed Assets", type: "asset" },
    { id: "a2000", code: "2000", name: "Accounts Payable", type: "liability" },
    { id: "a4000", code: "4000", name: "Sales", type: "income" },
  ];
  const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id] as const));
  const accountNameByCode = new Map(accounts.map((a) => [a.code, a.name] as const));

  const s1 = buildHeuristicSuggestion({
    text: "公司，未支付，卖了一辆汽车，50000 MYR",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(s1.draft?.lines?.length === 2, "sale draft should have 2 lines");
  assert(String(s1.preview.lines[0].accountCode) === "1200", "unpaid sale should debit AR 1200");
  assert(String(s1.preview.lines[1].accountCode) === "4000", "sale should credit income");

  const s2 = buildHeuristicSuggestion({
    text: "公司，现金，卖了一辆汽车，50000 MYR",
    lang: "zh",
    baseCurrency: "MYR",
    forcedEntryDate: "2026-09-12",
    extraMemo: "",
    accounts,
    accountIdByCode,
    accountNameByCode,
  });
  assert(String(s2.preview.lines[0].accountCode) === "1000", "cash sale should debit cash 1000");
  assert(String(s2.preview.lines[1].accountCode) === "4000", "cash sale should credit income");
}

main()
  .then(() => {
    process.stdout.write("OK\n");
  })
  .catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n");
    process.exit(1);
  });

