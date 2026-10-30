import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useTr } from "@/lib/tr";
import { useAuthStore } from "@/stores/authStore";

type Account = {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
};

type BankAccount = {
  id: string;
  bankName: string;
  accountNo: string;
  accountId: string;
  isActive: boolean;
};

type ImportedRow = {
  id: string;
  rowNo: number;
  date: string;
  description: string;
  side: "debit" | "credit";
  amount: number;
  accountId: string;
  post: boolean;
  touched: boolean;
  matchSource: "" | "memory" | "keyword";
};

type MappingRule = {
  pattern: string;
  accountId: string;
  hits: number;
  updatedAt: number;
};

const RULE_VERSION = 1;
const BANK_RULE_STOP_WORDS = new Set([
  "bank",
  "payment",
  "transfer",
  "trans",
  "receipt",
  "deposit",
  "duitnow",
  "online",
  "ibg",
  "instant",
  "fund",
  "transaction",
  "txn",
  "credit",
  "debit",
  "ref",
  "reference",
  "fp",
  "biz",
  "qr",
  "to",
  "from",
  "the",
  "and",
  "for",
  "with",
]);

function normalizeDescription(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/[^a-z\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeDescription(input: string): string[] {
  const normalized = normalizeDescription(input);
  if (!normalized) return [];
  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !BANK_RULE_STOP_WORDS.has(token)),
    ),
  );
}

function buildRulePatterns(description: string): string[] {
  const normalized = normalizeDescription(description);
  const tokens = tokenizeDescription(description);
  const patterns = normalized ? [normalized, ...tokens.slice(0, 6)] : tokens.slice(0, 6);
  return Array.from(new Set(patterns.filter(Boolean)));
}

function rulesStorageKey(orgId: string, bankAccountId: string): string {
  return `bby_bank_rec_rules:v${RULE_VERSION}:${orgId}:${bankAccountId}`;
}

function readRules(orgId: string | null | undefined, bankAccountId: string): MappingRule[] {
  if (!orgId || !bankAccountId) return [];
  try {
    const raw = window.localStorage.getItem(rulesStorageKey(orgId, bankAccountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        pattern: String(item?.pattern || ""),
        accountId: String(item?.accountId || ""),
        hits: Number(item?.hits || 0) || 0,
        updatedAt: Number(item?.updatedAt || 0) || 0,
      }))
      .filter((item) => item.pattern && item.accountId);
  } catch {
    return [];
  }
}

function writeRules(orgId: string | null | undefined, bankAccountId: string, rules: MappingRule[]) {
  if (!orgId || !bankAccountId) return;
  try {
    window.localStorage.setItem(rulesStorageKey(orgId, bankAccountId), JSON.stringify(rules.slice(0, 200)));
  } catch {
    // ignore
  }
}

function mergeRules(existing: MappingRule[], rows: Array<{ description: string; accountId: string }>): MappingRule[] {
  const next = new Map<string, MappingRule>(existing.map((rule) => [`${rule.pattern}::${rule.accountId}`, rule] as const));
  const now = Date.now();
  for (const row of rows) {
    if (!row.accountId) continue;
    for (const pattern of buildRulePatterns(row.description)) {
      const key = `${pattern}::${row.accountId}`;
      const prev = next.get(key);
      next.set(key, {
        pattern,
        accountId: row.accountId,
        hits: (prev?.hits || 0) + 1,
        updatedAt: now,
      });
    }
  }
  return Array.from(next.values()).sort((a, b) => b.hits - a.hits || b.updatedAt - a.updatedAt);
}

function guessAccountByMemory(description: string, rules: MappingRule[], validAccountIds: Set<string>) {
  const normalized = normalizeDescription(description);
  if (!normalized) return null;
  let best: { accountId: string; score: number } | null = null;
  for (const rule of rules) {
    if (!validAccountIds.has(rule.accountId) || !rule.pattern) continue;
    let matched = false;
    let score = 0;
    if (normalized === rule.pattern) {
      matched = true;
      score = 500 + rule.hits * 20 + Math.min(rule.pattern.length, 50);
    } else if (rule.pattern.length >= 2 && normalized.includes(rule.pattern)) {
      matched = true;
      score = 200 + rule.hits * 15 + Math.min(rule.pattern.length, 40);
    }
    if (matched && (!best || score > best.score)) {
      best = { accountId: rule.accountId, score };
    }
  }
  return best;
}

function guessAccountByKeywords(description: string, accounts: Account[], validAccountIds: Set<string>) {
  const normalized = normalizeDescription(description);
  const descTokens = tokenizeDescription(description);
  if (!normalized || !descTokens.length) return null;

  let best: { accountId: string; score: number } | null = null;
  for (const account of accounts) {
    if (!validAccountIds.has(account.id)) continue;
    const nameTokens = tokenizeDescription(account.name);
    if (!nameTokens.length) continue;
    let score = 0;
    for (const token of nameTokens) {
      if (token.length >= 2 && normalized.includes(token)) score += token.length >= 4 ? 40 : 20;
    }
    if (account.code && normalized.includes(String(account.code).toLowerCase())) score += 60;
    if (score > 0 && (!best || score > best.score)) {
      best = { accountId: account.id, score };
    }
  }
  return best;
}

function autoMatchRows(inputRows: ImportedRow[], accounts: Account[], validAccountIds: Set<string>, rules: MappingRule[]): ImportedRow[] {
  return inputRows.map((row) => {
    if (row.touched && row.accountId) return row;
    const memory = guessAccountByMemory(row.description, rules, validAccountIds);
    if (memory) {
      return { ...row, accountId: memory.accountId, matchSource: "memory" };
    }
    const keyword = guessAccountByKeywords(row.description, accounts, validAccountIds);
    if (keyword) {
      return { ...row, accountId: keyword.accountId, matchSource: "keyword" };
    }
    return { ...row, accountId: row.touched ? row.accountId : "", matchSource: "" };
  });
}

export default function BankReconciliation() {
  const tr = useTr();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { orgs, activeOrgId, orgSwitching } = useAuthStore();
  const active = useMemo(() => orgs.find((org) => org.orgId === activeOrgId) || null, [orgs, activeOrgId]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [importedFileName, setImportedFileName] = useState("");
  const [importedFileType, setImportedFileType] = useState<"excel" | "pdf" | "">("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const activeBankAccounts = useMemo(() => bankAccounts.filter((item) => item.isActive), [bankAccounts]);
  const selectedBank = useMemo(
    () => activeBankAccounts.find((item) => item.id === selectedBankAccountId) || null,
    [activeBankAccounts, selectedBankAccountId],
  );
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item] as const)), [accounts]);
  const accountOptions = useMemo(
    () =>
      accounts
        .filter((item) => item.isActive !== false && item.id !== selectedBank?.accountId)
        .sort((a, b) => String(a.code).localeCompare(String(b.code))),
    [accounts, selectedBank?.accountId],
  );
  const rules = useMemo(() => readRules(activeOrgId, selectedBankAccountId), [activeOrgId, selectedBankAccountId]);
  const validAccountIds = useMemo(() => new Set(accountOptions.map((item) => item.id)), [accountOptions]);

  const selectedCount = useMemo(() => rows.filter((row) => row.post).length, [rows]);
  const readyCount = useMemo(() => rows.filter((row) => row.post && row.accountId).length, [rows]);
  const debitTotal = useMemo(
    () => rows.filter((row) => row.post && row.side === "debit").reduce((sum, row) => sum + row.amount, 0),
    [rows],
  );
  const creditTotal = useMemo(
    () => rows.filter((row) => row.post && row.side === "credit").reduce((sum, row) => sum + row.amount, 0),
    [rows],
  );

  async function refresh() {
    const [accountsRes, bankAccountsRes] = await Promise.all([
      api<{ accounts: Account[] }>("/api/settings/accounts"),
      api<{ bankAccounts: BankAccount[] }>("/api/settings/bank-accounts"),
    ]);
    setAccounts(accountsRes.accounts || []);
    setBankAccounts(bankAccountsRes.bankAccounts || []);
    setSelectedBankAccountId((prev) => {
      const activeItems = (bankAccountsRes.bankAccounts || []).filter((item) => item.isActive);
      if (prev && activeItems.some((item) => item.id === prev)) return prev;
      return activeItems[0]?.id || "";
    });
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setBusy(true);
    setErr(null);
    setSuccess(null);
    refresh()
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [activeOrgId, orgSwitching]);

  async function importFile(file: File) {
    if (!selectedBankAccountId) {
      setErr(tr("请先选择银行账号。", "Please select a bank account first."));
      return;
    }
    setImporting(true);
    setErr(null);
    setSuccess(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api<{ rows: Array<Omit<ImportedRow, "id" | "accountId" | "post" | "touched" | "matchSource">>; fileName: string; fileType?: "excel" | "pdf" }>(
        "/api/bank-reconciliation/import",
        {
        method: "POST",
        body: formData,
        timeoutMs: 120_000,
      });
      setImportedFileName(result.fileName || file.name);
      setImportedFileType(result.fileType || (file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "excel"));
      const importedRows = (result.rows || []).map((row, idx) => ({
          id: `${row.rowNo}-${idx}`,
          rowNo: row.rowNo,
          date: row.date,
          description: row.description || "",
          side: row.side,
          amount: Number(row.amount) || 0,
          accountId: "",
          post: true,
          touched: false,
          matchSource: "" as const,
        }));
      setRows(autoMatchRows(importedRows, accountOptions, validAccountIds, rules));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function submitPosting() {
    if (!selectedBankAccountId) {
      setErr(tr("请先选择银行账号。", "Please select a bank account first."));
      return;
    }
    const selectedRows = rows.filter((row) => row.post);
    if (!selectedRows.length) {
      setErr(tr("请先勾选要过账的流水。", "Please select statement rows to post."));
      return;
    }
    const missingAccount = selectedRows.find((row) => !row.accountId);
    if (missingAccount) {
      setErr(tr("有流水还没有选择对应科目。", "Some statement rows do not have an account selected."));
      return;
    }

    setPosting(true);
    setErr(null);
    setSuccess(null);
    try {
      const result = await api<{ count: number }>("/api/bank-reconciliation/post", {
        method: "POST",
        json: {
          bankAccountId: selectedBankAccountId,
          rows: rows.map((row) => ({
            date: row.date,
            description: row.description,
            side: row.side,
            amount: row.amount,
            accountId: row.accountId,
            post: row.post,
          })),
        },
        timeoutMs: 120_000,
      });
      writeRules(
        activeOrgId,
        selectedBankAccountId,
        mergeRules(
          rules,
          selectedRows.map((row) => ({
            description: row.description,
            accountId: row.accountId,
          })),
        ),
      );
      setRows((prev) => prev.filter((row) => !row.post));
      setSuccess(tr(`已过账 ${result.count} 笔流水。`, `Posted ${result.count} bank transactions.`));
      if (rows.every((row) => row.post)) {
        setImportedFileName("");
        setImportedFileType("");
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <AppShell title={tr("银行对账", "Bank Reconciliation")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold">{tr("导入银行单并过账", "Import Statement And Post")}</div>
          <div className="mt-1 text-sm text-zinc-500">
            {tr("先选银行账号，再上传 Excel 或 PDF 银行单，系统会自动识别日期、摘要、借贷方和金额。", "Select a bank account, upload the Excel or PDF statement, then map each transaction to an account before posting.")}
          </div>

          {!activeBankAccounts.length ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="font-medium">{tr("还没有银行账号。", "No bank account exists yet.")}</div>
              <div className="mt-1">{tr("请先到设置里新增银行账号，再回来导入银行单。", "Create a bank account in Settings first, then return here to import the statement.")}</div>
              <Link className="mt-3 inline-flex rounded-md border border-amber-300 bg-white px-3 py-2 text-sm hover:bg-amber-100" to="/settings">
                {tr("去设置新建银行账号", "Go To Settings")}
              </Link>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-xs text-zinc-600">{tr("银行账号", "Bank Account")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                    value={selectedBankAccountId}
                    onChange={(e) => setSelectedBankAccountId(e.target.value)}
                    disabled={busy || importing || posting}
                  >
                    <option value="">{tr("请选择", "Select")}</option>
                    {activeBankAccounts.map((item) => {
                      const linkedAccount = accountById.get(item.accountId);
                      return (
                        <option key={item.id} value={item.id}>
                          {item.bankName} - {item.accountNo}
                          {linkedAccount ? ` (${linkedAccount.code} ${linkedAccount.name})` : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("上传银行单", "Statement File")}</label>
                  <input
                    ref={fileInputRef}
                    className="mt-1 block w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm"
                    type="file"
                    accept=".xlsx,.pdf,application/pdf"
                    disabled={importing || posting || !selectedBankAccountId}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void importFile(file);
                    }}
                  />
                  <div className="mt-1 text-xs text-zinc-500">{tr("目前支持 .xlsx 和文本型 PDF。", "Currently supports .xlsx and text-based PDF statements.")}</div>
                </div>
              </div>

              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={busy || importing || posting}
                onClick={() => refresh().catch((e: any) => setErr(e.message))}
                type="button"
              >
                {tr("刷新", "Refresh")}
              </button>
            </div>
          )}

          {selectedBank ? (
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">{tr("当前银行", "Selected Bank")}</div>
                <div className="mt-1 text-sm font-medium text-zinc-800">
                  {selectedBank.bankName} / {selectedBank.accountNo}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">{tr("基准币", "Base Currency")}</div>
                <div className="mt-1 text-sm font-medium text-zinc-800">{active?.baseCurrency || "-"}</div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">{tr("已勾选流水", "Selected Rows")}</div>
                <div className="mt-1 text-sm font-medium text-zinc-800">
                  {selectedCount} / {rows.length}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="text-xs text-zinc-500">{tr("已完成科目匹配", "Mapped Rows")}</div>
                <div className="mt-1 text-sm font-medium text-zinc-800">
                  {readyCount} / {selectedCount}
                </div>
              </div>
            </div>
          ) : null}

          {err ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
          {success ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</div> : null}
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold">{tr("导入结果", "Imported Transactions")}</div>
              <div className="mt-1 text-sm text-zinc-500">
                {importedFileName
                  ? tr(`文件：${importedFileName}${importedFileType ? `（${importedFileType.toUpperCase()}）` : ""}`, `File: ${importedFileName}${importedFileType ? ` (${importedFileType.toUpperCase()})` : ""}`)
                  : tr("上传 Excel 或 PDF 后会在这里显示流水表格。", "Imported statement rows will appear here after upload.")}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={!rows.length || posting}
                onClick={() => setRows((prev) => autoMatchRows(prev, accountOptions, validAccountIds, rules))}
                type="button"
              >
                {tr("重新自动猜测", "Auto Match Again")}
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={!rows.length || posting}
                onClick={() => setRows((prev) => prev.map((row) => ({ ...row, post: true })))}
                type="button"
              >
                {tr("全选", "Select All")}
              </button>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={!rows.length || posting}
                onClick={() => setRows((prev) => prev.map((row) => ({ ...row, post: false })))}
                type="button"
              >
                {tr("取消全选", "Clear Selection")}
              </button>
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={!selectedBankAccountId || !rows.length || !selectedCount || posting || importing}
                onClick={() => void submitPosting()}
                type="button"
              >
                {posting ? tr("过账中...", "Posting...") : tr("过账", "Post")}
              </button>
            </div>
          </div>

          {rows.length ? (
            <>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <div className="text-xs text-zinc-500">{tr("流出（Debit）", "Outflow (Debit)")}</div>
                  <div className="mt-1 text-sm font-medium text-zinc-800">
                    {debitTotal.toFixed(2)} {active?.baseCurrency || ""}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <div className="text-xs text-zinc-500">{tr("流入（Credit）", "Inflow (Credit)")}</div>
                  <div className="mt-1 text-sm font-medium text-zinc-800">
                    {creditTotal.toFixed(2)} {active?.baseCurrency || ""}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <div className="text-xs text-zinc-500">{tr("说明", "Note")}</div>
                  <div className="mt-1 text-sm text-zinc-700">
                    {tr("系统会优先用历史规则自动匹配科目；银行单贷方记银行科目借方，银行单借方记银行科目贷方。", "The system first uses saved rules to auto-match accounts; statement credit posts to bank debit, and statement debit posts to bank credit.")}
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-600">
                    <tr>
                      <th className="px-3 py-2 text-left">{tr("过账", "Post")}</th>
                      <th className="px-3 py-2 text-left">{tr("日期", "Date")}</th>
                      <th className="px-3 py-2 text-left">{tr("摘要", "Description")}</th>
                      <th className="px-3 py-2 text-left">{tr("借贷方", "Statement Side")}</th>
                      <th className="px-3 py-2 text-right">{tr("金额", "Amount")}</th>
                      <th className="px-3 py-2 text-left">{tr("对应科目", "Offset Account")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={row.post}
                            disabled={posting}
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((item) => (item.id === row.id ? { ...item, post: e.target.checked } : item)),
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{row.date}</td>
                        <td className="px-3 py-2">
                          <div className="max-w-[380px] whitespace-pre-wrap break-words">{row.description || "-"}</div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {row.side === "debit" ? tr("借方 / 流出", "Debit / Outflow") : tr("贷方 / 流入", "Credit / Inflow")}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{row.amount.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <select
                            className="w-full min-w-[240px] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                            value={row.accountId}
                            disabled={posting}
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((item) =>
                                  item.id === row.id
                                    ? { ...item, accountId: e.target.value, touched: true, matchSource: "" }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option value="">{tr("请选择科目", "Select Account")}</option>
                            {accountOptions.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.code} {account.name}
                              </option>
                            ))}
                          </select>
                          {row.matchSource ? (
                            <div className="mt-1 text-xs text-zinc-500">
                              {row.matchSource === "memory"
                                ? tr("已按上次规则自动匹配", "Matched from saved rule")
                                : tr("已按关键字自动猜测", "Guessed from keywords")}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center text-sm text-zinc-500">
              {importing ? tr("正在解析 Excel...", "Parsing Excel...") : tr("还没有导入流水。", "No statement rows imported yet.")}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
