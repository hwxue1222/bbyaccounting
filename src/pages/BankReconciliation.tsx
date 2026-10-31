import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useTr } from "@/lib/tr";
import { useAuthStore } from "@/stores/authStore";

type Account = {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
  linkInventoryFifo?: boolean;
  linkFixedAssets?: boolean;
};

type BankAccount = {
  id: string;
  bankName: string;
  accountNo: string;
  accountId: string;
  isActive: boolean;
};

type InventoryItem = {
  id: string;
  sku: string | null;
  name: string;
  uom: string;
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

type InventoryDraftRow = {
  rowId: string;
  itemId: string;
  qty: string;
  unitCostTxn: string;
};

type InventoryRowState = {
  mode: "receipt" | "shipment";
  defaultSide: "debit" | "credit";
  expectedTxn: number;
  expectedBase: number;
  quoteBase: number;
  details: InventoryDraftRow[];
};

type FixedAssetPurchaseState = {
  mode: "purchase";
  category: string;
  assetNo: string;
  name: string;
  memo: string;
  acquisitionDate: string;
  usefulLifeMonths: number;
  salvageBase: number;
};

type FixedAssetDisposalState = {
  mode: "disposal";
  assetId: string;
  assetNo: string;
  name: string;
  costTxn: number;
  accumDepTxn: number;
  gainLossTxn: number;
};

type FixedAssetRowState = FixedAssetPurchaseState | FixedAssetDisposalState;

type FixedAssetRecord = {
  id: string;
  assetNo: string | null;
  category: string | null;
  name: string;
  status: string;
  acquisitionDate: string | null;
  usefulLifeMonths: number | null;
  salvageValueBase: number | null;
  memo: string | null;
  costBase: number;
  depExpenseAccountId: string | null;
  accumDepAccountId: string | null;
  assetAccountId: string | null;
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
  const navigate = useNavigate();
  const tr = useTr();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const invQuoteAbortRef = useRef<AbortController | null>(null);
  const { orgs, activeOrgId, orgSwitching } = useAuthStore();
  const active = useMemo(() => orgs.find((org) => org.orgId === activeOrgId) || null, [orgs, activeOrgId]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [fixedAssets, setFixedAssets] = useState<FixedAssetRecord[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [importedFileName, setImportedFileName] = useState("");
  const [importedFileType, setImportedFileType] = useState<"excel" | "">("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postingRowId, setPostingRowId] = useState<string | null>(null);
  const [lastPostedEntryId, setLastPostedEntryId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [inventoryByRowId, setInventoryByRowId] = useState<Record<string, InventoryRowState>>({});
  const [fixedAssetByRowId, setFixedAssetByRowId] = useState<Record<string, FixedAssetRowState>>({});

  const [invModalOpen, setInvModalOpen] = useState(false);
  const [invEditingRowId, setInvEditingRowId] = useState<string | null>(null);
  const [invMode, setInvMode] = useState<"receipt" | "shipment">("receipt");
  const [invDefaultSide, setInvDefaultSide] = useState<"debit" | "credit">("debit");
  const [invExpectedTxn, setInvExpectedTxn] = useState(0);
  const [invExpectedBase, setInvExpectedBase] = useState(0);
  const [invEditingDetails, setInvEditingDetails] = useState<InventoryDraftRow[]>([]);
  const [invQuoteByRow, setInvQuoteByRow] = useState<Record<string, { base: number | null; err: string | null }>>({});

  const [invNewItemOpen, setInvNewItemOpen] = useState(false);
  const [invNewItemBusy, setInvNewItemBusy] = useState(false);
  const [invNewItemErr, setInvNewItemErr] = useState<string | null>(null);
  const [invNewItemTargetRowId, setInvNewItemTargetRowId] = useState<string | null>(null);
  const [invNewItemForm, setInvNewItemForm] = useState({ sku: "", name: "", uom: "EA" });

  const [faModalOpen, setFaModalOpen] = useState(false);
  const [faMode, setFaMode] = useState<"purchase" | "disposal">("purchase");
  const [faEditingRowId, setFaEditingRowId] = useState<string | null>(null);
  const [faForm, setFaForm] = useState<FixedAssetPurchaseState>({
    mode: "purchase",
    category: "",
    assetNo: "",
    name: "",
    memo: "",
    acquisitionDate: new Date().toISOString().slice(0, 10),
    usefulLifeMonths: 36,
    salvageBase: 0,
  });
  const [faDisposalForm, setFaDisposalForm] = useState<FixedAssetDisposalState>({
    mode: "disposal",
    assetId: "",
    assetNo: "",
    name: "",
    costTxn: 0,
    accumDepTxn: 0,
    gainLossTxn: 0,
  });

  const activeBankAccounts = useMemo(() => bankAccounts.filter((item) => item.isActive), [bankAccounts]);
  const selectedBank = useMemo(
    () => activeBankAccounts.find((item) => item.id === selectedBankAccountId) || null,
    [activeBankAccounts, selectedBankAccountId],
  );
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item] as const)), [accounts]);
  const inventoryItemById = useMemo(() => new Map(inventoryItems.map((item) => [item.id, item] as const)), [inventoryItems]);
  const inventoryItemsSorted = useMemo(
    () =>
      inventoryItems
        .slice()
        .sort((a, b) => `${a.sku || ""} ${a.name}`.localeCompare(`${b.sku || ""} ${b.name}`)),
    [inventoryItems],
  );
  const accountOptions = useMemo(
    () =>
      accounts
        .filter((item) => item.isActive !== false && item.id !== selectedBank?.accountId)
        .sort((a, b) => String(a.code).localeCompare(String(b.code))),
    [accounts, selectedBank?.accountId],
  );
  const rules = useMemo(() => readRules(activeOrgId, selectedBankAccountId), [activeOrgId, selectedBankAccountId]);
  const validAccountIds = useMemo(() => new Set(accountOptions.map((item) => item.id)), [accountOptions]);
  const isInventoryLinkedAccount = (accountId: string) => Boolean(accountById.get(accountId)?.linkInventoryFifo);
  const isFixedAssetLinkedAccount = (accountId: string) => Boolean(accountById.get(accountId)?.linkFixedAssets);

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

  function newRowId(): string {
    const c: any = (globalThis as any).crypto;
    return typeof c?.randomUUID === "function" ? c.randomUUID() : `${Date.now()}-${Math.random()}`;
  }

  function baseCurrency(): string {
    return String(active?.baseCurrency || "SGD").toUpperCase();
  }

  async function refresh() {
    const [accountsRes, bankAccountsRes, itemsRes, fixedAssetsRes] = await Promise.all([
      api<{ accounts: Account[] }>("/api/settings/accounts"),
      api<{ bankAccounts: BankAccount[] }>("/api/settings/bank-accounts"),
      api<{ items: any[] }>("/api/inventory/items"),
      api<{ assets: any[] }>("/api/fixed-assets"),
    ]);
    setAccounts(accountsRes.accounts || []);
    setBankAccounts(bankAccountsRes.bankAccounts || []);
    setInventoryItems((itemsRes.items || []).map((item: any) => ({ id: item.id, sku: item.sku ?? null, name: item.name, uom: item.uom })));
    setFixedAssets(
      (fixedAssetsRes.assets || []).map((item: any) => ({
        id: String(item.id),
        assetNo: item.assetNo ? String(item.assetNo) : null,
        category: item.category ? String(item.category) : null,
        name: String(item.name || ""),
        status: String(item.status || ""),
        acquisitionDate: item.acquisitionDate ? String(item.acquisitionDate) : null,
        usefulLifeMonths: item.usefulLifeMonths != null ? Number(item.usefulLifeMonths) : null,
        salvageValueBase: item.salvageValueBase != null ? Number(item.salvageValueBase) : null,
        memo: item.memo ? String(item.memo) : null,
        costBase: Number(item.costBase || 0),
        depExpenseAccountId: item.depExpenseAccountId ? String(item.depExpenseAccountId) : null,
        accumDepAccountId: item.accumDepAccountId ? String(item.accumDepAccountId) : null,
        assetAccountId: item.assetAccountId ? String(item.assetAccountId) : null,
      })),
    );
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

  useEffect(() => {
    const validIds = new Set(rows.map((row) => row.id));
    setInventoryByRowId((prev) => {
      const entries = Object.entries(prev).filter(([rowId]) => validIds.has(rowId));
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries);
    });
    setFixedAssetByRowId((prev) => {
      const entries = Object.entries(prev).filter(([rowId]) => validIds.has(rowId));
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries);
    });
  }, [rows]);

  const invEditingTotals = useMemo(() => {
    const totalTxn =
      invMode === "receipt"
        ? Math.round(invEditingDetails.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.unitCostTxn) || 0), 0) * 100) / 100
        : 0;
    const totalQuoteBase =
      invMode === "shipment"
        ? Math.round(invEditingDetails.reduce((sum, item) => sum + (Number(invQuoteByRow[item.rowId]?.base) || 0), 0) * 100) / 100
        : 0;
    return { totalTxn, totalQuoteBase };
  }, [invMode, invEditingDetails, invQuoteByRow]);

  useEffect(() => {
    if (!invModalOpen || invMode !== "shipment") return;
    invQuoteAbortRef.current?.abort();
    const ctrl = new AbortController();
    invQuoteAbortRef.current = ctrl;

    const validRows = invEditingDetails.filter((item) => item.itemId && (Number(item.qty) || 0) > 0);
    const timer = window.setTimeout(() => {
      void (async () => {
        const pairs = await Promise.all(
          validRows.map(async (item) => {
            try {
              const resp = await api<{ itemId: string; qty: number; totalBase: number }>(
                `/api/inventory/shipments/quote?itemId=${encodeURIComponent(item.itemId)}&qty=${encodeURIComponent(String(Number(item.qty) || 0))}`,
                { signal: ctrl.signal },
              );
              return [item.rowId, { base: Number(resp.totalBase), err: null }] as const;
            } catch (e: any) {
              if (e?.name === "AbortError") return [item.rowId, { base: null, err: null }] as const;
              return [item.rowId, { base: null, err: e?.message || "Quote failed" }] as const;
            }
          }),
        );
        if (ctrl.signal.aborted) return;
        setInvQuoteByRow((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })();
    }, 300);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [invModalOpen, invMode, invEditingDetails]);

  function handleRowAccountChange(rowId: string, accountId: string) {
    setRows((prev) =>
      prev.map((item) =>
        item.id === rowId
          ? { ...item, accountId, touched: true, matchSource: "" }
          : item,
      ),
    );
    if (!accountId || !isInventoryLinkedAccount(accountId)) {
      setInventoryByRowId((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }
    if (!accountId || !isFixedAssetLinkedAccount(accountId)) {
      setFixedAssetByRowId((prev) => {
        if (!(rowId in prev)) return prev;
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }
  }

  async function openInventoryModalForRow(row: ImportedRow) {
    if (!row.accountId || !isInventoryLinkedAccount(row.accountId)) return;
    let availableItems = inventoryItems;
    if (!inventoryItems.length) {
      const resp = await api<{ items: any[] }>("/api/inventory/items");
      availableItems = (resp.items || []).map((item: any) => ({ id: item.id, sku: item.sku ?? null, name: item.name, uom: item.uom }));
      setInventoryItems(availableItems);
    }
    const existing = inventoryByRowId[row.id];
    const mode = existing?.mode || (row.side === "debit" ? "receipt" : "shipment");
    const defaultSide = existing?.defaultSide || (row.side === "debit" ? "debit" : "credit");
    setInvEditingRowId(row.id);
    setInvMode(mode);
    setInvDefaultSide(defaultSide);
    setInvExpectedTxn(row.amount);
    setInvExpectedBase(row.amount);
    setInvEditingDetails(
      existing?.details?.length
        ? existing.details
        : [{ rowId: newRowId(), itemId: availableItems[0]?.id || "", qty: "1", unitCostTxn: mode === "receipt" ? String(row.amount || 1) : "" }],
    );
    setInvQuoteByRow({});
    setInvModalOpen(true);
  }

  async function openFixedAssetModalForRow(row: ImportedRow) {
    if (!row.accountId || !isFixedAssetLinkedAccount(row.accountId)) return;
    const existing = fixedAssetByRowId[row.id];
    setFaEditingRowId(row.id);
    if (row.side === "credit") {
      let availableAssets = fixedAssets;
      if (!availableAssets.length) {
        const resp = await api<{ assets: any[] }>("/api/fixed-assets");
        availableAssets = (resp.assets || []).map((item: any) => ({
          id: String(item.id),
          assetNo: item.assetNo ? String(item.assetNo) : null,
          category: item.category ? String(item.category) : null,
          name: String(item.name || ""),
          status: String(item.status || ""),
          acquisitionDate: item.acquisitionDate ? String(item.acquisitionDate) : null,
          usefulLifeMonths: item.usefulLifeMonths != null ? Number(item.usefulLifeMonths) : null,
          salvageValueBase: item.salvageValueBase != null ? Number(item.salvageValueBase) : null,
          memo: item.memo ? String(item.memo) : null,
          costBase: Number(item.costBase || 0),
          depExpenseAccountId: item.depExpenseAccountId ? String(item.depExpenseAccountId) : null,
          accumDepAccountId: item.accumDepAccountId ? String(item.accumDepAccountId) : null,
          assetAccountId: item.assetAccountId ? String(item.assetAccountId) : null,
        }));
        setFixedAssets(availableAssets);
      }
      setFaMode("disposal");
      const disposalExisting = existing?.mode === "disposal" ? existing : null;
      const seededAsset = disposalExisting?.assetId
        ? availableAssets.find((item) => item.id === disposalExisting.assetId) || null
        : availableAssets.find((item) => item.status === "active") || null;
      setFaDisposalForm({
        mode: "disposal",
        assetId: disposalExisting?.assetId || seededAsset?.id || "",
        assetNo: disposalExisting?.assetNo || seededAsset?.assetNo || "",
        name: disposalExisting?.name || seededAsset?.name || "",
        costTxn: disposalExisting?.costTxn || 0,
        accumDepTxn: disposalExisting?.accumDepTxn || 0,
        gainLossTxn: disposalExisting?.gainLossTxn || 0,
      });
      setFaModalOpen(true);
      return;
    }
    setFaMode("purchase");
    const purchaseExisting = existing?.mode === "purchase" ? existing : null;
    setFaForm(
      purchaseExisting || {
        mode: "purchase",
        category: "",
        assetNo: "",
        name: row.description?.trim() || tr("固定资产", "Fixed asset"),
        memo: row.description?.trim() || "",
        acquisitionDate: row.date,
        usefulLifeMonths: 36,
        salvageBase: 0,
      },
    );
    setFaModalOpen(true);
  }

  function buildJournalPayloadForRow(row: ImportedRow) {
    if (!selectedBank?.accountId) {
      throw new Error(tr("请先选择银行账号。", "Please select a bank account first."));
    }
    if (!row.accountId) {
      throw new Error(tr("请先选择对应科目。", "Please select an offset account first."));
    }

    const description = String(row.description || "").trim();
    const memo = `Bank reconciliation${description ? ` - ${description}` : ""}`;
    const otherDebit = row.side === "debit" ? row.amount : 0;
    const otherCredit = row.side === "credit" ? row.amount : 0;
    const bankDebit = row.side === "credit" ? row.amount : 0;
    const bankCredit = row.side === "debit" ? row.amount : 0;

    const inventoryState = inventoryByRowId[row.id];
    const fixedAssetState = fixedAssetByRowId[row.id];
    const needsInventory = isInventoryLinkedAccount(row.accountId);
    const needsFixedAsset = isFixedAssetLinkedAccount(row.accountId);

    if (needsInventory) {
      if (!inventoryState?.details?.length) {
        throw new Error(tr("库存科目必须先点“库存”并确认明细。", "Inventory-linked rows require confirmed inventory details first."));
      }
      if (
        inventoryState.details.some(
          (item) =>
            !item.itemId ||
            (Number(item.qty) || 0) <= 0 ||
            (inventoryState.mode === "receipt" && (Number(item.unitCostTxn) || 0) <= 0),
        )
      ) {
        throw new Error(tr("库存明细未填写完整。", "Inventory details are incomplete."));
      }
      if (inventoryState.mode === "receipt") {
        const totalTxn =
          Math.round(
            inventoryState.details.reduce(
              (sum, item) => sum + (Number(item.qty) || 0) * (Number(item.unitCostTxn) || 0),
              0,
            ) * 100,
          ) / 100;
        if (Math.round(totalTxn * 100) / 100 !== Math.round(row.amount * 100) / 100) {
          throw new Error(tr("库存入库明细合计必须与银行流水金额一致。", "Inventory receipt total must match the bank transaction amount."));
        }
      }
    }

    if (needsFixedAsset && row.side === "debit") {
      if (
        fixedAssetState?.mode !== "purchase" ||
        !fixedAssetState.category ||
        !fixedAssetState.acquisitionDate ||
        !fixedAssetState.name.trim() ||
        !(Number(fixedAssetState.usefulLifeMonths) > 0)
      ) {
        throw new Error(tr("固定资产借方必须先点“购买”并填写资料。", "Debit fixed-asset rows require purchase details first."));
      }
    }

    if (needsFixedAsset && row.side === "credit") {
      if (fixedAssetState?.mode !== "disposal" || !fixedAssetState.assetId || !(fixedAssetState.costTxn > 0) || !(fixedAssetState.accumDepTxn >= 0)) {
        throw new Error(tr("固定资产贷方必须先点“处置”并选择资产。", "Credit fixed-asset rows require disposal details first."));
      }
      const gainLossAccountId = accounts.find((item) => String(item.code || "") === "7000")?.id || "";
      if (!gainLossAccountId && Math.abs(fixedAssetState.gainLossTxn) >= 0.005) {
        throw new Error(tr("缺少 7000 处置损益科目。", "Missing 7000 gain/loss on disposal account."));
      }
      const lines = [
        {
          accountId: selectedBank.accountId,
          description: description || undefined,
          costCenterId: null,
          debitTxn: bankDebit,
          creditTxn: bankCredit,
        },
        {
          accountId: fixedAssets.find((item) => item.id === fixedAssetState.assetId)?.accumDepAccountId || "",
          description: tr("处置累计折旧", "Disposal accumulated depreciation"),
          costCenterId: null,
          debitTxn: fixedAssetState.accumDepTxn,
          creditTxn: 0,
          fixedAssetId: fixedAssetState.assetId,
        },
        {
          accountId: fixedAssets.find((item) => item.id === fixedAssetState.assetId)?.assetAccountId || row.accountId,
          description: tr("处置固定资产", "Dispose fixed asset"),
          costCenterId: null,
          debitTxn: 0,
          creditTxn: fixedAssetState.costTxn,
          fixedAssetId: fixedAssetState.assetId,
        },
      ] as Array<{
        accountId: string;
        description?: string;
        costCenterId: null;
        debitTxn: number;
        creditTxn: number;
        fixedAssetId?: string;
      }>;
      if (Math.abs(fixedAssetState.gainLossTxn) >= 0.005) {
        lines.push({
          accountId: gainLossAccountId,
          description: fixedAssetState.gainLossTxn > 0 ? tr("处置收益", "Disposal gain") : tr("处置损失", "Disposal loss"),
          costCenterId: null,
          debitTxn: fixedAssetState.gainLossTxn < 0 ? Math.abs(fixedAssetState.gainLossTxn) : 0,
          creditTxn: fixedAssetState.gainLossTxn > 0 ? fixedAssetState.gainLossTxn : 0,
        });
      }
      return {
        entryDate: row.date,
        currency: baseCurrency(),
        fxRate: 1,
        bankAccountId: selectedBank.id,
        memo,
        fixedAssetDisposal: { costLineNo: 3, accumDepLineNo: 2 },
        lines,
      };
    }

    return {
      entryDate: row.date,
      currency: baseCurrency(),
      fxRate: 1,
      bankAccountId: selectedBank.id,
      memo,
      inventoryLinkLineNo: needsInventory ? 1 : undefined,
      inventoryDetails: needsInventory
        ? inventoryState.details.map((item) =>
            inventoryState.mode === "receipt"
              ? { moveType: "receipt" as const, itemId: item.itemId, qty: Number(item.qty) || 0, unitCostTxn: Number(item.unitCostTxn) || 0 }
              : { moveType: "shipment" as const, itemId: item.itemId, qty: Number(item.qty) || 0 },
          )
        : undefined,
      fixedAssetPurchases: needsFixedAsset
        ? [
            {
              lineNo: 1,
              category: fixedAssetState.mode === "purchase" ? fixedAssetState.category : "",
              assetNo: fixedAssetState.mode === "purchase" ? fixedAssetState.assetNo || undefined : undefined,
              name: fixedAssetState.mode === "purchase" ? fixedAssetState.name.trim() : "",
              memo: fixedAssetState.mode === "purchase" ? fixedAssetState.memo || undefined : undefined,
              acquisitionDate: fixedAssetState.mode === "purchase" ? fixedAssetState.acquisitionDate : row.date,
              usefulLifeMonths: fixedAssetState.mode === "purchase" ? Number(fixedAssetState.usefulLifeMonths) || 0 : 0,
              salvageBase: fixedAssetState.mode === "purchase" ? Number(fixedAssetState.salvageBase) || 0 : 0,
            },
          ]
        : undefined,
      lines: [
        {
          accountId: row.accountId,
          description: description || undefined,
          costCenterId: null,
          debitTxn: otherDebit,
          creditTxn: otherCredit,
        },
        {
          accountId: selectedBank.accountId,
          description: description || undefined,
          costCenterId: null,
          debitTxn: bankDebit,
          creditTxn: bankCredit,
        },
      ],
    };
  }

  async function importFile(file: File) {
    if (!selectedBankAccountId) {
      setErr(tr("请先选择银行账号。", "Please select a bank account first."));
      return;
    }
    const lowerName = String(file.name || "").toLowerCase();
    const supported = lowerName.endsWith(".xlsx");
    if (!supported) {
      setErr(tr("目前只支持 .xlsx 银行单。", "Only .xlsx statements are supported right now."));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setImporting(true);
    setErr(null);
    setSuccess(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api<{ rows: Array<Omit<ImportedRow, "id" | "accountId" | "post" | "touched" | "matchSource">>; fileName: string; fileType?: "excel" }>(
        "/api/bank-reconciliation/import",
        {
        method: "POST",
        body: formData,
        timeoutMs: 120_000,
      });
      setImportedFileName(result.fileName || file.name);
      setImportedFileType(result.fileType || "excel");
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
      setInventoryByRowId({});
      setFixedAssetByRowId({});
      setRows(autoMatchRows(importedRows, accountOptions, validAccountIds, rules));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function submitPosting(rowId?: string) {
    if (!selectedBankAccountId) {
      setErr(tr("请先选择银行账号。", "Please select a bank account first."));
      return;
    }
    const selectedRows = rowId ? rows.filter((row) => row.id === rowId) : rows.filter((row) => row.post);
    if (!selectedRows.length) {
      setErr(rowId ? tr("当前流水不存在。", "The selected row no longer exists.") : tr("请先勾选要过账的流水。", "Please select statement rows to post."));
      return;
    }
    const missingAccount = selectedRows.find((row) => !row.accountId);
    if (missingAccount) {
      setErr(rowId ? tr("请先为这笔流水选择对应科目。", "Please select an offset account for this row first.") : tr("有流水还没有选择对应科目。", "Some statement rows do not have an account selected."));
      return;
    }

    setPosting(true);
    setPostingRowId(rowId || null);
    setErr(null);
    setSuccess(null);
    setLastPostedEntryId(null);
    const postedRows: ImportedRow[] = [];
    let latestEntryId: string | null = null;
    try {
      for (const row of selectedRows) {
        const result = await api<{ entry?: { id: string }; entries?: Array<{ id: string; voucherNo: string }> }>("/api/journals/post", {
          method: "POST",
          json: buildJournalPayloadForRow(row),
          timeoutMs: 120_000,
        });
        postedRows.push(row);
        latestEntryId = result.entry?.id || result.entries?.[result.entries.length - 1]?.id || latestEntryId;
      }
      writeRules(
        activeOrgId,
        selectedBankAccountId,
        mergeRules(
          rules,
          postedRows.map((row) => ({
            description: row.description,
            accountId: row.accountId,
          })),
        ),
      );
      setLastPostedEntryId(latestEntryId);
      const postedIds = new Set(postedRows.map((row) => row.id));
      setRows((prev) => prev.filter((row) => !postedIds.has(row.id)));
      setInventoryByRowId((prev) => {
        const next = { ...prev };
        for (const row of postedRows) delete next[row.id];
        return next;
      });
      setFixedAssetByRowId((prev) => {
        const next = { ...prev };
        for (const row of postedRows) delete next[row.id];
        return next;
      });
      setSuccess(
        rowId
          ? tr("该笔流水已过账。", "The selected transaction has been posted.")
          : tr(`已过账 ${postedRows.length} 笔流水。`, `Posted ${postedRows.length} bank transactions.`),
      );
      if (rows.length === postedRows.length) {
        setImportedFileName("");
        setImportedFileType("");
      }
    } catch (e: any) {
      if (postedRows.length) {
        const postedIds = new Set(postedRows.map((row) => row.id));
        setLastPostedEntryId(latestEntryId);
        setRows((prev) => prev.filter((row) => !postedIds.has(row.id)));
        setInventoryByRowId((prev) => {
          const next = { ...prev };
          for (const row of postedRows) delete next[row.id];
          return next;
        });
        setFixedAssetByRowId((prev) => {
          const next = { ...prev };
          for (const row of postedRows) delete next[row.id];
          return next;
        });
        setSuccess(tr(`已先过账 ${postedRows.length} 笔流水。`, `Posted ${postedRows.length} bank transactions before the error.`));
      }
      setErr(e.message);
    } finally {
      setPosting(false);
      setPostingRowId(null);
    }
  }

  return (
    <AppShell title={tr("银行对账", "Bank Reconciliation")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold">{tr("导入银行单并过账", "Import Statement And Post")}</div>
          <div className="mt-1 text-sm text-zinc-500">
            {tr("先选银行账号，再上传 Excel 银行单，系统会自动识别日期、摘要、借贷方和金额。", "Select a bank account, upload the Excel statement, then map each transaction to an account before posting.")}
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
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={importing || posting || !selectedBankAccountId}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void importFile(file);
                    }}
                  />
                  <div className="mt-1 text-xs text-zinc-500">{tr("目前只支持 .xlsx。", "Currently supports .xlsx only.")}</div>
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
          {success ? (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 md:flex-row md:items-center md:justify-between">
              <div>{success}</div>
              {lastPostedEntryId ? (
                <button
                  className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm text-emerald-800 hover:bg-emerald-100"
                  onClick={() => navigate(`/journal?entryId=${encodeURIComponent(lastPostedEntryId)}`)}
                  type="button"
                >
                  {tr("查看凭证列表", "Open Voucher List")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold">{tr("导入结果", "Imported Transactions")}</div>
              <div className="mt-1 text-sm text-zinc-500">
                {importedFileName
                  ? tr(`文件：${importedFileName}${importedFileType ? `（${importedFileType.toUpperCase()}）` : ""}`, `File: ${importedFileName}${importedFileType ? ` (${importedFileType.toUpperCase()})` : ""}`)
                  : tr("上传 Excel 后会在这里显示流水表格。", "Imported statement rows will appear here after upload.")}
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
                  <div className="text-xs text-zinc-500">{tr("付款", "Payments")}</div>
                  <div className="mt-1 text-sm font-medium text-red-600">
                    {debitTotal.toFixed(2)} {active?.baseCurrency || ""}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                  <div className="text-xs text-zinc-500">{tr("收款", "Receipts")}</div>
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
                      <th className="px-3 py-2 text-left">{tr("操作", "Action")}</th>
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
                          {row.side === "debit" ? tr("付款", "Payment") : tr("收款", "Receipt")}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${row.side === "debit" ? "text-red-600" : ""}`}>{row.amount.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <select
                            className="w-full min-w-[240px] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                            value={row.accountId}
                            disabled={posting}
                            onChange={(e) => handleRowAccountChange(row.id, e.target.value)}
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
                          {row.accountId && isInventoryLinkedAccount(row.accountId) ? (
                            <div className="mt-1 text-xs text-amber-700">
                              {inventoryByRowId[row.id]
                                ? tr(
                                    `已设置库存明细：${inventoryByRowId[row.id].mode === "receipt" ? "入库" : "出库"}，${inventoryByRowId[row.id].details.length} 行。`,
                                    `Inventory details ready: ${inventoryByRowId[row.id].mode === "receipt" ? "receipt" : "shipment"}, ${inventoryByRowId[row.id].details.length} rows.`,
                                  )
                                : tr(
                                    "这是库存科目。请点右侧“库存”填写现有或新建 item 明细，再过账。",
                                    "This is an inventory-linked account. Click 'Inventory' to fill item details before posting.",
                                  )}
                            </div>
                          ) : null}
                          {row.accountId && isFixedAssetLinkedAccount(row.accountId) ? (
                            <div className="mt-1 text-xs text-indigo-700">
                              {fixedAssetByRowId[row.id]
                                ? tr(
                                    row.side === "debit"
                                      ? `已填写购买资料：${fixedAssetByRowId[row.id].name || "-"}`
                                      : `已选择处置资产：${fixedAssetByRowId[row.id].name || "-"}`,
                                    row.side === "debit"
                                      ? `Purchase info ready: ${fixedAssetByRowId[row.id].name || "-"}`
                                      : `Disposal asset ready: ${fixedAssetByRowId[row.id].name || "-"}`,
                                  )
                                : tr(
                                    row.side === "debit"
                                      ? "这是固定资产科目借方。请点右侧“购买”填写购置信息，再过账。"
                                      : "这是固定资产科目贷方。请点右侧“处置”选择现有资产，再过账。",
                                    row.side === "debit"
                                      ? "This debit fixed-asset row needs purchase details before posting."
                                      : "This credit fixed-asset row needs disposal asset selection before posting.",
                                  )}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                            {row.accountId && isInventoryLinkedAccount(row.accountId) ? (
                              <button
                                className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
                                  inventoryByRowId[row.id]
                                    ? "border border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
                                    : "border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                                }`}
                                disabled={posting || importing}
                                onClick={() => void openInventoryModalForRow(row).catch((e: any) => setErr(e.message))}
                                type="button"
                              >
                                {inventoryByRowId[row.id] ? tr("库存已设置", "Inventory Ready") : tr("库存", "Inventory")}
                              </button>
                            ) : null}
                            {row.accountId && isFixedAssetLinkedAccount(row.accountId) ? (
                              <button
                                className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${
                                  fixedAssetByRowId[row.id]
                                    ? "border border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
                                    : "border border-indigo-300 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                                }`}
                                disabled={posting || importing}
                                onClick={() => void openFixedAssetModalForRow(row).catch((e: any) => setErr(e.message))}
                                type="button"
                              >
                                {fixedAssetByRowId[row.id]
                                  ? row.side === "debit"
                                    ? tr("购买已设置", "Purchase Ready")
                                    : tr("处置已设置", "Disposal Ready")
                                  : row.side === "debit"
                                    ? tr("购买", "Purchase")
                                    : tr("处置", "Disposal")}
                              </button>
                            ) : null}
                            <button
                              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                              disabled={posting || importing || !row.accountId}
                              onClick={() => void submitPosting(row.id)}
                              type="button"
                            >
                              {posting && postingRowId === row.id ? tr("过账中...", "Posting...") : tr("单独过账", "Post Row")}
                            </button>
                          </div>
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

        {faModalOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
            onMouseDown={() => {
              if (posting) return;
              setFaModalOpen(false);
            }}
          >
            <div
              className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">
                  {faMode === "purchase" ? tr("固定资产购买", "Fixed Asset Purchase") : tr("固定资产处置", "Fixed Asset Disposal")}
                </div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={posting}
                  onClick={() => setFaModalOpen(false)}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              {(() => {
                const row = rows.find((item) => item.id === faEditingRowId) || null;
                return row ? (
                  <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                    <div>{tr(`银行流水金额：${row.amount.toFixed(2)} ${baseCurrency()}`, `Bank transaction amount: ${row.amount.toFixed(2)} ${baseCurrency()}`)}</div>
                    <div className="mt-1">
                      {faMode === "purchase"
                        ? tr(`银行账号会自动作为另一条分录，无需重复填写。`, `The bank account is posted as the offset line automatically.`)
                        : tr(`系统会自动带出处置资产原值、累计折旧和处置损益。`, `The system auto-fills cost, accumulated depreciation, and disposal gain/loss.`)}
                    </div>
                  </div>
                ) : null;
              })()}

              {faMode === "purchase" ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-xs text-zinc-600">{tr("大类", "Category")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                    value={faForm.category}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, category: e.target.value }))}
                    disabled={posting}
                  >
                    <option value="">{tr("请选择", "Select")}</option>
                    <option value="Machinery and Equipment">Machinery and Equipment</option>
                    <option value="Vehicles">Vehicles</option>
                    <option value="Computer">Computer</option>
                    <option value="Furniture and Fixtures">Furniture and Fixtures</option>
                    <option value="Renovation">Renovation</option>
                    <option value="Intangible Fixed Assets">Intangible Fixed Assets</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("固定资产编号", "Asset No")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.assetNo}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, assetNo: e.target.value.toUpperCase() }))}
                    placeholder={tr("留空则系统自动生成", "Leave empty to auto-generate")}
                    disabled={posting}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("名称", "Name")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.name}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, name: e.target.value }))}
                    disabled={posting}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("购置日", "Acquisition date")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.acquisitionDate}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, acquisitionDate: e.target.value }))}
                    disabled={posting}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("折旧月数", "Useful life (months)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.usefulLifeMonths}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, usefulLifeMonths: Number(e.target.value) || 0 }))}
                    type="number"
                    disabled={posting}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("残值（本位）", "Salvage (base)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.salvageBase}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, salvageBase: Number(e.target.value) || 0 }))}
                    type="number"
                    step="0.01"
                    disabled={posting}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">{tr("备注", "Memo")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faForm.memo}
                    onChange={(e) => setFaForm((prev) => ({ ...prev, memo: e.target.value }))}
                    disabled={posting}
                  />
                </div>
                </div>
              ) : (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-600">{tr("处置资产", "Asset")}</label>
                    <select
                      className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                      value={faDisposalForm.assetId}
                      disabled={posting}
                      onChange={async (e) => {
                        const assetId = e.target.value;
                        const asset = fixedAssets.find((item) => item.id === assetId) || null;
                        setFaDisposalForm((prev) => ({
                          ...prev,
                          assetId,
                          assetNo: asset?.assetNo || "",
                          name: asset?.name || "",
                        }));
                        if (!assetId) return;
                        const snap = await api<{ costBase: number; accumDepBase: number }>(
                          `/api/fixed-assets/${encodeURIComponent(assetId)}/disposal-snapshot?date=${encodeURIComponent(rows.find((item) => item.id === faEditingRowId)?.date || new Date().toISOString().slice(0, 10))}`,
                        );
                        const costTxn = Math.round(Number(snap.costBase || 0) * 100) / 100;
                        const accumDepTxn = Math.round(Number(snap.accumDepBase || 0) * 100) / 100;
                        const proceeds = rows.find((item) => item.id === faEditingRowId)?.amount || 0;
                        setFaDisposalForm((prev) => ({
                          ...prev,
                          assetId,
                          assetNo: asset?.assetNo || "",
                          name: asset?.name || "",
                          costTxn,
                          accumDepTxn,
                          gainLossTxn: Math.round((proceeds + accumDepTxn - costTxn) * 100) / 100,
                        }));
                      }}
                    >
                      <option value="">{tr("请选择", "Select")}</option>
                      {fixedAssets
                        .filter((item) => item.status === "active")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {(item.assetNo ? `${item.assetNo} · ` : "") + item.name + (item.category ? ` (${item.category})` : "")}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-600">{tr("固定资产编号", "Asset No")}</label>
                    <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={faDisposalForm.assetNo} disabled />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-600">{tr("名称", "Name")}</label>
                    <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={faDisposalForm.name} disabled />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-600">{tr("原值", "Cost")}</label>
                    <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={faDisposalForm.costTxn} disabled />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-600">{tr("累计折旧", "Accumulated depreciation")}</label>
                    <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={faDisposalForm.accumDepTxn} disabled />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs text-zinc-600">{tr("处置损益", "Disposal gain/loss")}</label>
                    <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={faDisposalForm.gainLossTxn} disabled />
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={posting}
                  onClick={() => setFaModalOpen(false)}
                  type="button"
                >
                  {tr("取消", "Cancel")}
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={
                    posting ||
                    !faEditingRowId ||
                    (faMode === "purchase"
                      ? !faForm.category.trim() || !faForm.name.trim() || !faForm.acquisitionDate.trim() || !(Number(faForm.usefulLifeMonths) > 0)
                      : !faDisposalForm.assetId || !(faDisposalForm.costTxn > 0))
                  }
                  onClick={() => {
                    if (!faEditingRowId) return;
                    setFixedAssetByRowId((prev) => ({
                      ...prev,
                      [faEditingRowId]:
                        faMode === "purchase"
                          ? {
                              mode: "purchase",
                              category: faForm.category.trim(),
                              assetNo: faForm.assetNo.trim().toUpperCase(),
                              name: faForm.name.trim(),
                              memo: faForm.memo.trim(),
                              acquisitionDate: faForm.acquisitionDate,
                              usefulLifeMonths: Number(faForm.usefulLifeMonths) || 0,
                              salvageBase: Number(faForm.salvageBase) || 0,
                            }
                          : {
                              mode: "disposal",
                              assetId: faDisposalForm.assetId,
                              assetNo: faDisposalForm.assetNo,
                              name: faDisposalForm.name,
                              costTxn: Number(faDisposalForm.costTxn) || 0,
                              accumDepTxn: Number(faDisposalForm.accumDepTxn) || 0,
                              gainLossTxn: Number(faDisposalForm.gainLossTxn) || 0,
                            },
                    }));
                    setFaModalOpen(false);
                  }}
                  type="button"
                >
                  {tr("保存", "Save")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {invModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-4xl rounded-xl bg-white p-4 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-semibold">{tr("库存明细", "Inventory Details")}</div>
                  <button
                    className={
                      "rounded-full px-3 py-1 text-sm " +
                      (invMode === "receipt" ? "bg-blue-700 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")
                    }
                    type="button"
                    onClick={() => {
                      setInvMode("receipt");
                      setInvQuoteByRow({});
                    }}
                  >
                    {tr("入库", "Receipt")}
                  </button>
                  <button
                    className={
                      "rounded-full px-3 py-1 text-sm " +
                      (invMode === "shipment" ? "bg-blue-700 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")
                    }
                    type="button"
                    onClick={() => {
                      setInvMode("shipment");
                      setInvQuoteByRow({});
                    }}
                  >
                    {tr("出库", "Shipment")}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xs text-zinc-500">
                    {tr(`绑定金额：${invExpectedTxn.toFixed(2)} ${baseCurrency()}`, `Bound amount: ${invExpectedTxn.toFixed(2)} ${baseCurrency()}`)}
                  </div>
                  {invMode === "receipt" ? (
                    <button
                      className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                      type="button"
                      onClick={() => {
                        setInvNewItemErr(null);
                        setInvNewItemTargetRowId(invEditingDetails[0]?.rowId || null);
                        setInvNewItemForm({ sku: "", name: "", uom: "EA" });
                        setInvNewItemOpen(true);
                      }}
                    >
                      {tr("新增 item", "New Item")}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-600">
                    <tr>
                      <th className="w-80 px-3 py-2 text-left">{tr("商品", "Item")}</th>
                      <th className="w-28 px-3 py-2 text-right">{tr("数量", "Qty")}</th>
                      {invMode === "receipt" ? (
                        <th className="px-3 py-2 text-right">{tr(`单价(${baseCurrency()})`, `Unit Cost (${baseCurrency()})`)}</th>
                      ) : (
                        <th className="px-3 py-2 text-right">{tr(`FIFO 成本(${baseCurrency()})`, `FIFO Cost (${baseCurrency()})`)}</th>
                      )}
                      <th className="w-36 px-3 py-2 text-right">{tr("金额", "Amount")}</th>
                      <th className="w-28 px-3 py-2 text-left">{tr("操作", "Action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invEditingDetails.map((item) => {
                      const quote = invQuoteByRow[item.rowId];
                      const qty = Number(item.qty) || 0;
                      const unit = Number(item.unitCostTxn) || 0;
                      const amountTxn = Math.round(qty * unit * 100) / 100;
                      const costBase = quote?.base == null ? null : Number(quote.base);
                      return (
                        <tr key={item.rowId} className="border-t border-zinc-100">
                          <td className="px-3 py-2">
                            <div className="flex gap-2">
                              <select
                                className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                                value={item.itemId}
                                onChange={(e) =>
                                  setInvEditingDetails((prev) =>
                                    prev.map((rowItem) => (rowItem.rowId === item.rowId ? { ...rowItem, itemId: e.target.value } : rowItem)),
                                  )
                                }
                              >
                                <option value="">{tr("请选择", "Select")}</option>
                                {inventoryItemsSorted.map((it) => (
                                  <option key={it.id} value={it.id}>
                                    {((it.sku ? `${it.sku} ` : "") + it.name).replace(/\s+/g, " ").trim()}
                                  </option>
                                ))}
                              </select>
                              {invMode === "receipt" ? (
                                <button
                                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                                  type="button"
                                  onClick={() => {
                                    setInvNewItemErr(null);
                                    setInvNewItemTargetRowId(item.rowId);
                                    setInvNewItemForm({ sku: "", name: "", uom: "EA" });
                                    setInvNewItemOpen(true);
                                  }}
                                >
                                  {tr("新建", "New")}
                                </button>
                              ) : null}
                            </div>
                            {(() => {
                              const invItem = inventoryItemById.get(item.itemId);
                              if (!invItem) return null;
                              return (
                                <div className="mt-1 text-xs text-zinc-500">
                                  {(invItem.sku ? `SKU: ${invItem.sku}` : "SKU: -") + ` · ${invItem.name || "-"}`}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              className="w-full rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                              type="number"
                              step="1"
                              value={item.qty}
                              onChange={(e) =>
                                setInvEditingDetails((prev) =>
                                  prev.map((rowItem) => (rowItem.rowId === item.rowId ? { ...rowItem, qty: e.target.value } : rowItem)),
                                )
                              }
                            />
                          </td>
                          {invMode === "receipt" ? (
                            <td className="px-3 py-2 text-right">
                              <input
                                className="w-full rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                                type="number"
                                step="0.01"
                                value={item.unitCostTxn}
                                onChange={(e) =>
                                  setInvEditingDetails((prev) =>
                                    prev.map((rowItem) => (rowItem.rowId === item.rowId ? { ...rowItem, unitCostTxn: e.target.value } : rowItem)),
                                  )
                                }
                              />
                            </td>
                          ) : (
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {quote?.err ? <span className="text-red-700">{quote.err}</span> : costBase == null ? "-" : `${costBase.toFixed(2)} ${baseCurrency()}`}
                            </td>
                          )}
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {invMode === "receipt" ? `${amountTxn.toFixed(2)} ${baseCurrency()}` : costBase == null ? "-" : `${(Math.round(costBase * 100) / 100).toFixed(2)} ${baseCurrency()}`}
                          </td>
                          <td className="px-3 py-2">
                            <button
                              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                              disabled={invEditingDetails.length <= 1}
                              onClick={() => {
                                setInvEditingDetails((prev) => prev.filter((rowItem) => rowItem.rowId !== item.rowId));
                                setInvQuoteByRow((prev) => {
                                  const next = { ...prev };
                                  delete next[item.rowId];
                                  return next;
                                });
                              }}
                              type="button"
                            >
                              {tr("删除", "Delete")}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {invMode === "receipt" ? (
                <div className="mt-3 text-sm">
                  <div>{tr(`明细合计：${invEditingTotals.totalTxn.toFixed(2)} ${baseCurrency()}；银行流水金额：${invExpectedTxn.toFixed(2)} ${baseCurrency()}`, `Detail total: ${invEditingTotals.totalTxn.toFixed(2)} ${baseCurrency()}; bank amount: ${invExpectedTxn.toFixed(2)} ${baseCurrency()}`)}</div>
                  {Math.round(invEditingTotals.totalTxn * 100) / 100 !== Math.round(invExpectedTxn * 100) / 100 ? (
                    <div className="mt-1 text-sm text-red-700">{tr("明细合计必须与该笔银行流水金额一致。", "Detail total must match the bank transaction amount.")}</div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 text-sm">
                  {invEditingDetails.some((item) => invQuoteByRow[item.rowId]?.err) ? (
                    <div className="text-red-700">{tr("存在库存不足或数据错误，请调整商品/数量。", "There is not enough stock or a data issue. Please adjust the item/qty.")}</div>
                  ) : invEditingDetails.some((item) => item.itemId && (Number(item.qty) || 0) > 0 && invQuoteByRow[item.rowId]?.base == null) ? (
                    <div className="text-zinc-500">{tr("正在计算 FIFO 成本...", "Calculating FIFO cost...")}</div>
                  ) : null}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() =>
                    setInvEditingDetails((prev) => [
                      ...prev,
                      { rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: "1", unitCostTxn: invMode === "receipt" ? "1" : "" },
                    ])
                  }
                  type="button"
                >
                  {tr("增加行", "Add Row")}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                    onClick={() => setInvModalOpen(false)}
                    disabled={posting}
                    type="button"
                  >
                    {tr("取消", "Cancel")}
                  </button>
                  <button
                    className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                    disabled={
                      posting ||
                      !invEditingRowId ||
                      invEditingDetails.some(
                        (item) => !item.itemId || (Number(item.qty) || 0) <= 0 || (invMode === "receipt" && (Number(item.unitCostTxn) || 0) <= 0),
                      ) ||
                      (invMode === "receipt"
                        ? Math.round(invEditingTotals.totalTxn * 100) / 100 !== Math.round(invExpectedTxn * 100) / 100
                        : invEditingDetails.some((item) => invQuoteByRow[item.rowId]?.base == null || invQuoteByRow[item.rowId]?.err))
                    }
                    onClick={() => {
                      if (!invEditingRowId) return;
                      setInventoryByRowId((prev) => ({
                        ...prev,
                        [invEditingRowId]: {
                          mode: invMode,
                          defaultSide: invDefaultSide,
                          expectedTxn: invExpectedTxn,
                          expectedBase: invExpectedBase,
                          quoteBase: invMode === "shipment" ? invEditingTotals.totalQuoteBase : 0,
                          details: invEditingDetails,
                        },
                      }));
                      setInvModalOpen(false);
                    }}
                    type="button"
                  >
                    {tr("确认", "Confirm")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {invNewItemOpen ? (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
            onMouseDown={() => {
              if (invNewItemBusy) return;
              setInvNewItemOpen(false);
            }}
          >
            <div
              className="w-full max-w-xl rounded-xl bg-white shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="border-b border-zinc-200 p-4">
                <div className="text-sm font-semibold">{tr("新增库存 item", "New Inventory Item")}</div>
              </div>
              <div className="grid gap-3 p-4 md:grid-cols-2">
                <div>
                  <label className="text-xs text-zinc-600">SKU</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={invNewItemForm.sku}
                    onChange={(e) => setInvNewItemForm((prev) => ({ ...prev, sku: e.target.value }))}
                    disabled={invNewItemBusy}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("单位", "UOM")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={invNewItemForm.uom}
                    onChange={(e) => setInvNewItemForm((prev) => ({ ...prev, uom: e.target.value.toUpperCase() || "EA" }))}
                    disabled={invNewItemBusy}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">{tr("名称", "Name")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={invNewItemForm.name}
                    onChange={(e) => setInvNewItemForm((prev) => ({ ...prev, name: e.target.value }))}
                    disabled={invNewItemBusy}
                  />
                </div>
                {invNewItemErr ? <div className="md:col-span-2 text-sm text-red-700">{invNewItemErr}</div> : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-zinc-200 p-4">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={invNewItemBusy}
                  onClick={() => setInvNewItemOpen(false)}
                  type="button"
                >
                  {tr("取消", "Cancel")}
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={invNewItemBusy || !invNewItemForm.sku.trim() || !invNewItemForm.name.trim()}
                  onClick={async () => {
                    setInvNewItemBusy(true);
                    setInvNewItemErr(null);
                    try {
                      const resp = await api<{ item: any }>("/api/inventory/items", {
                        method: "POST",
                        json: { sku: invNewItemForm.sku.trim(), name: invNewItemForm.name.trim(), uom: invNewItemForm.uom.trim() || "EA" },
                      });
                      const newId = resp.item?.id ? String(resp.item.id) : "";
                      const itemsResp = await api<{ items: any[] }>("/api/inventory/items");
                      setInventoryItems((itemsResp.items || []).map((item: any) => ({ id: item.id, sku: item.sku ?? null, name: item.name, uom: item.uom })));
                      if (invNewItemTargetRowId && newId) {
                        setInvEditingDetails((prev) =>
                          prev.map((item) => (item.rowId === invNewItemTargetRowId ? { ...item, itemId: newId } : item)),
                        );
                      }
                      setInvNewItemOpen(false);
                    } catch (e: any) {
                      setInvNewItemErr(e.message);
                    } finally {
                      setInvNewItemBusy(false);
                    }
                  }}
                  type="button"
                >
                  {tr("保存", "Save")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
