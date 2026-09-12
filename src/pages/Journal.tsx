import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type Account = { id: string; code: string; name: string; linkInventoryFifo?: boolean; linkFixedAssets?: boolean };
type CostCenter = { id: string; code: string; name: string };
type Currency = { id: string; code: string; isEnabled: boolean };
type InventoryItem = { id: string; sku: string | null; name: string; uom: string };

type EntryListRow = {
  id: string;
  entryDate: string;
  status: string;
  voucherNo?: string | null;
  isSystem?: boolean;
  parentEntryId?: string | null;
  currency: string;
  fxRate: number;
  memo: string | null;
  totalDebitTxn: string;
  totalDebitBase: string;
  inventoryImpact?: boolean;
};

type EntryDetail = {
  entry: { id: string; entryDate: string; status: string; voucherNo?: string | null; currency: string; fxRate: number; memo: string | null };
  lines: Array<{
    id: string;
    lineNo: number;
    accountId: string;
    description: string | null;
    costCenterId: string | null;
    debitTxn: string;
    creditTxn: string;
    debitBase: string;
    creditBase: string;
  }>;
  attachments: Array<{ id: string; fileName: string; mimeType: string | null; sizeBytes: number | null; createdAt: string }>;
};

type AssistJournalSuggestion = {
  draft:
    | {
        entryDate: string;
        currency: string;
        fxRate: number;
        memo: string;
        lines: Array<{ accountId: string; description?: string; costCenterId: string | null; debitTxn: number; creditTxn: number }>;
        inventoryLinkLineNo?: number;
        inventoryDetails?: Array<
          | { moveType: "receipt"; itemId: string; qty: number; unitCostTxn: number }
          | { moveType: "shipment"; itemId: string; qty: number }
        >;
      }
    | null;
  preview:
    | {
        entryDate: string;
        currency: string;
        fxRate: number;
        memo: string;
        lines: Array<{ accountCode: string; accountName: string; description?: string; debitTxn: number; creditTxn: number }>;
        inventoryLinkLineNo?: number;
        inventoryDetails?: Array<
          | { moveType: "receipt"; itemId: string; qty: number; unitCostTxn: number }
          | { moveType: "shipment"; itemId: string; qty: number }
        >;
      }
    | null;
  warnings: string[];
  missing: string[];
};

type AssistManualJson = {
  entryDate?: string;
  currency?: string;
  fxRate?: number;
  memo?: string;
  lines: Array<{
    accountCode: string;
    description?: string;
    costCenterCode?: string;
    debitTxn: number;
    creditTxn: number;
  }>;
  inventory?: {
    linkLineNo?: number;
    details?: Array<
      | { moveType: "receipt"; itemKey: string; qty: number; unitCostTxn: number }
      | { moveType: "shipment"; itemKey: string; qty: number }
    >;
  };
};

export default function Journal() {
  const navigate = useNavigate();
  const { orgs, activeOrgId, orgSwitching } = useAuthStore();
  const tr = useTr();
  const [searchParams, setSearchParams] = useSearchParams();
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [entries, setEntries] = useState<EntryListRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [assistOpen, setAssistOpen] = useState(false);
  const [assistMode, setAssistMode] = useState<"manual" | "auto">("manual");
  const [assistText, setAssistText] = useState("");
  const [assistManualJson, setAssistManualJson] = useState("");
  const [assistExtra, setAssistExtra] = useState("");
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistErr, setAssistErr] = useState<string | null>(null);
  const [assistSuggestion, setAssistSuggestion] = useState<AssistJournalSuggestion | null>(null);
  const [assistQuickWho, setAssistQuickWho] = useState("");
  const [assistQuickOnBehalf, setAssistQuickOnBehalf] = useState("");
  const [assistQuickPayMethod, setAssistQuickPayMethod] = useState("");
  const [assistQuickAction, setAssistQuickAction] = useState("");
  const [assistQuickExistingFixedAssetId, setAssistQuickExistingFixedAssetId] = useState("");
  const [assistQuickExistingInventoryItemId, setAssistQuickExistingInventoryItemId] = useState("");
  const [assistQuickCurrency, setAssistQuickCurrency] = useState("");
  const [assistQuickAmount, setAssistQuickAmount] = useState("");
  const [assistQuickPurpose, setAssistQuickPurpose] = useState("");
  const [assistChatMessages, setAssistChatMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);

  const [assistEditEntryDate, setAssistEditEntryDate] = useState("");
  const [assistEditCurrency, setAssistEditCurrency] = useState("");
  const [assistEditFxRate, setAssistEditFxRate] = useState<number>(1);
  const [assistEditMemo, setAssistEditMemo] = useState("");
  const [assistEditLines, setAssistEditLines] = useState<Array<{ accountId: string; description: string; costCenterId: string; debitTxn: string; creditTxn: string }>>([]);
  const [assistEditInvMode, setAssistEditInvMode] = useState<"receipt" | "shipment">("receipt");
  const [assistEditInvLinkLineNo, setAssistEditInvLinkLineNo] = useState<number>(1);
  const [assistEditInvDetails, setAssistEditInvDetails] = useState<Array<{ rowId: string; itemId: string; qty: string; unitCostTxn: string }>>([]);
  const [assistEditFaPurchase, setAssistEditFaPurchase] = useState<null | {
    lineIdx: number;
    category: string;
    assetNo: string;
    name: string;
    acquisitionDate: string;
    usefulLifeMonths: string;
    salvageBase: string;
  }>(null);

  const [draftDate, setDraftDate] = useState(() => new Date().toISOString().slice(0, 10));
  const baseCurrency = useMemo(() => {
    const active = orgs.find((o) => o.orgId === activeOrgId);
    return (active?.baseCurrency || "SGD").toUpperCase();
  }, [orgs, activeOrgId]);

  const enabledCurrencies = useMemo(() => {
    const list = currencies.filter((c) => c.isEnabled).map((c) => c.code.toUpperCase());
    const uniq = Array.from(new Set([baseCurrency, ...list]));
    return uniq.sort();
  }, [currencies, baseCurrency]);

  const invItemLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of inventoryItems) {
      const sku = it.sku ? String(it.sku) : "";
      const label = `${sku ? sku + " " : ""}${it.name}`.trim();
      m.set(String(it.id), label);
    }
    return m;
  }, [inventoryItems]);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);
  const activeAccounts = useMemo(() => accounts.filter((a) => (a as any).isActive ?? true), [accounts]);

  const [draftCurrency, setDraftCurrency] = useState("SGD");
  const [draftFx, setDraftFx] = useState(1);
  const [draftMemo, setDraftMemo] = useState("");
  const [draftVoucherNo, setDraftVoucherNo] = useState("");
  const [voucherTouched, setVoucherTouched] = useState(false);

  const [invModalOpen, setInvModalOpen] = useState(false);
  const [invMode, setInvMode] = useState<"receipt" | "shipment">("receipt");
  const [invExpectedTxn, setInvExpectedTxn] = useState<number>(0);
  const [invExpectedBase, setInvExpectedBase] = useState<number>(0);
  const [invDetails, setInvDetails] = useState<Array<{ rowId: string; itemId: string; qty: string; unitCostTxn: string }>>([]);
  const [invConfirmed, setInvConfirmed] = useState<
    null | {
      mode: "receipt" | "shipment";
      expectedTxn: number;
      expectedBase: number;
      quoteBase: number;
    }
  >(null);
  const [invLineIdx, setInvLineIdx] = useState<number | null>(null);
  const [invDefaultSide, setInvDefaultSide] = useState<"debit" | "credit">("debit");

  const [invEditingDetails, setInvEditingDetails] = useState<Array<{ rowId: string; itemId: string; qty: string; unitCostTxn: string }>>([]);
  const [invQuoteByRow, setInvQuoteByRow] = useState<Record<string, { base: number | null; err: string | null }>>({});
  const [draftLines, setDraftLines] = useState(() => [
    { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" },
    { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" },
  ]);

  const [fixedAssetIdByLineIdx, setFixedAssetIdByLineIdx] = useState<Record<number, string>>({});
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [postDraftId, setPostDraftId] = useState<string | null>(null);

  const [recurringEnabled, setRecurringEnabled] = useState(false);
  const [recurringStartDate, setRecurringStartDate] = useState("");
  const [recurringEveryMonths, setRecurringEveryMonths] = useState(1);
  const [recurringCount, setRecurringCount] = useState(1);

  const [faPurchaseOpen, setFaPurchaseOpen] = useState(false);
  const [faPurchaseForm, setFaPurchaseForm] = useState({
    category: "",
    assetNo: "",
    name: "",
    acquisitionDate: new Date().toISOString().slice(0, 10),
    costTxn: 0,
    currency: "",
    fxRate: 1,
    usefulLifeMonths: 36,
    salvageBase: 0,
    offsetAccountId: "",
    memo: "",
  });
  const [faPurchaseByLineIdx, setFaPurchaseByLineIdx] = useState<
    Record<
      number,
      {
        category: string;
        assetNo: string;
        name: string;
        acquisitionDate: string;
        usefulLifeMonths: number;
        salvageBase: number;
        memo: string;
      }
    >
  >({});
  const [faPurchaseLineIdx, setFaPurchaseLineIdx] = useState<number | null>(null);

  const [faDepOpen, setFaDepOpen] = useState(false);
  const [faDepLineIdx, setFaDepLineIdx] = useState<number | null>(null);
  const [faDepForm, setFaDepForm] = useState({ assetId: "", amountTxn: 0 });
  const [faDisposeOpen, setFaDisposeOpen] = useState(false);
  const [faDisposeKind, setFaDisposeKind] = useState<"cost" | "accumDep">("cost");
  const [faDisposeLineIdx, setFaDisposeLineIdx] = useState<number | null>(null);
  const [faDisposeForm, setFaDisposeForm] = useState({ assetId: "", amountTxn: 0 });
  const [faDisposeCostLineIdx, setFaDisposeCostLineIdx] = useState<number | null>(null);
  const [faDisposeAccumLineIdx, setFaDisposeAccumLineIdx] = useState<number | null>(null);
  const [fixedAssets, setFixedAssets] = useState<
    Array<{
      id: string;
      assetNo: string | null;
      category: string | null;
      name: string;
      status: string;
      costBase: number;
      depExpenseAccountId: string | null;
      accumDepAccountId: string | null;
      assetAccountId: string | null;
    }>
  >([]);

  useEffect(() => {
    setFaPurchaseByLineIdx((prev) => {
      const entries = Object.entries(prev).filter(([k]) => Number(k) >= 0 && Number(k) < draftLines.length);
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries.map(([k, v]) => [Number(k), v]));
    });
    setFixedAssetIdByLineIdx((prev) => {
      const entries = Object.entries(prev).filter(([k]) => Number(k) >= 0 && Number(k) < draftLines.length);
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries.map(([k, v]) => [Number(k), v]));
    });
  }, [draftLines.length]);

  const txnDiff = useMemo(() => {
    const debit = draftLines.reduce((s, l) => s + (Number(l.debitTxn) || 0), 0);
    const credit = draftLines.reduce((s, l) => s + (Number(l.creditTxn) || 0), 0);
    return Math.round((debit - credit) * 100) / 100;
  }, [draftLines]);

  function resetDraftEntry() {
    setDraftLines([
      { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" },
      { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" },
    ]);
    setFixedAssetIdByLineIdx({});
    setDraftMemo("");
    setDraftVoucherNo("");
    setVoucherTouched(false);
    setEditingEntryId(null);
    setPostDraftId(null);
    setInvDetails([]);
    setInvConfirmed(null);
    setInvLineIdx(null);
    setInvDefaultSide("debit");
    setInvEditingDetails([]);
    setInvQuoteByRow({});
    setInvModalOpen(false);
    setEditModalOpen(false);
    setFaPurchaseOpen(false);
    setFaPurchaseByLineIdx({});
    setFaPurchaseLineIdx(null);
    setFaDepOpen(false);
    setFaDepLineIdx(null);
    setFaDisposeOpen(false);
    setFaDisposeLineIdx(null);
    setFaDisposeCostLineIdx(null);
    setFaDisposeAccumLineIdx(null);
    setRecurringEnabled(false);
    setRecurringEveryMonths(1);
    setRecurringCount(1);
    setAssistQuickExistingFixedAssetId("");
    setAssistQuickExistingInventoryItemId("");
    void refreshNextVoucherNo(true);
  }

  async function refreshFixedAssets() {
    const r = await api<{ assets: any[] }>("/api/fixed-assets");
    setFixedAssets(
      (r.assets || []).map((a: any) => ({
        id: String(a.id),
        assetNo: a.assetNo ? String(a.assetNo) : null,
        category: a.category ? String(a.category) : null,
        name: String(a.name || ""),
        status: String(a.status || ""),
        costBase: Number(a.costBase || 0),
        depExpenseAccountId: a.depExpenseAccountId ? String(a.depExpenseAccountId) : null,
        accumDepAccountId: a.accumDepAccountId ? String(a.accumDepAccountId) : null,
        assetAccountId: a.assetAccountId ? String(a.assetAccountId) : null,
      })),
    );
  }

  function openFixedAssetDepreciateModal(lineIdx: number, amountTxn: number) {
    setFaDepLineIdx(lineIdx);
    const existingId = fixedAssetIdByLineIdx[lineIdx] || "";
    setFaDepForm({ assetId: existingId, amountTxn: Number.isFinite(amountTxn) && amountTxn > 0 ? amountTxn : 0 });
    if (!fixedAssets.length) {
      refreshFixedAssets().catch((e) => setErr(e.message));
    }
    setFaDepOpen(true);
  }

  async function openFixedAssetDisposeModal(kind: "cost" | "accumDep", lineIdx: number, amountTxn: number) {
    setFaDisposeKind(kind);
    setFaDisposeLineIdx(lineIdx);
    const existingId = fixedAssetIdByLineIdx[lineIdx] || "";
    setFaDisposeForm({ assetId: existingId, amountTxn: Number.isFinite(amountTxn) && amountTxn > 0 ? amountTxn : 0 });
    if (!fixedAssets.length) {
      refreshFixedAssets().catch((e) => setErr(e.message));
    }
    setFaDisposeOpen(true);

    const targetAssetId = existingId;
    if (!targetAssetId) return;
    try {
      const snap = await api<{ costBase: number; accumDepBase: number }>(
        `/api/fixed-assets/${encodeURIComponent(targetAssetId)}/disposal-snapshot?date=${encodeURIComponent(draftDate)}`,
      );
      const base = kind === "cost" ? Number(snap.costBase || 0) : Number(snap.accumDepBase || 0);
      const txn = (Number(draftFx) || 1) > 0 ? Math.round((base / (Number(draftFx) || 1)) * 100) / 100 : Math.round(base * 100) / 100;
      setFaDisposeForm((prev) => ({ ...prev, amountTxn: txn }));
    } catch {
      // ignore
    }
  }

  async function refreshNextVoucherNo(force?: boolean): Promise<string> {
    const r = await api<{ voucherNo: string }>("/api/journals/voucher/next");
    if (force) {
      setVoucherTouched(false);
      setDraftVoucherNo(r.voucherNo);
      return r.voucherNo;
    }
    setDraftVoucherNo((prev) => (voucherTouched ? prev : prev || r.voucherNo));
    return r.voucherNo;
  }

  async function refresh() {
    const [{ accounts }, { costCenters }, { currencies }, { entries }, { items }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
      api<{ currencies: any[] }>("/api/settings/currencies"),
      api<{ entries: any[] }>("/api/journals"),
      api<{ items: any[] }>("/api/inventory/items"),
    ]);
    setAccounts(accounts as any);
    setCostCenters(costCenters as any);
    setCurrencies(currencies as any);
    setEntries(entries as any);
    setInventoryItems((items as any[]).map((it) => ({ id: it.id, sku: it.sku ?? null, name: it.name, uom: it.uom })));
    await refreshNextVoucherNo();
  }

  async function deleteEntry(id: string) {
    await api(`/api/journals/${id}` as any, { method: "DELETE" });
    if (selectedId === id) {
      setSelectedId(null);
    }
    await refresh();
  }

  async function startEditEntry(id: string) {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<EntryDetail>(`/api/journals/${id}`);
      const movesResp = await api<{ moves: any[] }>(`/api/inventory/moves?entryId=${encodeURIComponent(id)}&limit=200`);
      const moves = Array.isArray(movesResp.moves) ? movesResp.moves : [];

      const entryFx = Number(d.entry.fxRate) || 1;
      const entryCurrency = String(d.entry.currency || "").toUpperCase();

      setEditingEntryId(id);
      setDraftDate(d.entry.entryDate);
      setDraftCurrency(entryCurrency);
      setDraftFx(entryFx);
      setDraftMemo(d.entry.memo || "");
      setDraftVoucherNo(d.entry.voucherNo || "");
      setVoucherTouched(true);
      setFaPurchaseByLineIdx({});
      setFaPurchaseLineIdx(null);

      const nextLines = d.lines.map((l) => {
        const debit = Number(l.debitTxn) || 0;
        const credit = Number(l.creditTxn) || 0;
        return {
          accountId: l.accountId,
          description: l.description || "",
          costCenterId: l.costCenterId || "",
          debitTxn: debit > 0 ? debit.toFixed(2) : "",
          creditTxn: credit > 0 ? credit.toFixed(2) : "",
        };
      });
      setDraftLines(nextLines);

      const hasMoves = moves.length > 0;
      if (!hasMoves) {
        setInvDetails([]);
        setInvConfirmed(null);
        setInvLineIdx(null);
        return;
      }

      const moveType = String(moves[0].moveType || "");
      const mode = moveType === "receipt" ? "receipt" : "shipment";
      const entryLineNo = moves[0].entryLineNo ? Number(moves[0].entryLineNo) : NaN;
      const lineIdx = Number.isFinite(entryLineNo) && entryLineNo > 0 ? entryLineNo - 1 : null;

      let expectedTxn = 0;
      let defaultSide: "debit" | "credit" = "debit";
      if (lineIdx != null && nextLines[lineIdx]) {
        const line = nextLines[lineIdx];
        const debit = Number(line.debitTxn) || 0;
        const credit = Number(line.creditTxn) || 0;
        if (debit > 0) {
          expectedTxn = debit;
          defaultSide = "debit";
        } else if (credit > 0) {
          expectedTxn = credit;
          defaultSide = "credit";
        }
      }
      const expectedBase = Math.round(expectedTxn * entryFx * 100) / 100;

      setInvMode(mode);
      setInvLineIdx(lineIdx);
      setInvDefaultSide(defaultSide);
      setInvExpectedTxn(expectedTxn);
      setInvExpectedBase(expectedBase);

      if (mode === "receipt") {
        const det = moves
          .filter((m) => String(m.moveType) === "receipt")
          .map((m) => {
            const qty = Number(m.qty) || 0;
            const unit = m.unitCostTxn == null ? 0 : Number(m.unitCostTxn) || 0;
            return { rowId: newRowId(), itemId: String(m.itemId), qty: String(Math.trunc(qty)), unitCostTxn: unit > 0 ? String(unit) : "" };
          });
        setInvDetails(det);
        setInvConfirmed({ mode: "receipt", expectedTxn, expectedBase, quoteBase: 0 });
        return;
      }

      const byItem = new Map<string, number>();
      let quoteBase = 0;
      for (const m of moves.filter((x) => String(x.moveType) === "shipment")) {
        const itemId = String(m.itemId);
        const qty = Number(m.qty) || 0;
        const unitBase = m.unitCostBase == null ? 0 : Number(m.unitCostBase) || 0;
        byItem.set(itemId, (byItem.get(itemId) || 0) + qty);
        quoteBase += qty * unitBase;
      }
      const det = Array.from(byItem.entries()).map(([itemId, qty]) => ({ rowId: newRowId(), itemId, qty: String(Math.trunc(qty)), unitCostTxn: "" }));
      setInvDetails(det);
      setInvConfirmed({ mode: "shipment", expectedTxn, expectedBase, quoteBase: Math.round(quoteBase * 100) / 100 });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openEditModal(entryId: string) {
    if (editingEntryId && editingEntryId !== entryId) {
      setErr(tr("请先保存或取消当前编辑。", "Please save or cancel the current edit first."));
      return;
    }
    setErr(null);
    await startEditEntry(entryId);
    setSelectedId(entryId);
    setEditModalOpen(true);
  }

  async function loadDraftForPosting(entryId: string) {
    if (editingEntryId && editingEntryId !== entryId) {
      setErr(tr("请先保存或取消当前编辑。", "Please save or cancel the current edit first."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const d = await api<EntryDetail>(`/api/journals/${entryId}`);
      if (d.entry.status !== "draft") {
        throw new Error(tr("仅支持对草稿凭证使用“新建”", "Only draft journals are supported for this action."));
      }
      setPostDraftId(entryId);
      setEditingEntryId(null);
      setEditModalOpen(false);
      setDraftDate(d.entry.entryDate);
      setDraftCurrency(String(d.entry.currency || "").toUpperCase());
      setDraftFx(Number(d.entry.fxRate) || 1);
      setDraftMemo(d.entry.memo || "");
      setDraftVoucherNo(d.entry.voucherNo || "");
      setVoucherTouched(true);
      setDraftLines(
        d.lines.map((l) => {
          const debit = Number(l.debitTxn) || 0;
          const credit = Number(l.creditTxn) || 0;
          return {
            accountId: l.accountId,
            description: l.description || "",
            costCenterId: l.costCenterId || "",
            debitTxn: debit > 0 ? debit.toFixed(2) : "",
            creditTxn: credit > 0 ? credit.toFixed(2) : "",
          };
        }),
      );
      setInvDetails([]);
      setInvConfirmed(null);
      setInvLineIdx(null);
      setSelectedId(entryId);
      setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function openFixedAssetPurchaseModal(lineIdx: number, amountTxn: number) {
    const other = draftLines.find((l) => {
      if (!l.accountId) return false;
      const acc = accounts.find((a) => a.id === l.accountId);
      const code = acc?.code ? String(acc.code) : "";
      return !code.startsWith("16");
    });
    const existing = faPurchaseByLineIdx[lineIdx];
    setFaPurchaseLineIdx(lineIdx);
    setFaPurchaseForm({
      category: existing?.category || "",
      assetNo: existing?.assetNo || "",
      name: existing?.name || "",
      acquisitionDate: existing?.acquisitionDate || draftDate,
      costTxn: Number.isFinite(amountTxn) && amountTxn > 0 ? amountTxn : 0,
      currency: draftCurrency,
      fxRate: Number(draftFx) || 1,
      usefulLifeMonths: existing?.usefulLifeMonths || 36,
      salvageBase: existing?.salvageBase || 0,
      offsetAccountId: other?.accountId || "",
      memo: existing?.memo || draftMemo || "",
    });
    setFaPurchaseOpen(true);
  }

  function newRowId(): string {
    const c: any = (globalThis as any).crypto;
    return typeof c?.randomUUID === "function" ? c.randomUUID() : `${Date.now()}-${Math.random()}`;
  }

  function normalizeCode(input: unknown): string {
    const s = typeof input === "string" ? input.trim() : "";
    const m = s.match(/\d{3,6}/);
    return m ? m[0] : s;
  }

  function buildAssistPrompt(): string {
    const accountList = accounts.map((a) => `${a.code} ${a.name}`).join("\n");
    const costCenterList = costCenters.map((c) => `${c.code} ${c.name}`).join("\n");
    const itemList = inventoryItems.map((it) => `${it.sku ? it.sku + " " : ""}${it.name} [${it.uom}]`).join("\n");

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        entryDate: { type: "string" },
        currency: { type: "string" },
        fxRate: { type: "number" },
        memo: { type: "string" },
        lines: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              accountCode: { type: "string" },
              description: { type: "string" },
              costCenterCode: { type: "string" },
              debitTxn: { type: "number" },
              creditTxn: { type: "number" },
            },
            required: ["accountCode", "debitTxn", "creditTxn"],
          },
        },
        inventory: {
          type: "object",
          additionalProperties: false,
          properties: {
            linkLineNo: { type: "integer" },
            details: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  moveType: { type: "string", enum: ["receipt", "shipment"] },
                  itemKey: { type: "string" },
                  qty: { type: "number" },
                  unitCostTxn: { type: "number" },
                },
                required: ["moveType", "itemKey", "qty"],
              },
            },
          },
        },
      },
      required: ["currency", "fxRate", "memo", "lines"],
    } as const;

    const rules =
      tr(
        "你是会计分录助手。根据用户输入生成分录建议。\n" +
          "默认采用国际财务报告准则 IFRS/IAS（权责发生制、配比原则、实质重于形式、谨慎性）。\n" +
          "对固定资产（如车辆/设备）：若为企业用途且预计使用期超过一年，优先资本化计入固定资产并提示折旧；否则计入费用。\n" +
          "严格只输出 JSON，不要输出任何解释文字。\n" +
          "金额必须借贷平衡；debitTxn/creditTxn 为交易币金额；同一行不允许借贷同时为正。\n" +
          "只允许使用提供的科目代码与成本中心代码。\n" +
          "如需库存：inventory.details.itemKey 必须匹配提供的库存商品（优先 SKU，否则用商品名称）。\n" +
          `entryDate 如用户未给出，使用 ${draftDate}。currency 如未给出，使用 ${baseCurrency}。fxRate 同币种为 1。`,
        "You are an accounting journal assistant. Generate a journal suggestion based on the user input.\n" +
          "Default to IFRS/IAS (accrual basis, matching, substance over form, prudence).\n" +
          "For fixed assets (e.g., vehicles/equipment): if used for business and expected useful life > 1 year, capitalize as PPE and mention depreciation; otherwise expense it.\n" +
          "Output JSON only, without any extra text.\n" +
          "Debits and credits must balance. debitTxn/creditTxn are transaction-currency amounts; do not put positive debit and credit on the same line.\n" +
          "Use only the provided account codes and cost center codes.\n" +
          "If inventory is needed: inventory.details.itemKey must match an existing item (prefer SKU, otherwise item name).\n" +
          `If entryDate is not provided, use ${draftDate}. If currency is not provided, use ${baseCurrency}. fxRate is 1 when currency equals base currency.`,
      );

    return (
      rules +
      tr("\n\n用户输入：", "\n\nUser input: ") +
      assistText.trim() +
      tr("\n\n可用科目：\n", "\n\nAvailable accounts:\n") +
      accountList +
      tr("\n\n可用成本中心：\n", "\n\nAvailable cost centers:\n") +
      (costCenterList || tr("(无)", "(None)")) +
      tr("\n\n可用库存商品：\n", "\n\nAvailable inventory items:\n") +
      (itemList || tr("(无)", "(None)")) +
      tr("\n\n输出 JSON schema：\n", "\n\nOutput JSON schema:\n") +
      JSON.stringify(schema, null, 2)
    );
  }

  function suggestionFromManualJson(obj: AssistManualJson): AssistJournalSuggestion {
    const warnings: string[] = [];
    const missing: string[] = [];

    const currency = typeof obj.currency === "string" && obj.currency.trim() ? obj.currency.trim().toUpperCase().slice(0, 3) : baseCurrency;
    const fxRate = Number(obj.fxRate) || 1;
    const memo = typeof obj.memo === "string" ? obj.memo.trim() : "";
    const entryDate = typeof obj.entryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.entryDate) ? obj.entryDate : draftDate;

    if (!Array.isArray(obj.lines) || obj.lines.length < 2) {
      throw new Error(tr("JSON 缺少 lines（至少 2 行）", "JSON is missing lines (at least 2 lines)."));
    }

    const accountIdByCode = new Map(accounts.map((a) => [normalizeCode(a.code), a.id]));
    const accountNameByCode = new Map(accounts.map((a) => [normalizeCode(a.code), a.name]));
    const ccIdByCode = new Map(costCenters.map((c) => [String(c.code).trim(), c.id]));

    const itemIdByKey = new Map<string, string>();
    for (const it of inventoryItems) {
      if (it.sku) itemIdByKey.set(String(it.sku), String(it.id));
      itemIdByKey.set(String(it.name), String(it.id));
    }

    const draftLinesOut = obj.lines.map((l) => {
      const code = normalizeCode(l?.accountCode);
      const accountId = accountIdByCode.get(code) || "";
      if (!accountId) {
        missing.push(`缺少科目 ${code}`);
        warnings.push(`找不到科目代码 ${code}`);
      }
      const ccCode = typeof l?.costCenterCode === "string" && l.costCenterCode.trim() ? l.costCenterCode.trim() : "";
      const costCenterId = ccCode ? ccIdByCode.get(ccCode) || null : null;
      if (ccCode && !costCenterId) {
        warnings.push(`找不到成本中心代码 ${ccCode}`);
      }
      const debitTxn = Math.max(0, Number((l as any)?.debitTxn) || 0);
      const creditTxn = Math.max(0, Number((l as any)?.creditTxn) || 0);
      if (debitTxn > 0 && creditTxn > 0) {
        warnings.push(`科目 ${code} 同时有借贷，已保留原值`);
      }
      return {
        accountCode: code,
        accountId,
        accountName: accountNameByCode.get(code) || "",
        description: typeof (l as any)?.description === "string" && (l as any).description.trim() ? (l as any).description.trim() : undefined,
        costCenterId,
        debitTxn,
        creditTxn,
      };
    });

    if (draftLinesOut.some((l) => !l.accountId)) {
      throw new Error(tr("科目匹配失败：请使用系统里存在的科目代码", "Account mapping failed: please use existing account codes."));
    }

    const debit = draftLinesOut.reduce((s, l) => s + (Number(l.debitTxn) || 0), 0);
    const credit = draftLinesOut.reduce((s, l) => s + (Number(l.creditTxn) || 0), 0);
    const diff = Math.round((debit - credit) * 100) / 100;
    if (diff !== 0) {
      throw new Error(tr(`建议分录借贷不平衡：差额 ${diff.toFixed(2)}`, `Suggested journal is not balanced: diff ${diff.toFixed(2)}`));
    }

    let inventoryDetails: AssistJournalSuggestion["draft"]["inventoryDetails"] | undefined;
    let inventoryLinkLineNo: number | undefined;
    const inv = obj.inventory;
    const detailsIn: any[] = Array.isArray(inv?.details) ? (inv as any).details : [];
    if (detailsIn.length) {
      const det = detailsIn
        .map((d) => {
          const moveType = d?.moveType === "shipment" ? "shipment" : d?.moveType === "receipt" ? "receipt" : null;
          if (!moveType) return null;
          const qty = Number(d?.qty) || 0;
          if (qty <= 0) return null;
          const key = typeof d?.itemKey === "string" ? d.itemKey.trim() : "";
          const itemId = key ? itemIdByKey.get(key) || null : null;
          if (!itemId) {
            missing.push(`缺少库存商品 ${key || "(空)"}`);
            warnings.push(`找不到库存商品 ${key || "(空)"}`);
            return null;
          }
          if (moveType === "receipt") {
            const unitCostTxn = Number(d?.unitCostTxn) || 0;
            if (unitCostTxn <= 0) return null;
            return { moveType, itemId, qty, unitCostTxn };
          }
          return { moveType, itemId, qty };
        })
        .filter(Boolean) as any[];

      if (det.length) {
        inventoryDetails = det as any;
        const ll = Number((inv as any)?.linkLineNo);
        inventoryLinkLineNo = Number.isFinite(ll) && ll > 0 ? Math.trunc(ll) : 1;
      }
    }

    return {
      draft: {
        entryDate,
        currency,
        fxRate,
        memo,
        inventoryLinkLineNo,
        inventoryDetails,
        lines: draftLinesOut.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          costCenterId: l.costCenterId,
          debitTxn: l.debitTxn,
          creditTxn: l.creditTxn,
        })),
      },
      preview: {
        entryDate,
        currency,
        fxRate,
        memo,
        inventoryLinkLineNo,
        inventoryDetails,
        lines: draftLinesOut.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          description: l.description,
          debitTxn: l.debitTxn,
          creditTxn: l.creditTxn,
        })),
      },
      warnings,
      missing,
    };
  }

  async function runAssistSuggest(overrideText?: string) {
    const text = (overrideText ?? assistText).trim();
    if (!text) {
      setAssistErr(tr("请输入要生成分录的描述。", "Please enter a description."));
      return;
    }
    setAssistBusy(true);
    setAssistErr(null);
    setAssistSuggestion(null);
    try {
      const r = await api<{ suggestion: AssistJournalSuggestion }>("/api/assist/journal-suggest", {
        method: "POST",
        json: { text, memo: draftMemo || undefined, entryDate: draftDate || undefined },
        timeoutMs: 90_000,
      });
      setAssistSuggestion(r.suggestion);
    } catch (e: any) {
      setAssistErr(e.message);
    } finally {
      setAssistBusy(false);
    }
  }

  async function startAssistChat(initialText?: string) {
    const welcome = tr(
      "把交易用一句话描述给我。我会追问必要信息，直到分录可确认并填入草稿（不会自动过账）。",
      "Describe the transaction. I'll ask follow-ups until the journal is ready to confirm & fill (won't auto-post).",
    );

    setAssistMode("auto");
    setAssistErr(null);
    setAssistSuggestion(null);
    setAssistManualJson("");
    setAssistExtra("");
    setAssistChatMessages([{ role: "assistant", text: welcome }]);
    setAssistOpen(true);

    const t = (initialText ?? "").trim();
    if (!t) {
      return;
    }

    setAssistBusy(true);
    setAssistChatMessages((m) => [...m, { role: "user", text: t }]);
    try {
      const r = await api<{ suggestion: AssistJournalSuggestion }>("/api/assist/journal-suggest", {
        method: "POST",
        json: { text: t, memo: draftMemo || undefined, entryDate: draftDate || undefined },
        timeoutMs: 90_000,
      });
      setAssistSuggestion(r.suggestion);

      const missing = Array.isArray((r.suggestion as any)?.missing) ? (r.suggestion as any).missing : [];
      const hasPreview = Array.isArray((r.suggestion as any)?.preview?.lines) && (r.suggestion as any).preview.lines.length > 0;
      const assistantText = hasPreview
        ? tr("我已生成分录建议，请确认或继续补充细节。", "I generated a journal suggestion. Review below or add more details.")
        : missing.length
          ? tr(`还需要补充信息：${missing.join("；")}`, `More info needed: ${missing.join("; ")}`)
          : tr("我还没能生成完整分录，你可以继续补充金额/币种/付款方式/用途。", "I couldn't generate a complete journal yet. Add amount/currency/payment method/purpose.");
      setAssistChatMessages((m) => [...m, { role: "assistant", text: assistantText }]);
    } catch (e: any) {
      const msg = e?.message || "Error";
      setAssistErr(msg);
      setAssistChatMessages((m) => [...m, { role: "assistant", text: msg }]);
    } finally {
      setAssistBusy(false);
    }
  }

  async function sendAssistChatTurn(text: string) {
    const t = text.trim();
    if (!t || assistBusy) return;
    setAssistBusy(true);
    setAssistErr(null);
    setAssistSuggestion(null);
    const conversationText = [...assistChatMessages.filter((x) => x.role === "user").map((x) => x.text), t].join("\n");
    setAssistChatMessages((m) => [...m, { role: "user", text: t }]);
    try {
      const r = await api<{ suggestion: AssistJournalSuggestion }>("/api/assist/journal-suggest", {
        method: "POST",
        json: { text: conversationText, memo: draftMemo || undefined, entryDate: draftDate || undefined },
        timeoutMs: 90_000,
      });
      setAssistSuggestion(r.suggestion);

      const missing = Array.isArray((r.suggestion as any)?.missing) ? (r.suggestion as any).missing : [];
      const hasPreview = Array.isArray((r.suggestion as any)?.preview?.lines) && (r.suggestion as any).preview.lines.length > 0;
      const assistantText = hasPreview
        ? tr("我已更新分录建议，请确认或继续补充。", "Updated the suggestion. Review below or add more details.")
        : missing.length
          ? tr(`还需要补充信息：${missing.join("；")}`, `More info needed: ${missing.join("; ")}`)
          : tr("我还没能生成完整分录，你可以继续补充金额/币种/付款方式/用途。", "I couldn't generate a complete journal yet. Add amount/currency/payment method/purpose.");
      setAssistChatMessages((m) => [...m, { role: "assistant", text: assistantText }]);
    } catch (e: any) {
      const msg = e?.message || "Error";
      setAssistErr(msg);
      setAssistChatMessages((m) => [...m, { role: "assistant", text: msg }]);
    } finally {
      setAssistBusy(false);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAssistErr(null);
    } catch {
      setAssistErr(tr("复制失败：请手动全选复制。", "Copy failed. Please select all and copy manually."));
    }
  }

  function previewManualJson() {
    const raw = assistManualJson.trim();
    if (!raw) {
      setAssistErr(tr("请粘贴 AI 返回的 JSON。", "Please paste the JSON returned by the AI."));
      return;
    }
    setAssistErr(null);
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
      const obj = JSON.parse(jsonText) as AssistManualJson;
      const suggestion = suggestionFromManualJson(obj);
      setAssistSuggestion(suggestion);
    } catch (e: any) {
      setAssistSuggestion(null);
      setAssistErr(e?.message || tr("JSON 解析失败", "Failed to parse JSON"));
    }
  }

  function applyAssistSuggestion(
    s: AssistJournalSuggestion,
    opts?: {
      faPurchase?: {
        lineIdx: number;
        category: string;
        assetNo: string;
        name: string;
        acquisitionDate: string;
        usefulLifeMonths: number;
        salvageBase: number;
      } | null;
    },
  ) {
    setErr(null);
    setDraftDate(s.draft.entryDate);
    setDraftCurrency(String(s.draft.currency || "").toUpperCase());
    setDraftFx(Number(s.draft.fxRate) || 1);
    setDraftMemo(s.draft.memo || "");
    setDraftLines(
      (s.draft.lines || []).map((l) => {
        const debit = Number(l.debitTxn) || 0;
        const credit = Number(l.creditTxn) || 0;
        return {
          accountId: String(l.accountId || ""),
          description: l.description ? String(l.description) : "",
          costCenterId: l.costCenterId ? String(l.costCenterId) : "",
          debitTxn: debit > 0 ? debit.toFixed(2) : "",
          creditTxn: credit > 0 ? credit.toFixed(2) : "",
        };
      }),
    );
    setFixedAssetIdByLineIdx({});
    if (opts?.faPurchase && Number.isFinite(opts.faPurchase.lineIdx) && opts.faPurchase.lineIdx >= 0) {
      setFaPurchaseByLineIdx({
        [opts.faPurchase.lineIdx]: {
          category: opts.faPurchase.category,
          assetNo: opts.faPurchase.assetNo,
          name: opts.faPurchase.name,
          acquisitionDate: opts.faPurchase.acquisitionDate,
          usefulLifeMonths: opts.faPurchase.usefulLifeMonths,
          salvageBase: opts.faPurchase.salvageBase,
          memo: s.draft.memo || "",
        },
      });
    } else {
      setFaPurchaseByLineIdx({});
    }
    setFaPurchaseLineIdx(null);
    setFaDisposeCostLineIdx(null);
    setFaDisposeAccumLineIdx(null);

    const inv = s.draft.inventoryDetails;
    const link = Number(s.draft.inventoryLinkLineNo);
    if (Array.isArray(inv) && inv.length) {
      const mode = inv[0].moveType === "shipment" ? "shipment" : "receipt";
      const lineIdx = Number.isFinite(link) && link > 0 ? link - 1 : 0;
      const det = inv
        .map((d) => {
          const qty = Number((d as any).qty) || 0;
          if (qty <= 0) return null;
          if (mode === "receipt") {
            const unit = (d as any).moveType === "receipt" ? Number((d as any).unitCostTxn) || 0 : 0;
            return { rowId: newRowId(), itemId: String((d as any).itemId || ""), qty: String(Math.trunc(qty)), unitCostTxn: unit > 0 ? String(unit) : "" };
          }
          return { rowId: newRowId(), itemId: String((d as any).itemId || ""), qty: String(Math.trunc(qty)), unitCostTxn: "" };
        })
        .filter(Boolean) as any[];

      setInvMode(mode);
      setInvLineIdx(lineIdx);
      const line = (s.draft.lines || [])[lineIdx];
      const debit = Number(line?.debitTxn) || 0;
      const credit = Number(line?.creditTxn) || 0;
      const defaultSide: "debit" | "credit" = credit > 0 ? "credit" : "debit";
      const expectedTxn = defaultSide === "credit" ? credit : debit;
      const fx = Number(s.draft.fxRate) || 1;
      const expectedBase = Math.round(expectedTxn * fx * 100) / 100;
      setInvDefaultSide(defaultSide);
      setInvExpectedTxn(expectedTxn);
      setInvExpectedBase(expectedBase);
      setInvDetails(det);
      setInvConfirmed({ mode, expectedTxn, expectedBase, quoteBase: mode === "shipment" ? expectedBase : 0 });
    } else {
      setInvDetails([]);
      setInvConfirmed(null);
      setInvLineIdx(null);
    }
  }

  function resetAssistSuggestion() {
    setAssistSuggestion(null);
    setAssistErr(null);
  }

  function confirmAssistFill() {
    if (!assistSuggestion) return;
    const debit = assistEditLines.reduce((s, x) => s + (Number(x.debitTxn) || 0), 0);
    const credit = assistEditLines.reduce((s, x) => s + (Number(x.creditTxn) || 0), 0);
    const diff = Math.round((debit - credit) * 100) / 100;
    if (assistEditLines.length < 2) {
      setAssistErr(tr("至少需要 2 行分录。", "At least 2 lines are required."));
      return;
    }
    if (diff !== 0) {
      setAssistErr(tr(`借贷不平衡：差额 ${diff.toFixed(2)}`, `Not balanced: diff ${diff.toFixed(2)}`));
      return;
    }
    if (assistEditLines.some((x) => !x.accountId)) {
      setAssistErr(tr("请为每一行选择科目。", "Select an account for each line."));
      return;
    }

    const invDetailsOut = assistEditInvDetails
      .map((d) => {
        const qty = Math.trunc(Number(d.qty) || 0);
        if (!d.itemId || qty <= 0) return null;
        if (assistEditInvMode === "receipt") {
          const unit = Number(d.unitCostTxn) || 0;
          if (unit <= 0) return null;
          return { moveType: "receipt" as const, itemId: d.itemId, qty, unitCostTxn: unit };
        }
        return { moveType: "shipment" as const, itemId: d.itemId, qty };
      })
      .filter(Boolean) as any[];

    const includeInv = invDetailsOut.length > 0;

    const accountIdToCode = new Map(accounts.map((a) => [a.id, String(a.code).trim()]));
    const accountIdToName = new Map(accounts.map((a) => [a.id, a.name]));

    const previewLines = assistEditLines.map((x) => ({
      accountCode: accountIdToCode.get(x.accountId) || "",
      accountName: accountIdToName.get(x.accountId) || "",
      description: x.description || undefined,
      debitTxn: Math.max(0, Number(x.debitTxn) || 0),
      creditTxn: Math.max(0, Number(x.creditTxn) || 0),
    }));

    const draftLines = assistEditLines.map((x) => ({
      accountId: x.accountId,
      description: x.description || undefined,
      costCenterId: x.costCenterId ? x.costCenterId : null,
      debitTxn: Math.max(0, Number(x.debitTxn) || 0),
      creditTxn: Math.max(0, Number(x.creditTxn) || 0),
    }));

    const editedSuggestion: AssistJournalSuggestion = {
      draft: {
        entryDate: assistEditEntryDate || draftDate,
        currency: (assistEditCurrency || baseCurrency).toUpperCase().slice(0, 3),
        fxRate: Number(assistEditFxRate) || 1,
        memo: assistEditMemo || "",
        inventoryLinkLineNo: includeInv ? Math.max(1, Math.trunc(Number(assistEditInvLinkLineNo) || 1)) : undefined,
        inventoryDetails: includeInv ? (invDetailsOut as any) : undefined,
        lines: draftLines as any,
      },
      preview: {
        entryDate: assistEditEntryDate || draftDate,
        currency: (assistEditCurrency || baseCurrency).toUpperCase().slice(0, 3),
        fxRate: Number(assistEditFxRate) || 1,
        memo: assistEditMemo || "",
        inventoryLinkLineNo: includeInv ? Math.max(1, Math.trunc(Number(assistEditInvLinkLineNo) || 1)) : undefined,
        inventoryDetails: includeInv ? (invDetailsOut as any) : undefined,
        lines: previewLines as any,
      },
      warnings: Array.isArray((assistSuggestion as any).warnings) ? (assistSuggestion as any).warnings : [],
      missing: [],
    };

    let fa: any = null;
    if (assistEditFaPurchase && assistEditFaPurchase.category.trim() && assistEditFaPurchase.name.trim()) {
      const life = Math.trunc(Number(assistEditFaPurchase.usefulLifeMonths) || 0);
      const salvage = Number(assistEditFaPurchase.salvageBase) || 0;
      if (life > 0) {
        fa = {
          lineIdx: assistEditFaPurchase.lineIdx,
          category: assistEditFaPurchase.category.trim(),
          assetNo: assistEditFaPurchase.assetNo.trim(),
          name: assistEditFaPurchase.name.trim(),
          acquisitionDate: assistEditFaPurchase.acquisitionDate || (assistEditEntryDate || draftDate),
          usefulLifeMonths: life,
          salvageBase: salvage,
        };
      }
    }

    applyAssistSuggestion(editedSuggestion, { faPurchase: fa });
    setAssistOpen(false);
  }

  useEffect(() => {
    const d = assistSuggestion?.draft;
    if (!d || !Array.isArray(d.lines) || d.lines.length < 2) {
      setAssistEditEntryDate("");
      setAssistEditCurrency("");
      setAssistEditFxRate(1);
      setAssistEditMemo("");
      setAssistEditLines([]);
      setAssistEditInvMode("receipt");
      setAssistEditInvLinkLineNo(1);
      setAssistEditInvDetails([]);
      setAssistEditFaPurchase(null);
      return;
    }

    const entryDate = typeof d.entryDate === "string" && d.entryDate ? d.entryDate : draftDate;
    const currency = String(d.currency || baseCurrency).toUpperCase().slice(0, 3);
    const fxRate = Number(d.fxRate) || 1;
    const memo = typeof d.memo === "string" ? d.memo : "";
    setAssistEditEntryDate(entryDate);
    setAssistEditCurrency(currency);
    setAssistEditFxRate(fxRate);
    setAssistEditMemo(memo);
    setAssistEditLines(
      d.lines.map((l) => {
        const debit = Number((l as any).debitTxn) || 0;
        const credit = Number((l as any).creditTxn) || 0;
        return {
          accountId: String((l as any).accountId || ""),
          description: (l as any).description ? String((l as any).description) : "",
          costCenterId: (l as any).costCenterId ? String((l as any).costCenterId) : "",
          debitTxn: debit > 0 ? debit.toFixed(2) : "",
          creditTxn: credit > 0 ? credit.toFixed(2) : "",
        };
      }),
    );

    const inv = (d as any).inventoryDetails;
    const link = Number((d as any).inventoryLinkLineNo);
    if (Array.isArray(inv) && inv.length) {
      const mode = inv[0].moveType === "shipment" ? "shipment" : "receipt";
      setAssistEditInvMode(mode);
      setAssistEditInvLinkLineNo(Number.isFinite(link) && link > 0 ? Math.trunc(link) : 1);
      setAssistEditInvDetails(
        inv
          .map((x: any) => {
            const qty = Number(x?.qty) || 0;
            if (qty <= 0) return null;
            const unit = mode === "receipt" && x?.moveType === "receipt" ? Number(x?.unitCostTxn) || 0 : 0;
            return { rowId: newRowId(), itemId: String(x?.itemId || ""), qty: String(Math.trunc(qty)), unitCostTxn: unit > 0 ? String(unit) : "" };
          })
          .filter(Boolean) as any,
      );
    } else {
      setAssistEditInvMode("receipt");
      setAssistEditInvLinkLineNo(1);
      setAssistEditInvDetails([]);
    }

    const accById = new Map(accounts.map((a) => [a.id, a] as const));
    const fixedIdx = d.lines.findIndex((l) => {
      const acc = accById.get(String((l as any).accountId || ""));
      if (!acc || !(acc as any).linkFixedAssets) return false;
      const debit = Number((l as any).debitTxn) || 0;
      return debit > 0;
    });
    if (fixedIdx >= 0) {
      setAssistEditFaPurchase({
        lineIdx: fixedIdx,
        category: "",
        assetNo: "",
        name: tr("固定资产", "Fixed asset"),
        acquisitionDate: entryDate,
        usefulLifeMonths: "60",
        salvageBase: "0",
      });
    } else {
      setAssistEditFaPurchase(null);
    }
  }, [assistSuggestion, accounts, baseCurrency, draftDate]);

  function openInventoryDetailsModal(lineIdx: number, mode: "receipt" | "shipment", defaultSide: "debit" | "credit") {
    const line = draftLines[lineIdx];
    if (!line) {
      throw new Error("Invalid line");
    }
    const debit = Number(line.debitTxn) || 0;
    const credit = Number(line.creditTxn) || 0;
    if (debit > 0 && credit > 0) {
      throw new Error("该行不能同时有借和贷。");
    }
    const amountTxn = defaultSide === "debit" ? debit : credit;
    const info = {
      mode,
      expectedTxn: amountTxn,
      expectedBase: Math.round(amountTxn * draftFx * 100) / 100,
    };

    setInvLineIdx(lineIdx);
    setInvDefaultSide(defaultSide);
    setInvMode(info.mode);
    setInvExpectedTxn(info.expectedTxn);
    setInvExpectedBase(info.expectedBase);
    const seed = invDetails.length
      ? invDetails
      : [{ rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: "1", unitCostTxn: info.mode === "receipt" ? String(info.expectedTxn) : "" }];
    setInvEditingDetails(seed);
    setInvQuoteByRow({});
    setInvModalOpen(true);
  }

  const invEditingTotals = useMemo(() => {
    const totalTxn =
      invMode === "receipt"
        ? Math.round(invEditingDetails.reduce((s, d) => s + (Number(d.qty) || 0) * (Number(d.unitCostTxn) || 0), 0) * 100) / 100
        : 0;
    const totalQuoteBase =
      invMode === "shipment"
        ? Math.round(
            invEditingDetails.reduce((s, d) => s + (Number(invQuoteByRow[d.rowId]?.base) || 0), 0) * 100,
          ) / 100
        : 0;
    return { totalTxn, totalQuoteBase };
  }, [invMode, invEditingDetails, invQuoteByRow]);

  useEffect(() => {
    if (!invModalOpen || invMode !== "shipment") return;
    let cancelled = false;
    const rows = invEditingDetails.filter((d) => d.itemId && (Number(d.qty) || 0) > 0);
    (async () => {
      const pairs = await Promise.all(
        rows.map(async (r) => {
          try {
            const resp = await api<{ itemId: string; qty: number; totalBase: number }>(
              `/api/inventory/shipments/quote?itemId=${encodeURIComponent(r.itemId)}&qty=${encodeURIComponent(String(Number(r.qty) || 0))}`,
            );
            return [r.rowId, { base: Number(resp.totalBase), err: null }] as const;
          } catch (e: any) {
            return [r.rowId, { base: null, err: e?.message || "Quote failed" }] as const;
          }
        }),
      );
      if (cancelled) return;
      const updates = Object.fromEntries(pairs);
      setInvQuoteByRow((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [invModalOpen, invMode, invEditingDetails]);

  useEffect(() => {
    setDraftCurrency(baseCurrency);
    setDraftFx(1);
  }, [baseCurrency]);

  useEffect(() => {
    setInvDetails([]);
    setInvConfirmed(null);
    setInvLineIdx(null);
  }, [activeOrgId]);

  async function fillFxFromHistory() {
    const cc = draftCurrency.toUpperCase();
    if (cc === baseCurrency) {
      setDraftFx(1);
      return;
    }
    const r = await api<{ fxRates: Array<{ fxRate: number }> }>(
      `/api/settings/fx-rates?rateDate=${draftDate}&currencyCode=${encodeURIComponent(cc)}`,
    );
    const fx = r.fxRates?.[0]?.fxRate;
    if (!fx) {
      throw new Error(tr("未找到该日期的历史汇率，请到设置里新增 FX Rate", "No FX rate found for this date. Please add it in Settings."));
    }
    setDraftFx(Number(fx));
  }

  async function loadDetail(id: string) {
    const d = await api<EntryDetail>(`/api/journals/${id}`);
    setDetail(d);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setEntries([]);
    setSelectedId(null);
    setDetail(null);
    refresh().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  useEffect(() => {
    const entryId = searchParams.get("entryId");
    if (!entryId) return;
    if (!activeOrgId || orgSwitching) return;
    setSelectedId(entryId);
    setSearchParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("entryId");
      return next;
    });
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }, [searchParams, activeOrgId, orgSwitching, setSearchParams]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((e) => setErr(e.message));
  }, [selectedId]);

  function renderEditorCard() {
    const voucherEmpty = !draftVoucherNo.trim();
    const readOnly = Boolean(postDraftId);

    const currencyForQuick = (assistQuickCurrency.trim() || draftCurrency || baseCurrency).toUpperCase();
    const quickTextParts: string[] = [];
    const who = assistQuickWho.trim();
    const onBehalf = assistQuickOnBehalf.trim();
    if (who) {
      if (onBehalf) quickTextParts.push(`${who}代替${onBehalf}`);
      else quickTextParts.push(who);
    } else if (onBehalf) {
      quickTextParts.push(onBehalf);
    }
    if (assistQuickPayMethod.trim()) quickTextParts.push(`用${assistQuickPayMethod.trim()}`);
    if (assistQuickAction.trim()) quickTextParts.push(assistQuickAction.trim());

    if (assistQuickExistingFixedAssetId === "__new__") {
      quickTextParts.push(tr("新增固定资产", "New fixed asset"));
    } else if (assistQuickExistingFixedAssetId) {
      const fa = fixedAssets.find((x) => x.id === assistQuickExistingFixedAssetId);
      if (fa) {
        const label = `${fa.assetNo ? `${fa.assetNo} ` : ""}${fa.name}`.trim();
        quickTextParts.push(tr(`现有固定资产：${label}`, `Existing fixed asset: ${label}`));
      }
    }

    if (assistQuickExistingInventoryItemId === "__new__") {
      quickTextParts.push(tr("新增存货", "New inventory item"));
    } else if (assistQuickExistingInventoryItemId) {
      const it = inventoryItems.find((x: any) => String(x.id) === assistQuickExistingInventoryItemId);
      if (it) {
        const label = `${it.sku ? `${it.sku} ` : ""}${it.name}`.trim();
        quickTextParts.push(tr(`现有存货：${label}`, `Existing inventory: ${label}`));
      }
    }

    const amt = assistQuickAmount.trim();
    if (amt) quickTextParts.push(`${amt} ${currencyForQuick}`.trim());
    if (assistQuickPurpose.trim()) quickTextParts.push(`用途：${assistQuickPurpose.trim()}`);
    const quickText = quickTextParts.join("，");

    const canGenerate = !readOnly && !busy && !!assistQuickAction.trim() && !!amt;
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold">
          {editingEntryId
            ? tr("编辑凭证", "Edit journal")
            : postDraftId
              ? tr("新建凭证（从草稿过账）", "New journal (post from draft)")
              : tr("新建凭证（直接过账）", "New journal (post directly)")}
        </div>

        <div className="mt-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-3">
            <div className="grid gap-3 md:grid-cols-12">
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("谁", "Who")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickWho}
                  onChange={(e) => setAssistQuickWho(e.target.value)}
                  placeholder={tr("董事", "Director")}
                  disabled={readOnly || busy}
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("代替谁", "On behalf")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickOnBehalf}
                  onChange={(e) => setAssistQuickOnBehalf(e.target.value)}
                  placeholder={tr("公司", "Company")}
                  disabled={readOnly || busy}
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("付款方式", "Payment")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickPayMethod}
                  onChange={(e) => setAssistQuickPayMethod(e.target.value)}
                  placeholder={tr("现金/转账", "Cash/transfer")}
                  disabled={readOnly || busy}
                />
              </div>
              <div className="md:col-span-3">
                <label className="text-xs text-zinc-600">{tr("做什么", "What")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickAction}
                  onChange={(e) => setAssistQuickAction(e.target.value)}
                  placeholder={tr("购买一辆汽车", "Bought a car")}
                  disabled={readOnly || busy}
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("是否现有固定资产", "Existing FA")}</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                  value={assistQuickExistingFixedAssetId}
                  onChange={(e) => setAssistQuickExistingFixedAssetId(e.target.value)}
                  onFocus={() => {
                    if (!fixedAssets.length) {
                      refreshFixedAssets().catch((e) => setErr(e.message));
                    }
                  }}
                  disabled={readOnly || busy}
                >
                  <option value="" disabled>
                    {tr("请选择", "Select")}
                  </option>
                  <option value="__new__">{tr("新增", "New")}</option>
                  {fixedAssets
                    .filter((x) => String(x.status).toLowerCase() === "active")
                    .slice()
                    .sort((a, b) => `${a.assetNo || ""} ${a.name}`.localeCompare(`${b.assetNo || ""} ${b.name}`))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.assetNo ? `${x.assetNo} ` : ""}{x.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("是否现有存货", "Existing inventory")}</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                  value={assistQuickExistingInventoryItemId}
                  onChange={(e) => setAssistQuickExistingInventoryItemId(e.target.value)}
                  disabled={readOnly || busy}
                >
                  <option value="" disabled>
                    {tr("请选择", "Select")}
                  </option>
                  <option value="__new__">{tr("新增", "New")}</option>
                  {inventoryItems
                    .slice()
                    .sort((a: any, b: any) => `${a.sku || ""} ${a.name}`.localeCompare(`${b.sku || ""} ${b.name}`))
                    .map((it: any) => (
                      <option key={String(it.id)} value={String(it.id)}>
                        {it.sku ? `${it.sku} ` : ""}{it.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="md:col-span-1">
                <label className="text-xs text-zinc-600">{tr("货币", "CCY")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
                  value={currencyForQuick}
                  onChange={(e) => setAssistQuickCurrency(e.target.value.toUpperCase())}
                  placeholder={draftCurrency || baseCurrency}
                  disabled={readOnly || busy}
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">{tr("金额", "Amount")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickAmount}
                  onChange={(e) => setAssistQuickAmount(e.target.value)}
                  placeholder={tr("20000", "20000")}
                  disabled={readOnly || busy}
                  inputMode="decimal"
                />
              </div>
              <div className="md:col-span-12">
                <label className="text-xs text-zinc-600">{tr("用途", "Purpose")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={assistQuickPurpose}
                  onChange={(e) => setAssistQuickPurpose(e.target.value)}
                  placeholder={tr("公司使用/办公用途/自用", "Company use/office/personal")}
                  disabled={readOnly || busy}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey) return;
                    e.preventDefault();
                    if (!canGenerate) return;
                    void startAssistChat(quickText);
                  }}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-zinc-500">
                {quickText.trim()
                  ? tr(`将生成：${quickText}`, `Will generate: ${quickText}`)
                  : tr(
                      "示例：董事代替公司用现金购买一辆汽车，20000 MYR，用途：公司使用。",
                      "Example: Director on behalf of company paid cash to buy a car, 20000 MYR, purpose: company use.",
                    )}
              </div>
            <button
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              disabled={!canGenerate}
              onClick={() => {
                if (!canGenerate) return;
                void startAssistChat(quickText);
              }}
              type="button"
            >
              {tr("生成建议", "Generate")}
            </button>
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
              disabled={readOnly || busy}
              onClick={() => {
                void startAssistChat(quickText.trim() || undefined);
              }}
              type="button"
            >
              {tr("展开对话框", "Open")}
            </button>
            </div>
          </div>
          <div className="mt-1 text-xs text-zinc-500">{tr("仅填入草稿，需你确认后再点“过账”。", "Fills draft only. Please review then click 'Post'.")}</div>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="w-44">
            <label className="text-xs text-zinc-600">{tr("日期", "Date")}</label>
            <input
              className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={readOnly}
            />
          </div>
          <div className="w-44">
            <label className="text-xs text-zinc-600">{tr("分录号", "Voucher No")}</label>
            <input
              className={
                "mt-1 w-full rounded-md border px-3 py-2 text-sm " +
                (voucherEmpty ? "border-red-300" : "border-zinc-200")
              }
              value={draftVoucherNo}
              onChange={(e) => {
                setVoucherTouched(true);
                setDraftVoucherNo(e.target.value.toUpperCase());
              }}
              placeholder={tr("自动生成，可修改", "Auto-generated, editable")}
              disabled={readOnly}
            />
          </div>
          <div className="w-28">
            <label className="text-xs text-zinc-600">{tr("币种", "Currency")}</label>
            <select
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={draftCurrency}
              onChange={(e) => setDraftCurrency(e.target.value.toUpperCase())}
              disabled={readOnly}
            >
              {enabledCurrencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className="text-xs text-zinc-600">{tr("汇率", "FX rate")}</label>
            <input
              className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              value={String(draftFx)}
              onChange={(e) => setDraftFx(e.target.value === "" ? 1 : Number(e.target.value) || 1)}
              type="number"
              step="0.0001"
              disabled={readOnly}
            />
          </div>
          <button
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
            disabled={readOnly || !draftDate.trim() || !draftCurrency.trim()}
            onClick={async () => {
              setErr(null);
              try {
                await fillFxFromHistory();
              } catch (e: any) {
                setErr(e.message);
              }
            }}
            type="button"
          >
            {tr("用历史", "Use history")}
          </button>
          <div className="min-w-[260px] flex-1">
            <label className="text-xs text-zinc-600">{tr("备注", "Memo")}</label>
            <input
              className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              value={draftMemo}
              onChange={(e) => setDraftMemo(e.target.value)}
              disabled={readOnly}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={recurringEnabled}
              onChange={(e) => {
                const checked = e.target.checked;
                setRecurringEnabled(checked);
                if (checked) {
                  setRecurringStartDate((prev) => (prev?.trim() ? prev : draftDate));
                }
              }}
              disabled={readOnly}
            />
            Recurring
          </label>

          {recurringEnabled ? (
            <>
              <div className="w-56">
                <label className="text-xs text-zinc-600">{tr("开始日期", "Start date")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={recurringStartDate || draftDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setRecurringStartDate(v);
                    setDraftDate(v);
                  }}
                  type="date"
                  disabled={readOnly}
                />
              </div>
              <div className="w-48">
                <label className="text-xs text-zinc-600">{tr("每隔（月）", "Every (months)")}</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                  value={recurringEveryMonths}
                  onChange={(e) => setRecurringEveryMonths(Number(e.target.value) || 1)}
                  disabled={readOnly}
                >
                  {[1, 2, 3, 6, 12].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-48">
                <label className="text-xs text-zinc-600">{tr("次数", "Count")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={recurringCount}
                  onChange={(e) => setRecurringCount(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  disabled={readOnly}
                />
              </div>
              <div className="text-xs text-zinc-500">{tr(`从开始日期生成 ${recurringCount} 张凭证`, `Generate ${recurringCount} journals starting from the start date`)}</div>
            </>
          ) : null}
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          {tr(
            `基准币 ${baseCurrency}：同币种时汇率为 1；其他币种可从设置里的 FX Rates 维护并回填。`,
            `Base currency ${baseCurrency}: FX rate is 1 when same currency; maintain FX Rates in Settings for other currencies.`,
          )}
        </div>

        <div className="mt-4 overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-600">
              <tr>
                <th className="px-3 py-2 text-left">{tr("科目", "Account")}</th>
                <th className="px-3 py-2 text-left">{tr("摘要", "Description")}</th>
                <th className="px-3 py-2 text-left">Cost Center</th>
                <th className="px-3 py-2 text-right">{tr("借", "Debit")}</th>
                <th className="px-3 py-2 text-right">{tr("贷", "Credit")}</th>
              </tr>
            </thead>
            <tbody>
              {draftLines.map((l, idx) => (
                <tr key={idx} className="border-t border-zinc-100">
                  <td className="px-3 py-2">
                    <select
                      className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                      value={l.accountId}
                      onChange={(e) => {
                        if (e.target.value === "__new_account__") {
                          navigate("/settings");
                          return;
                        }
                        const next = [...draftLines];
                        next[idx] = { ...l, accountId: e.target.value };
                        setDraftLines(next);
                      }}
                      disabled={readOnly}
                    >
                      <option value="__new_account__">{tr("+ 新增科目", "+ New account")}</option>
                      <option value="">{tr("请选择", "Select")}</option>
                      {accounts
                        .filter((a) => ((a as any).isActive ?? true) || a.id === l.accountId)
                        .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} {a.name}{(a as any).isActive === false ? tr("（已删除）", " (inactive)") : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-full rounded-md border border-zinc-200 px-2 py-1 text-sm"
                      value={l.description}
                      onChange={(e) => {
                        const next = [...draftLines];
                        next[idx] = { ...l, description: e.target.value };
                        setDraftLines(next);
                      }}
                      disabled={readOnly}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                      value={l.costCenterId}
                      onChange={(e) => {
                        const next = [...draftLines];
                        next[idx] = { ...l, costCenterId: e.target.value };
                        setDraftLines(next);
                      }}
                      disabled={readOnly}
                    >
                      <option value="">{tr("(无)", "(None)")}</option>
                      {costCenters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <input
                        className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                        value={l.debitTxn}
                        onChange={(e) => {
                          const next = [...draftLines];
                          next[idx] = { ...l, debitTxn: e.target.value };
                          setDraftLines(next);
                        }}
                        type="number"
                        step="0.01"
                        disabled={readOnly}
                      />
                      {(() => {
                        const acc = accounts.find((a) => a.id === l.accountId);
                        const code = acc?.code ? String(acc.code) : "";
                        const linkFa = Boolean(acc?.linkFixedAssets);
                        const linkInv = Boolean(acc?.linkInventoryFifo);
                        const amount = Number(l.debitTxn) || 0;
                        const hasAmount = amount > 0;
                        const label =
                          linkFa && code.startsWith("161")
                            ? "处置"
                            : linkFa && code.startsWith("16") && !code.startsWith("161")
                              ? "购买"
                              : linkFa && code.startsWith("61")
                                ? "折旧"
                                : linkInv
                                  ? "库存"
                                  : null;
                        if (!label) return null;

                        const active = invLineIdx === idx && invMode === "receipt" && invDetails.length;
                        const disabled = busy || readOnly || !hasAmount;
                        const cls =
                          "rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 " +
                          (active
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : hasAmount
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "border-zinc-200 bg-white");

                        return (
                          <button
                            className={cls}
                            onClick={() => {
                              if (disabled) return;
                              setErr(null);
                              if (label === "处置") {
                                setInvDetails([]);
                                setInvConfirmed(null);
                                setInvLineIdx(null);
                                void openFixedAssetDisposeModal("accumDep", idx, amount);
                                return;
                              }
                              if (label === "购买") {
                                setInvDetails([]);
                                setInvConfirmed(null);
                                setInvLineIdx(null);
                                openFixedAssetPurchaseModal(idx, amount);
                                return;
                              }
                              if (label === "折旧") {
                                setInvDetails([]);
                                setInvConfirmed(null);
                                setInvLineIdx(null);
                                openFixedAssetDepreciateModal(idx, amount);
                                return;
                              }

                              if (invLineIdx != null && invLineIdx !== idx) {
                                setInvDetails([]);
                                setInvConfirmed(null);
                              }
                              try {
                                openInventoryDetailsModal(idx, "receipt", "debit");
                              } catch (e: any) {
                                setErr(e.message);
                              }
                            }}
                            disabled={disabled}
                            type="button"
                          >
                            {label}
                          </button>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <input
                        className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                        value={l.creditTxn}
                        onChange={(e) => {
                          const next = [...draftLines];
                          next[idx] = { ...l, creditTxn: e.target.value };
                          setDraftLines(next);
                        }}
                        type="number"
                        step="0.01"
                        disabled={readOnly}
                      />
                      {(() => {
                        const acc = accounts.find((a) => a.id === l.accountId);
                        const code = acc?.code ? String(acc.code) : "";
                        const linkFa = Boolean(acc?.linkFixedAssets);
                        const linkInv = Boolean(acc?.linkInventoryFifo);
                        const amount = Number(l.creditTxn) || 0;
                        const hasAmount = amount > 0;
                        const label =
                          linkFa && (code.startsWith("16") || code.startsWith("161"))
                            ? "处置"
                            : linkFa && code.startsWith("61")
                              ? "折旧"
                              : linkInv
                                ? "库存"
                                : null;
                        if (!label) return null;

                        const active = invLineIdx === idx && invMode === "shipment" && invDetails.length;
                        const disabled = busy || readOnly || !hasAmount;
                        const cls =
                          "rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 " +
                          (active
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : hasAmount
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              : "border-zinc-200 bg-white");

                        return (
                          <button
                            className={cls}
                            onClick={() => {
                              if (disabled) return;
                              setErr(null);
                              if (label === "处置") {
                                setInvDetails([]);
                                setInvConfirmed(null);
                                setInvLineIdx(null);
                                if (code.startsWith("161")) {
                                  void openFixedAssetDisposeModal("accumDep", idx, amount);
                                } else {
                                  void openFixedAssetDisposeModal("cost", idx, amount);
                                }
                                return;
                              }
                              if (label === "折旧") {
                                setInvDetails([]);
                                setInvConfirmed(null);
                                setInvLineIdx(null);
                                openFixedAssetDepreciateModal(idx, amount);
                                return;
                              }

                              if (invLineIdx != null && invLineIdx !== idx) {
                                setInvDetails([]);
                                setInvConfirmed(null);
                              }
                              try {
                                openInventoryDetailsModal(idx, "shipment", "credit");
                              } catch (e: any) {
                                setErr(e.message);
                              }
                            }}
                            disabled={disabled}
                            type="button"
                          >
                            {label}
                          </button>
                        );
                      })()}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className={"text-sm " + (txnDiff === 0 ? "text-green-700" : "text-amber-700")}>
            {tr("差额：", "Diff: ")}
            {txnDiff.toFixed(2)} {draftCurrency}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
              onClick={() => setDraftLines([...draftLines, { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" }])}
              disabled={busy || readOnly}
              type="button"
            >
              {tr("增加行", "Add line")}
            </button>
            {editingEntryId ? (
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                disabled={busy}
                onClick={() => {
                  setErr(null);
                  resetDraftEntry();
                }}
                type="button"
              >
                {tr("取消编辑", "Cancel")}
              </button>
            ) : null}
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
              disabled={busy}
              onClick={() => {
                setErr(null);
                resetDraftEntry();
              }}
              type="button"
            >
              {tr("清空", "Clear")}
            </button>
            <button
              className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || txnDiff !== 0 || voucherEmpty || draftLines.some((l) => !l.accountId)}
              onClick={async () => {
                setErr(null);
                if (!draftVoucherNo.trim()) {
                  try {
                    const v = await refreshNextVoucherNo(true);
                    if (!String(v || "").trim()) {
                      setErr(tr("分录号不能为空。", "Voucher number cannot be empty."));
                      return;
                    }
                  } catch (e: any) {
                    setErr(e.message);
                    return;
                  }
                }
                if (invDetails.length) {
                  if (invLineIdx == null) {
                    setErr(tr("请先在借方或贷方点击“库存”并确认明细。", "Please click 'Inventory' on a debit/credit line and confirm details first."));
                    return;
                  }
                  const line = draftLines[invLineIdx];
                  if (!line) {
                    setErr(tr("库存关联的分录行无效，请重新填写库存明细。", "Invalid linked journal line for inventory. Please re-enter details."));
                    return;
                  }
                  const debit = Number(line.debitTxn) || 0;
                  const credit = Number(line.creditTxn) || 0;
                  if (debit > 0 && credit > 0) {
                    setErr(tr("库存关联行不能同时有借和贷。", "The inventory-linked line cannot have both debit and credit."));
                    return;
                  }
                  const existingTxn = debit > 0 ? debit : credit > 0 ? credit : 0;
                  const expectedBaseFromExisting = Math.round(existingTxn * draftFx * 100) / 100;

                  const computedReceiptTxn = Math.round(invDetails.reduce((s, d) => s + (Number(d.qty) || 0) * (Number(d.unitCostTxn) || 0), 0) * 100) / 100;
                  const computedShipmentBase = invConfirmed?.quoteBase ?? 0;

                  if (!invConfirmed || invConfirmed.mode !== invMode) {
                    setErr(tr("请先在库存明细弹窗点击“确认”。", "Please click 'Confirm' in the inventory details modal first."));
                    try {
                      openInventoryDetailsModal(invLineIdx, invMode, invDefaultSide);
                    } catch {
                      // ignore
                    }
                    return;
                  }

                  if (invMode === "receipt") {
                    if (existingTxn > 0) {
                      if (Math.round(existingTxn * 100) / 100 !== Math.round(computedReceiptTxn * 100) / 100) {
                        setErr(tr("库存入库明细合计必须与该行金额一致。", "Receipt details total must match the line amount."));
                        try {
                          openInventoryDetailsModal(invLineIdx, "receipt", invDefaultSide);
                        } catch {
                          // ignore
                        }
                        return;
                      }
                    }
                  }

                  if (invMode === "shipment") {
                    if (existingTxn > 0) {
                      void expectedBaseFromExisting;
                    }
                    void computedShipmentBase;
                  }
                }

                setBusy(true);
                try {
                  if (postDraftId) {
                    const id = postDraftId;
                    const fixedAssetPurchases = Object.entries(faPurchaseByLineIdx).length
                      ? Object.entries(faPurchaseByLineIdx).map(([k, v]) => ({
                          lineNo: Number(k) + 1,
                          category: v.category,
                          assetNo: v.assetNo || undefined,
                          name: v.name,
                          acquisitionDate: v.acquisitionDate,
                          usefulLifeMonths: v.usefulLifeMonths,
                          salvageBase: v.salvageBase,
                        }))
                      : undefined;
                    await api(`/api/journals/${encodeURIComponent(id)}/post` as any, {
                      method: "POST",
                      json: fixedAssetPurchases ? { fixedAssetPurchases } : undefined,
                    });
                    resetDraftEntry();
                    await refresh();
                    setSelectedId(id);
                    return;
                  }

                  if ((faDisposeCostLineIdx != null) !== (faDisposeAccumLineIdx != null)) {
                    throw new Error("处置需要同时选择成本行与累计折旧行。");
                  }

                  const inventoryDetails =
                    invDetails.length && invLineIdx != null
                      ? invDetails.map((d) =>
                          invMode === "receipt"
                            ? { moveType: "receipt", itemId: d.itemId, qty: Number(d.qty) || 0, unitCostTxn: Number(d.unitCostTxn) || 0 }
                            : { moveType: "shipment", itemId: d.itemId, qty: Number(d.qty) || 0 },
                        )
                      : undefined;

                  const effectiveLines = draftLines.map((l) => ({ ...l }));
                  if (inventoryDetails?.length && invLineIdx != null) {
                    const line = effectiveLines[invLineIdx];
                    const debit = Number(line.debitTxn) || 0;
                    const credit = Number(line.creditTxn) || 0;
                    const existing = debit > 0 ? debit : credit > 0 ? credit : 0;
                    if (existing <= 0) {
                      if (invMode === "receipt") {
                        const totalTxn = Math.round(invDetails.reduce((s, d) => s + (Number(d.qty) || 0) * (Number(d.unitCostTxn) || 0), 0) * 100) / 100;
                        if (invDefaultSide === "credit") {
                          line.creditTxn = totalTxn > 0 ? String(totalTxn) : "";
                          line.debitTxn = "";
                        } else {
                          line.debitTxn = totalTxn > 0 ? String(totalTxn) : "";
                          line.creditTxn = "";
                        }
                      } else {
                        const totalBase = invConfirmed?.quoteBase ?? 0;
                        const totalTxn = Math.round((totalBase / (draftFx || 1)) * 100) / 100;
                        if (invDefaultSide === "debit") {
                          line.debitTxn = totalTxn > 0 ? String(totalTxn) : "";
                          line.creditTxn = "";
                        } else {
                          line.creditTxn = totalTxn > 0 ? String(totalTxn) : "";
                          line.debitTxn = "";
                        }
                      }
                    }
                  }

                  const reqBody = {
                    entryDate: recurringEnabled ? recurringStartDate || draftDate : draftDate,
                    voucherNo: draftVoucherNo.trim() || undefined,
                    currency: draftCurrency,
                    fxRate: draftFx,
                    memo: draftMemo,
                    inventoryLinkLineNo: invLineIdx != null && inventoryDetails?.length ? invLineIdx + 1 : undefined,
                    inventoryDetails,
                    fixedAssetPurchases: Object.entries(faPurchaseByLineIdx).length
                      ? Object.entries(faPurchaseByLineIdx).map(([k, v]) => ({
                          lineNo: Number(k) + 1,
                          category: v.category,
                          assetNo: v.assetNo || undefined,
                          name: v.name,
                          acquisitionDate: v.acquisitionDate,
                          usefulLifeMonths: v.usefulLifeMonths,
                          salvageBase: v.salvageBase,
                        }))
                      : undefined,
                    fixedAssetDisposal:
                      faDisposeCostLineIdx != null && faDisposeAccumLineIdx != null
                        ? { costLineNo: faDisposeCostLineIdx + 1, accumDepLineNo: faDisposeAccumLineIdx + 1 }
                        : undefined,
                    recurring: recurringEnabled
                      ? {
                          everyMonths: Math.max(1, Math.min(24, Number(recurringEveryMonths) || 1)),
                          count: Math.max(1, Math.min(120, Number(recurringCount) || 1)),
                        }
                      : undefined,
                    lines: effectiveLines.map((l, idx) => ({
                      accountId: l.accountId,
                      description: l.description || undefined,
                      costCenterId: l.costCenterId ? l.costCenterId : null,
                      debitTxn: Number(l.debitTxn) || 0,
                      creditTxn: Number(l.creditTxn) || 0,
                      fixedAssetId: fixedAssetIdByLineIdx[idx] || undefined,
                    })),
                  };

                  if (recurringEnabled) {
                    const hasInv = Boolean(inventoryDetails?.length);
                    const hasFaPurchases = Boolean(Object.keys(faPurchaseByLineIdx).length);
                    if (hasInv || hasFaPurchases) {
                      throw new Error("Recurring 暂不支持库存/购置自动生成，请用普通过账。");
                    }
                  }

                  const resp = editingEntryId
                    ? await api<{ entry: { id: string } }>(`/api/journals/${encodeURIComponent(editingEntryId)}` as any, { method: "PUT", json: reqBody })
                    : await api<{ entry?: { id: string }; entries?: Array<{ id: string; entryDate: string; voucherNo: string | null }> }>("/api/journals/post", { method: "POST", json: reqBody });

                  resetDraftEntry();
                  await refresh();
                  const firstId = (resp as any)?.entry?.id || (resp as any)?.entries?.[0]?.id;
                  if (firstId) {
                    setSelectedId(firstId);
                  }
                  const seriesCount = Array.isArray((resp as any)?.entries) ? (resp as any).entries.length : 0;
                  if (seriesCount > 1) {
                    window.alert(`已生成 ${seriesCount} 张凭证`);
                  }
                  if (editModalOpen) {
                    setEditModalOpen(false);
                  }
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
              type="button"
            >
              {editingEntryId ? tr("保存", "Save") : tr("过账", "Post")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AppShell title={tr("分录", "Journals")}>
      <div className="space-y-4">
        {err ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}
        {editingEntryId ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-zinc-700">
                {tr(
                  "编辑模式已开启：可在列表点击“编辑”弹出表单修改并保存。",
                  "Edit mode is active: click 'Edit' in the list to modify and save.",
                )}
              </div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                disabled={busy}
                onClick={() => {
                  setErr(null);
                  resetDraftEntry();
                }}
                type="button"
              >
                {tr("取消编辑", "Cancel")}
              </button>
            </div>
          </div>
        ) : (
          renderEditorCard()
        )}

        {editModalOpen && editingEntryId ? (
          <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4">
            <div className="w-full max-w-5xl rounded-xl bg-white p-4 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">
                  {tr("编辑凭证", "Edit journal")} {draftVoucherNo || "-"}
                </div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    resetDraftEntry();
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>
              <div className="mt-3">
                {renderEditorCard()}
              </div>
            </div>
          </div>
        ) : null}

        {assistOpen ? (
          <div
            className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4"
            onMouseDown={() => {
              setAssistOpen(false);
              setAssistBusy(false);
            }}
          >
            <div
              className="mx-auto flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 p-4">
                <div className="text-sm font-semibold">{tr("对话生成分录（不会自动过账）", "AI assist (won't auto-post)")}</div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                  disabled={assistBusy}
                  onClick={() => {
                    setAssistOpen(false);
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                <div className="rounded-lg border border-zinc-200 bg-white">
                  <div className="max-h-72 space-y-2 overflow-auto p-3 text-sm">
                    {(assistChatMessages.length
                      ? assistChatMessages
                      : [
                          {
                            role: "assistant" as const,
                            text: tr(
                              "把交易用一句话描述给我。我会追问必要信息，直到分录可确认并填入草稿（不会自动过账）。",
                              "Describe the transaction. I'll ask follow-ups until the journal is ready to confirm & fill (won't auto-post).",
                            ),
                          },
                        ]
                    ).map((m, idx) => (
                      <div key={idx} className={m.role === "user" ? "text-right" : "text-left"}>
                        <div
                          className={
                            m.role === "user"
                              ? "inline-block max-w-[85%] rounded-2xl bg-blue-700 px-3 py-2 text-white"
                              : "inline-block max-w-[85%] rounded-2xl bg-zinc-100 px-3 py-2 text-zinc-900"
                          }
                        >
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {assistErr ? <div className="mt-3 text-sm text-red-700">{assistErr}</div> : null}

                {assistSuggestion ? (
                  <div className="mt-4">
                  {assistSuggestion.missing?.length ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      <div className="font-medium">{tr("需要补充信息/设置", "Missing info/setup")}</div>
                      <div className="mt-1">{assistSuggestion.missing.join("；")}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="text-xs text-amber-900/70">{tr("请补充必要信息后继续生成：", "Add missing info and continue:")}</div>
                        <input
                          className="w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm"
                          value={assistExtra}
                          onChange={(e) => setAssistExtra(e.target.value)}
                          placeholder={tr(
                            "例如：现金/银行转账；金额 20000 MYR；用途；是否资本化；折旧年限。",
                            "E.g., cash/bank transfer; amount 20000 MYR; purpose; capitalize?; useful life.",
                          )}
                          disabled={assistBusy}
                        />
                        <button
                          className="rounded-md bg-amber-700 px-3 py-2 text-sm text-white hover:bg-amber-800 disabled:opacity-50"
                          disabled={assistBusy || !assistExtra.trim()}
                          onClick={() => {
                            const extra = assistExtra.trim();
                            setAssistExtra("");
                            void sendAssistChatTurn(extra);
                          }}
                          type="button"
                        >
                          {tr("补充并继续", "Continue")}
                        </button>
                        <button
                          className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100"
                          onClick={() => navigate("/settings")}
                          type="button"
                        >
                          {tr("去设置科目", "Go to settings")}
                        </button>
                        <button
                          className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100"
                          onClick={() => navigate("/fixed-assets")}
                          type="button"
                        >
                          {tr("去新增固定资产", "Add fixed asset")}
                        </button>
                        <button
                          className="rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm hover:bg-amber-100"
                          onClick={() => navigate("/inventory")}
                          type="button"
                        >
                          {tr("去新增库存商品", "Add inventory item")}
                        </button>
                      </div>
                      {assistMode === "manual" ? (
                        <>
                          <div className="mt-3">
                            <label className="text-xs text-zinc-700">{tr("补充信息（可选）", "Extra info (optional)")}</label>
                            <textarea
                              className="mt-1 h-20 w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm"
                              value={assistExtra}
                              onChange={(e) => setAssistExtra(e.target.value)}
                              placeholder={tr(
                                "例如：付款方式/供应商/是否含税/用途/借款或资本等。",
                                "E.g., payment method/vendor/tax included/purpose/loan or capital.",
                              )}
                            />
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              className="rounded-md bg-amber-700 px-3 py-2 text-sm text-white hover:bg-amber-800 disabled:opacity-50"
                              disabled={assistBusy || !assistText.trim() || !assistExtra.trim()}
                              onClick={() => {
                                const merged = `${assistText.trim()}\n\n补充信息：${assistExtra.trim()}`;
                                void runAssistSuggest(merged);
                              }}
                              type="button"
                            >
                              {tr("补充并重新生成", "Regenerate")}
                            </button>
                            <div className="text-xs text-amber-900/70">
                              {tr("仅用于生成建议，不会自动过账。", "Used for suggestion only; won't auto-post.")}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {assistSuggestion.warnings?.length ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {tr("提示：", "Warnings: ")}
                      {assistSuggestion.warnings.join("；")}
                    </div>
                  ) : null}

                  {Array.isArray((assistSuggestion as any)?.preview?.lines) && (assistSuggestion as any).preview.lines.length ? (
                    <>
                      <div className="mt-3 grid gap-3 md:grid-cols-4">
                        <div>
                          <label className="text-xs text-zinc-600">{tr("日期", "Date")}</label>
                          <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditEntryDate} onChange={(e) => setAssistEditEntryDate(e.target.value)} />
                        </div>
                        <div>
                          <label className="text-xs text-zinc-600">{tr("币种", "Currency")}</label>
                          <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={assistEditCurrency} onChange={(e) => setAssistEditCurrency(e.target.value.toUpperCase())}>
                            {enabledCurrencies.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-zinc-600">{tr("汇率", "FX")}</label>
                          <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFxRate} onChange={(e) => setAssistEditFxRate(Number(e.target.value) || 1)} type="number" step="0.0001" />
                        </div>
                        <div className="md:col-span-4">
                          <label className="text-xs text-zinc-600">{tr("备注", "Memo")}</label>
                          <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditMemo} onChange={(e) => setAssistEditMemo(e.target.value)} />
                        </div>
                      </div>

                      <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
                        <table className="w-full text-sm">
                          <thead className="bg-zinc-50 text-xs text-zinc-600">
                            <tr>
                              <th className="px-3 py-2 text-left">{tr("科目", "Account")}</th>
                              <th className="px-3 py-2 text-left">{tr("摘要", "Description")}</th>
                              <th className="px-3 py-2 text-left">{tr("Cost Center", "Cost Center")}</th>
                              <th className="px-3 py-2 text-right">{tr("借", "Debit")}</th>
                              <th className="px-3 py-2 text-right">{tr("贷", "Credit")}</th>
                              <th className="px-3 py-2 text-right">{tr("操作", "Action")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {assistEditLines.map((l, i) => (
                              <tr key={i} className="border-t border-zinc-100">
                                <td className="px-3 py-2">
                                  <select
                                    className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                                    value={l.accountId}
                                    onChange={(e) => {
                                      const nextId = e.target.value;
                                      setAssistEditLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, accountId: nextId } : x)));
                                      const acc = accountById.get(nextId);
                                      if ((acc as any)?.linkFixedAssets) {
                                        setAssistEditFaPurchase((prev) =>
                                          prev
                                            ? { ...prev, lineIdx: i, acquisitionDate: assistEditEntryDate || prev.acquisitionDate }
                                            : {
                                                lineIdx: i,
                                                category: "",
                                                assetNo: "",
                                                name: tr("固定资产", "Fixed asset"),
                                                acquisitionDate: assistEditEntryDate || draftDate,
                                                usefulLifeMonths: "60",
                                                salvageBase: "0",
                                              },
                                        );
                                      }
                                    }}
                                  >
                                    <option value="">{tr("请选择", "Select")}</option>
                                    {(() => {
                                      const sel = accountById.get(l.accountId);
                                      const list = sel && (sel as any).isActive === false ? [sel, ...activeAccounts.filter((a) => a.id !== sel.id)] : activeAccounts;
                                      return list.map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.code} {a.name}{(a as any).isActive === false ? tr("（已删除）", " (inactive)") : ""}
                                        </option>
                                      ));
                                    })()}
                                  </select>
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                                    value={l.description}
                                    onChange={(e) => setAssistEditLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, description: e.target.value } : x)))}
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <select
                                    className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                                    value={l.costCenterId}
                                    onChange={(e) => setAssistEditLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, costCenterId: e.target.value } : x)))}
                                  >
                                    <option value="">{tr("(无)", "(None)")}</option>
                                    {costCenters.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.code} {c.name}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-right"
                                    value={l.debitTxn}
                                    onChange={(e) => setAssistEditLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, debitTxn: e.target.value, creditTxn: "" } : x)))}
                                    inputMode="decimal"
                                  />
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-right"
                                    value={l.creditTxn}
                                    onChange={(e) => setAssistEditLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, creditTxn: e.target.value, debitTxn: "" } : x)))}
                                    inputMode="decimal"
                                  />
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <button
                                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                                    disabled={assistEditLines.length <= 2}
                                    onClick={() => setAssistEditLines((prev) => prev.filter((_, idx) => idx !== i))}
                                    type="button"
                                  >
                                    {tr("删除", "Remove")}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                          onClick={() => setAssistEditLines((prev) => [...prev, { accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" }])}
                          type="button"
                        >
                          {tr("增加行", "Add line")}
                        </button>
                        <div className="text-zinc-600">
                          {(() => {
                            const debit = assistEditLines.reduce((s, x) => s + (Number(x.debitTxn) || 0), 0);
                            const credit = assistEditLines.reduce((s, x) => s + (Number(x.creditTxn) || 0), 0);
                            const diff = Math.round((debit - credit) * 100) / 100;
                            return tr("差额：", "Diff: ") + diff.toFixed(2) + " " + (assistEditCurrency || baseCurrency);
                          })()}
                        </div>
                      </div>

                      {(() => {
                        const needsInv = assistEditLines.some((x) => {
                          const acc = accountById.get(x.accountId);
                          return Boolean((acc as any)?.linkInventoryFifo);
                        });
                        const show = needsInv || assistEditInvDetails.length > 0;
                        if (!show) return null;
                        return (
                          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-sm font-semibold">{tr("库存 FIFO 明细（可选）", "Inventory FIFO details (optional)")}</div>
                              <div className="flex items-center gap-2">
                                <button
                                  className={assistEditInvMode === "receipt" ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white" : "rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"}
                                  onClick={() => setAssistEditInvMode("receipt")}
                                  type="button"
                                >
                                  {tr("入库", "Receipt")}
                                </button>
                                <button
                                  className={assistEditInvMode === "shipment" ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white" : "rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"}
                                  onClick={() => setAssistEditInvMode("shipment")}
                                  type="button"
                                >
                                  {tr("出库", "Shipment")}
                                </button>
                              </div>
                            </div>

                            <div className="mt-3 grid gap-3 md:grid-cols-3">
                              <div>
                                <label className="text-xs text-zinc-600">{tr("关联分录行", "Link line")}</label>
                                <select
                                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                                  value={assistEditInvLinkLineNo}
                                  onChange={(e) => setAssistEditInvLinkLineNo(Number(e.target.value) || 1)}
                                >
                                  {Array.from({ length: Math.max(assistEditLines.length, 1) }, (_, idx) => idx + 1).map((n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
                              <table className="w-full text-sm">
                                <thead className="bg-zinc-50 text-xs text-zinc-600">
                                  <tr>
                                    <th className="px-3 py-2 text-left">{tr("库存项目", "Item")}</th>
                                    <th className="px-3 py-2 text-right">{tr("数量", "Qty")}</th>
                                    <th className="px-3 py-2 text-right">{tr("单价（交易币）", "Unit (txn)")}</th>
                                    <th className="px-3 py-2 text-right">{tr("操作", "Action")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {assistEditInvDetails.map((d) => (
                                    <tr key={d.rowId} className="border-t border-zinc-100">
                                      <td className="px-3 py-2">
                                        <select
                                          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm"
                                          value={d.itemId}
                                          onChange={(e) => setAssistEditInvDetails((prev) => prev.map((x) => (x.rowId === d.rowId ? { ...x, itemId: e.target.value } : x)))}
                                        >
                                          <option value="">{tr("请选择", "Select")}</option>
                                          {inventoryItems.map((it) => (
                                            <option key={it.id} value={it.id}>
                                              {it.sku ? `${it.sku} ` : ""}{it.name}
                                            </option>
                                          ))}
                                        </select>
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <input
                                          className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-right"
                                          value={d.qty}
                                          onChange={(e) => setAssistEditInvDetails((prev) => prev.map((x) => (x.rowId === d.rowId ? { ...x, qty: e.target.value } : x)))}
                                          inputMode="numeric"
                                        />
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        {assistEditInvMode === "receipt" ? (
                                          <input
                                            className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm text-right"
                                            value={d.unitCostTxn}
                                            onChange={(e) => setAssistEditInvDetails((prev) => prev.map((x) => (x.rowId === d.rowId ? { ...x, unitCostTxn: e.target.value } : x)))}
                                            inputMode="decimal"
                                          />
                                        ) : (
                                          <span className="text-xs text-zinc-500">-</span>
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <button
                                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                                          onClick={() => setAssistEditInvDetails((prev) => prev.filter((x) => x.rowId !== d.rowId))}
                                          type="button"
                                        >
                                          {tr("删除", "Remove")}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            <div className="mt-2">
                              <button
                                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                                onClick={() => setAssistEditInvDetails((prev) => [...prev, { rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: "1", unitCostTxn: "" }])}
                                type="button"
                              >
                                {tr("增加明细", "Add detail")}
                              </button>
                            </div>
                          </div>
                        );
                      })()}

                      {assistEditFaPurchase ? (
                        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-3">
                          <div className="text-sm font-semibold">{tr("固定资产信息（可选）", "Fixed asset info (optional)")}</div>
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <div>
                              <label className="text-xs text-zinc-600">{tr("大类", "Category")}</label>
                              <select
                                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                                value={assistEditFaPurchase.category}
                                onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, category: e.target.value } : p))}
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
                              <label className="text-xs text-zinc-600">{tr("编号（可选）", "Asset no (optional)")}</label>
                              <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFaPurchase.assetNo} onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, assetNo: e.target.value } : p))} />
                            </div>
                            <div className="md:col-span-2">
                              <label className="text-xs text-zinc-600">{tr("资产名称", "Name")}</label>
                              <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFaPurchase.name} onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, name: e.target.value } : p))} />
                            </div>
                            <div>
                              <label className="text-xs text-zinc-600">{tr("购置日", "Acquisition date")}</label>
                              <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFaPurchase.acquisitionDate} onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, acquisitionDate: e.target.value } : p))} />
                            </div>
                            <div>
                              <label className="text-xs text-zinc-600">{tr("使用年限（月）", "Useful life (months)")}</label>
                              <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFaPurchase.usefulLifeMonths} onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, usefulLifeMonths: e.target.value } : p))} type="number" step="1" />
                            </div>
                            <div>
                              <label className="text-xs text-zinc-600">{tr("残值（本位）", "Salvage (base)")}</label>
                              <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assistEditFaPurchase.salvageBase} onChange={(e) => setAssistEditFaPurchase((p) => (p ? { ...p, salvageBase: e.target.value } : p))} type="number" step="0.01" />
                            </div>
                          </div>
                        </div>
                      ) : null}

                    </>
                  ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 bg-white p-4">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={assistBusy}
                  onClick={() => resetAssistSuggestion()}
                  type="button"
                >
                  {tr("重新生成", "Reset")}
                </button>
                <button
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
                  disabled={assistBusy || !(assistSuggestion as any)?.draft}
                  onClick={() => confirmAssistFill()}
                  type="button"
                >
                  {tr("确认并填入分录", "Confirm & fill")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {faPurchaseOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
            onMouseDown={() => {
              setErr(null);
              setFaPurchaseOpen(false);
            }}
          >
            <div
              className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">{tr("新增资产（随分录过账生成记录）", "New asset (created when posting)")}</div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaPurchaseOpen(false);
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-xs text-zinc-600">{tr("大类", "Category")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                    value={faPurchaseForm.category}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, category: e.target.value })}
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
                    value={faPurchaseForm.assetNo}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, assetNo: e.target.value.toUpperCase() })}
                    placeholder={
                      faPurchaseForm.category
                        ? tr("例如：FA-COM00001", "e.g., FA-COM00001")
                        : tr("请先选择大类", "Please select a category first")
                    }
                  />
                  <div className="mt-1 text-xs text-zinc-500">{tr("留空则系统自动生成（按大类递增）。", "Leave empty to auto-generate (increment by category).")}</div>
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("名称", "Name")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.name}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("购置日", "Acquisition date")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.acquisitionDate}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, acquisitionDate: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("金额（交易币）", "Amount (txn currency)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.costTxn}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, costTxn: Number(e.target.value) || 0 })}
                    type="number"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("币种", "Currency")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.currency}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, currency: e.target.value.toUpperCase() })}
                    maxLength={3}
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("汇率", "FX rate")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.fxRate}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, fxRate: Number(e.target.value) || 1 })}
                    type="number"
                    step="0.0001"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("折旧月数", "Useful life (months)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.usefulLifeMonths}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, usefulLifeMonths: Number(e.target.value) || 0 })}
                    type="number"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("残值（本位）", "Salvage (base)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.salvageBase}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, salvageBase: Number(e.target.value) || 0 })}
                    type="number"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("贷方科目（现金/应付）", "Credit account (Cash/AP)")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                    value={faPurchaseForm.offsetAccountId}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, offsetAccountId: e.target.value })}
                  >
                    <option value="">{tr("请选择", "Select")}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">{tr("备注", "Memo")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faPurchaseForm.memo}
                    onChange={(e) => setFaPurchaseForm({ ...faPurchaseForm, memo: e.target.value })}
                  />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaPurchaseOpen(false);
                  }}
                  type="button"
                >
                  {tr("取消", "Cancel")}
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={
                    busy ||
                    !faPurchaseForm.category.trim() ||
                    !faPurchaseForm.offsetAccountId ||
                    !faPurchaseForm.acquisitionDate.trim() ||
                    !faPurchaseForm.currency.trim() ||
                    !(Number(faPurchaseForm.costTxn) > 0) ||
                    !(Number(faPurchaseForm.usefulLifeMonths) > 0)
                  }
                  onClick={() => {
                    setErr(null);
                    const lineIdx = faPurchaseLineIdx;
                    if (lineIdx == null) {
                      setErr(tr("保存失败：未关联分录行", "Save failed: not linked to a journal line."));
                      return;
                    }

                    const costTxn = Number(faPurchaseForm.costTxn) || 0;
                    if (!(costTxn > 0)) {
                      setErr(tr("金额必须大于 0", "Amount must be greater than 0."));
                      return;
                    }

                    const memo = String(faPurchaseForm.memo || "").trim();

                    setDraftDate(faPurchaseForm.acquisitionDate);
                    setDraftCurrency(String(faPurchaseForm.currency || "").toUpperCase());
                    setDraftFx(Number(faPurchaseForm.fxRate) || 1);
                    if (memo) {
                      setDraftMemo(memo);
                    }

                    setFaPurchaseByLineIdx((prev) => {
                      const next = { ...prev } as Record<
                        number,
                        {
                          category: string;
                          assetNo: string;
                          name: string;
                          acquisitionDate: string;
                          usefulLifeMonths: number;
                          salvageBase: number;
                          memo: string;
                        }
                      >;
                      next[lineIdx] = {
                        category: String(faPurchaseForm.category || "").trim(),
                        assetNo: String(faPurchaseForm.assetNo || "").trim().toUpperCase(),
                        name: faPurchaseForm.name.trim() || tr("(未命名资产)", "(Unnamed asset)"),
                        acquisitionDate: faPurchaseForm.acquisitionDate,
                        usefulLifeMonths: Number(faPurchaseForm.usefulLifeMonths) || 0,
                        salvageBase: Number(faPurchaseForm.salvageBase) || 0,
                        memo: memo,
                      };
                      return next;
                    });

                    const next = [...draftLines];
                    const debitLine = next[lineIdx];
                    if (!debitLine) {
                      setErr(tr("保存失败：分录行不存在", "Save failed: journal line not found."));
                      return;
                    }
                    next[lineIdx] = {
                      ...debitLine,
                      debitTxn: costTxn.toFixed(2),
                      creditTxn: "",
                    };

                    const targetAccountId = faPurchaseForm.offsetAccountId;
                    const isEmptyLine = (l: { accountId: string; description: string; costCenterId: string; debitTxn: string; creditTxn: string }) =>
                      !l.accountId && !l.description && !l.costCenterId && !l.debitTxn && !l.creditTxn;

                    let creditIdx = next.findIndex((l, i) => i !== lineIdx && l.accountId === targetAccountId);
                    if (creditIdx < 0) {
                      creditIdx = next.findIndex((l, i) => i !== lineIdx && isEmptyLine(l));
                    }
                    if (creditIdx < 0 && next.length === 2) {
                      creditIdx = lineIdx === 0 ? 1 : 0;
                    }
                    if (creditIdx < 0) {
                      creditIdx = next.length;
                      next.push({ accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" });
                    }

                    const creditLine = next[creditIdx];
                    next[creditIdx] = {
                      ...creditLine,
                      accountId: targetAccountId,
                      creditTxn: costTxn.toFixed(2),
                      debitTxn: "",
                    };

                    setDraftLines(next);
                    setFaPurchaseOpen(false);
                  }}
                  type="button"
                >
                  {tr("保存草稿", "Save draft")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {faDepOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
            onMouseDown={() => {
              setErr(null);
              setFaDepOpen(false);
            }}
          >
            <div
              className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">{tr("折旧（选择资产）", "Depreciation")}</div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaDepOpen(false);
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">{tr("折旧资产", "Asset")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                    value={faDepForm.assetId}
                    onChange={(e) => setFaDepForm({ ...faDepForm, assetId: e.target.value })}
                  >
                    <option value="">{tr("请选择", "Select")}</option>
                    {fixedAssets
                      .filter((a) => a.status === "active")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {(a.assetNo ? `${a.assetNo} · ` : "") + a.name + (a.category ? ` (${a.category})` : "")}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-zinc-600">{tr("金额（交易币）", "Amount (txn currency)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faDepForm.amountTxn}
                    onChange={(e) => setFaDepForm({ ...faDepForm, amountTxn: Number(e.target.value) || 0 })}
                    type="number"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("币种", "Currency")}</label>
                  <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftCurrency} disabled />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaDepOpen(false);
                  }}
                  type="button"
                >
                  {tr("取消", "Cancel")}
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={busy || !faDepForm.assetId || !(Number(faDepForm.amountTxn) > 0) || faDepLineIdx == null}
                  onClick={() => {
                    setErr(null);
                    const lineIdx = faDepLineIdx;
                    if (lineIdx == null) {
                      setErr(tr("保存失败：未关联分录行", "Save failed: not linked to a journal line."));
                      return;
                    }
                    const amountTxn = Number(faDepForm.amountTxn) || 0;
                    if (!(amountTxn > 0)) {
                      setErr(tr("金额必须大于 0", "Amount must be greater than 0."));
                      return;
                    }
                    const asset = fixedAssets.find((x) => x.id === faDepForm.assetId);
                    if (!asset || asset.status !== "active") {
                      setErr(tr("资产无效", "Invalid asset."));
                      return;
                    }
                    if (!asset.depExpenseAccountId || !asset.accumDepAccountId) {
                      setErr(tr("该资产缺少折旧科目设置", "This asset is missing depreciation account setup."));
                      return;
                    }

                    const next = [...draftLines];
                    const debitLine = next[lineIdx];
                    if (!debitLine) {
                      setErr(tr("保存失败：分录行不存在", "Save failed: journal line not found."));
                      return;
                    }
                    next[lineIdx] = {
                      ...debitLine,
                      accountId: asset.depExpenseAccountId,
                      debitTxn: amountTxn.toFixed(2),
                      creditTxn: "",
                    };

                    const isEmptyLine = (l: { accountId: string; description: string; costCenterId: string; debitTxn: string; creditTxn: string }) =>
                      !l.accountId && !l.description && !l.costCenterId && !l.debitTxn && !l.creditTxn;

                    let creditIdx = next.findIndex((l, i) => i !== lineIdx && l.accountId === asset.accumDepAccountId);
                    if (creditIdx < 0) {
                      creditIdx = next.findIndex((l, i) => i !== lineIdx && isEmptyLine(l));
                    }
                    if (creditIdx < 0 && next.length === 2) {
                      creditIdx = lineIdx === 0 ? 1 : 0;
                    }
                    if (creditIdx < 0) {
                      creditIdx = next.length;
                      next.push({ accountId: "", description: "", costCenterId: "", debitTxn: "", creditTxn: "" });
                    }
                    const creditLine = next[creditIdx];
                    next[creditIdx] = {
                      ...creditLine,
                      accountId: asset.accumDepAccountId,
                      creditTxn: amountTxn.toFixed(2),
                      debitTxn: "",
                    };

                    setDraftLines(next);
                    setFixedAssetIdByLineIdx((prev) => ({
                      ...prev,
                      [lineIdx]: asset.id,
                      [creditIdx]: asset.id,
                    }));
                    setFaDepOpen(false);
                  }}
                  type="button"
                >
                  {tr("保存草稿", "Save draft")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {faDisposeOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
            onMouseDown={() => {
              setErr(null);
              setFaDisposeOpen(false);
            }}
          >
            <div
              className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl"
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">{tr("处置（选择资产）", "Disposal")}</div>
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaDisposeOpen(false);
                  }}
                  type="button"
                >
                  {tr("关闭", "Close")}
                </button>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">{tr("处置资产", "Asset")}</label>
                  <select
                    className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                    value={faDisposeForm.assetId}
                    onChange={async (e) => {
                      const id = e.target.value;
                      setFaDisposeForm((prev) => ({ ...prev, assetId: id }));
                      if (!id) return;
                      try {
                        const snap = await api<{ costBase: number; accumDepBase: number }>(
                          `/api/fixed-assets/${encodeURIComponent(id)}/disposal-snapshot?date=${encodeURIComponent(draftDate)}`,
                        );
                        const base = faDisposeKind === "cost" ? Number(snap.costBase || 0) : Number(snap.accumDepBase || 0);
                        const txn = (Number(draftFx) || 1) > 0 ? Math.round((base / (Number(draftFx) || 1)) * 100) / 100 : Math.round(base * 100) / 100;
                        setFaDisposeForm((prev) => ({ ...prev, amountTxn: txn }));
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <option value="">{tr("请选择", "Select")}</option>
                    {fixedAssets
                      .filter((a) => a.status === "active")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {(a.assetNo ? `${a.assetNo} · ` : "") + a.name + (a.category ? ` (${a.category})` : "")}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-zinc-600">{tr("类型", "Type")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faDisposeKind === "cost" ? tr("成本（16xx）", "Cost (16xx)") : tr("累计折旧（161x）", "Accum dep (161x)")}
                    disabled
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">{tr("金额（交易币）", "Amount (txn currency)")}</label>
                  <input
                    className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={faDisposeForm.amountTxn}
                    onChange={(e) => setFaDisposeForm({ ...faDisposeForm, amountTxn: Number(e.target.value) || 0 })}
                    type="number"
                    step="0.01"
                  />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setErr(null);
                    setFaDisposeOpen(false);
                  }}
                  type="button"
                >
                  {tr("取消", "Cancel")}
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={busy || !faDisposeForm.assetId || !(Number(faDisposeForm.amountTxn) > 0) || faDisposeLineIdx == null}
                  onClick={() => {
                    setErr(null);
                    const lineIdx = faDisposeLineIdx;
                    if (lineIdx == null) {
                      setErr(tr("保存失败：未关联分录行", "Save failed: not linked to a journal line."));
                      return;
                    }
                    const amountTxn = Number(faDisposeForm.amountTxn) || 0;
                    if (!(amountTxn > 0)) {
                      setErr(tr("金额必须大于 0", "Amount must be greater than 0."));
                      return;
                    }
                    const asset = fixedAssets.find((x) => x.id === faDisposeForm.assetId);
                    if (!asset || asset.status !== "active") {
                      setErr(tr("资产无效", "Invalid asset."));
                      return;
                    }
                    if (faDisposeKind === "cost") {
                      if (!asset.assetAccountId) {
                        setErr(tr("该资产缺少资产科目设置", "This asset is missing asset account setup."));
                        return;
                      }
                      if (faDisposeAccumLineIdx != null) {
                        const otherId = fixedAssetIdByLineIdx[faDisposeAccumLineIdx];
                        if (otherId && otherId !== asset.id) {
                          setErr(tr("处置的成本与累计折旧必须选择同一个固定资产", "Cost and accumulated depreciation must reference the same asset."));
                          return;
                        }
                      }
                      const next = [...draftLines];
                      const line = next[lineIdx];
                      if (!line) {
                        setErr(tr("保存失败：分录行不存在", "Save failed: journal line not found."));
                        return;
                      }
                      next[lineIdx] = { ...line, accountId: asset.assetAccountId, creditTxn: amountTxn.toFixed(2), debitTxn: "" };
                      setDraftLines(next);
                      setFixedAssetIdByLineIdx((prev) => ({ ...prev, [lineIdx]: asset.id }));
                      setFaDisposeCostLineIdx(lineIdx);
                    } else {
                      if (!asset.accumDepAccountId) {
                        setErr(tr("该资产缺少累计折旧科目设置", "This asset is missing accumulated depreciation account setup."));
                        return;
                      }
                      if (faDisposeCostLineIdx != null) {
                        const otherId = fixedAssetIdByLineIdx[faDisposeCostLineIdx];
                        if (otherId && otherId !== asset.id) {
                          setErr(tr("处置的成本与累计折旧必须选择同一个固定资产", "Cost and accumulated depreciation must reference the same asset."));
                          return;
                        }
                      }
                      const next = [...draftLines];
                      const line = next[lineIdx];
                      if (!line) {
                        setErr(tr("保存失败：分录行不存在", "Save failed: journal line not found."));
                        return;
                      }
                      next[lineIdx] = { ...line, accountId: asset.accumDepAccountId, debitTxn: amountTxn.toFixed(2), creditTxn: "" };
                      setDraftLines(next);
                      setFixedAssetIdByLineIdx((prev) => ({ ...prev, [lineIdx]: asset.id }));
                      setFaDisposeAccumLineIdx(lineIdx);
                    }
                    setFaDisposeOpen(false);
                  }}
                  type="button"
                >
                  {tr("保存草稿", "Save draft")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{tr("凭证列表", "Journals")}</div>
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
              onClick={() => refresh()}
              type="button"
            >
              {tr("刷新", "Refresh")}
            </button>
          </div>
          <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                <tr>
                  <th className="px-3 py-2 text-left">{tr("日期", "Date")}</th>
                  <th className="px-3 py-2 text-left">{tr("分录号", "Voucher No")}</th>
                  <th className="px-3 py-2 text-left">{tr("状态", "Status")}</th>
                  <th className="px-3 py-2 text-left">{tr("库存", "Inventory")}</th>
                  <th className="px-3 py-2 text-left">{tr("币种", "Currency")}</th>
                  <th className="px-3 py-2 text-right">{tr("金额", "Amount")}</th>
                  <th className="px-3 py-2 text-right">{tr("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    className={
                      "cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 " +
                      (e.isSystem ? "bg-amber-50/40 " : "") +
                      (selectedId === e.id ? "bg-blue-50" : "")
                    }
                    onClick={() => {
                      if (editingEntryId && editingEntryId !== e.id) {
                        setErr(tr("请先保存或取消当前编辑。", "Please save or cancel the current edit first."));
                        return;
                      }
                      setSelectedId(e.id);
                    }}
                  >
                    <td className="px-3 py-2">{e.entryDate}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span>{e.voucherNo || "-"}</span>
                        {e.isSystem ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{tr("系统", "System")}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs " +
                          (e.status === "posted" ? "bg-green-50 text-green-700" : "bg-zinc-100 text-zinc-700")
                        }
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm">{e.inventoryImpact ? tr("是", "Yes") : ""}</td>
                    <td className="px-3 py-2 text-sm">{e.currency}</td>
                    <td className="px-3 py-2 text-right">
                      {(() => {
                        const amt = Number(e.totalDebitTxn);
                        return Number.isFinite(amt) ? amt.toFixed(2) : "-";
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={busy || Boolean(e.isSystem)}
                          type="button"
                          onClick={async (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (e.status === "draft") {
                              await loadDraftForPosting(e.id);
                              return;
                            }
                            await openEditModal(e.id);
                          }}
                        >
                          {e.status === "draft" ? tr("新建", "New") : tr("编辑", "Edit")}
                        </button>
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={busy || Boolean(e.isSystem)}
                          type="button"
                          onClick={async (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (editingEntryId) {
                              setErr(tr("请先保存或取消当前编辑。", "Please save or cancel the current edit first."));
                              return;
                            }
                            const ok = window.confirm(
                              e.status === "posted"
                                ? tr(
                                    "确认删除该已过账凭证？删除会回滚库存/FIFO 并影响报表。",
                                    "Delete this posted journal? This will rollback inventory/FIFO and affect reports.",
                                  )
                                : tr("确认删除该草稿凭证？", "Delete this draft journal?"),
                            );
                            if (!ok) return;
                            setBusy(true);
                            setErr(null);
                            try {
                              await deleteEntry(e.id);
                            } catch (err: any) {
                              setErr(err.message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {tr("删除", "Delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm" ref={detailRef}>
            <div className="text-sm font-semibold">凭证详情</div>
            {detail ? (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-zinc-600">
                    {detail.entry.entryDate} · {detail.entry.voucherNo || "-"} · {detail.entry.status} · {detail.entry.currency} @ {detail.entry.fxRate}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
                      disabled={busy}
                      onClick={async () => {
                        if (editingEntryId && editingEntryId !== detail.entry.id) {
                          setErr("请先保存或取消当前编辑。");
                          return;
                        }
                        await openEditModal(detail.entry.id);
                      }}
                      type="button"
                    >
                      编辑
                    </button>
                    {detail.entry.status === "draft" ? (
                      <button
                        className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                        disabled={busy}
                        onClick={async () => {
                          if (editingEntryId) {
                            setErr("请先保存或取消当前编辑。");
                            return;
                          }
                          const ok = window.confirm("确认过账该草稿凭证？过账后会影响报表与库存（如有）。");
                          if (!ok) return;
                          setBusy(true);
                          setErr(null);
                          try {
                            await api(`/api/journals/${encodeURIComponent(detail.entry.id)}/post` as any, { method: "POST" });
                            await refresh();
                            await loadDetail(detail.entry.id);
                          } catch (e: any) {
                            setErr(e.message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                        type="button"
                      >
                        过账
                      </button>
                    ) : null}
                    <button
                      className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50"
                      disabled={busy}
                      onClick={async () => {
                        if (editingEntryId) {
                          setErr("请先保存或取消当前编辑。");
                          return;
                        }
                        const ok = window.confirm(
                          detail.entry.status === "posted" ? "确认删除该已过账凭证？删除会回滚库存/FIFO 并影响报表。" : "确认删除该草稿凭证？",
                        );
                        if (!ok) return;
                        setBusy(true);
                        setErr(null);
                        try {
                          await deleteEntry(detail.entry.id);
                        } catch (e: any) {
                          setErr(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="overflow-auto rounded-lg border border-zinc-100">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 text-xs text-zinc-600">
                      <tr>
                        <th className="px-3 py-2 text-left">行</th>
                        <th className="px-3 py-2 text-left">科目</th>
                        <th className="px-3 py-2 text-right">借</th>
                        <th className="px-3 py-2 text-right">贷</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((l) => {
                        const acc = accounts.find((a) => a.id === l.accountId);
                        const isAuto = l.lineNo > 2 && (String(acc?.code || "") === "5000" || String(acc?.code || "") === "1500");
                        return (
                          <tr key={l.id} className={"border-t border-zinc-100 " + (isAuto ? "bg-amber-50" : "")}>
                            <td className="px-3 py-2">{l.lineNo}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0 flex-1">{acc ? `${acc.code} ${acc.name}` : l.accountId}</div>
                                {isAuto ? <span className="whitespace-nowrap text-xs text-amber-800">系统自动生成</span> : null}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">{Number(l.debitTxn).toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{Number(l.creditTxn).toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div>
                  <div className="mb-2 text-xs text-zinc-600">附件</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      className="block w-full text-sm"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        setBusy(true);
                        setErr(null);
                        try {
                          await api(`/api/journals/${detail.entry.id}/attachments`, { method: "POST", body: fd });
                          await loadDetail(detail.entry.id);
                        } catch (e: any) {
                          setErr(e.message);
                        } finally {
                          setBusy(false);
                          e.target.value = "";
                        }
                      }}
                    />
                  </div>
                  <div className="mt-2 space-y-1">
                    {detail.attachments.map((a) => (
                      <a
                        key={a.id}
                        className="block rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                        href={`/api/journals/${detail.entry.id}/attachments/${a.id}`}
                      >
                        {a.fileName}
                      </a>
                    ))}
                  </div>
                </div>

                {err ? <div className="text-sm text-red-700">{err}</div> : null}
              </div>
            ) : (
              <div className="mt-2 text-sm text-zinc-500">选择左侧一条凭证查看详情</div>
            )}
          </div>
      </div>

      {invModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-xl bg-white p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold">库存明细</div>
                <button
                  className={
                    "rounded-full px-3 py-1 text-sm " +
                    (invMode === "receipt" ? "bg-blue-700 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")
                  }
                  type="button"
                  onClick={() => {
                    setInvMode("receipt");
                    setInvConfirmed(null);
                    setInvQuoteByRow({});
                  }}
                >
                  入库
                </button>
                <button
                  className={
                    "rounded-full px-3 py-1 text-sm " +
                    (invMode === "shipment" ? "bg-blue-700 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")
                  }
                  type="button"
                  onClick={() => {
                    setInvMode("shipment");
                    setInvConfirmed(null);
                    setInvQuoteByRow({});
                  }}
                >
                  出库
                </button>
              </div>

              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                  value={invLineIdx == null ? "" : `line:${invLineIdx}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    setInvConfirmed(null);
                    setInvQuoteByRow({});
                    if (!v) {
                      setInvLineIdx(null);
                      setInvExpectedTxn(0);
                      setInvExpectedBase(0);
                      return;
                    }

                    let nextIdx: number | null = null;
                    if (v.startsWith("line:")) {
                      nextIdx = Number(v.slice("line:".length));
                    }
                    if (v.startsWith("acc:")) {
                      const accId = v.slice("acc:".length);
                      const idx = draftLines.findIndex((l) => l.accountId === accId);
                      nextIdx = idx >= 0 ? idx : null;
                    }

                    setInvLineIdx(nextIdx);
                    if (nextIdx == null) return;

                    const line = draftLines[nextIdx];
                    const debit = Number(line?.debitTxn) || 0;
                    const credit = Number(line?.creditTxn) || 0;
                    if (debit > 0 && credit <= 0) setInvDefaultSide("debit");
                    if (credit > 0 && debit <= 0) setInvDefaultSide("credit");
                    const side = debit > 0 && credit <= 0 ? "debit" : credit > 0 && debit <= 0 ? "credit" : invDefaultSide;
                    const amt = side === "debit" ? debit : credit;
                    setInvExpectedTxn(amt);
                    setInvExpectedBase(Math.round(amt * draftFx * 100) / 100);
                  }}
                >
                  <option value="">绑定分录行/科目</option>
                  <optgroup label="分录行">
                    {draftLines.map((l, idx) => {
                      const acc = accounts.find((a) => a.id === l.accountId);
                      const debit = Number(l.debitTxn) || 0;
                      const credit = Number(l.creditTxn) || 0;
                      const label = acc ? `${acc.code} ${acc.name}` : "(未选择科目)";
                      const amt = debit > 0 ? `借 ${debit}` : credit > 0 ? `贷 ${credit}` : "金额 0";
                      return (
                        <option key={`line-${idx}`} value={`line:${idx}`}>
                          {idx + 1}. {label} · {amt}
                        </option>
                      );
                    })}
                  </optgroup>
                  <optgroup label="科目 (Account)">
                    {Array.from(
                      new Set(
                        draftLines
                          .map((l) => l.accountId)
                          .filter((x): x is string => typeof x === "string" && x.trim().length > 0),
                      ),
                    ).map((accId) => {
                      const acc = accounts.find((a) => a.id === accId);
                      const label = acc ? `${acc.code} ${acc.name}` : accId;
                      return (
                        <option key={`acc-${accId}`} value={`acc:${accId}`}>
                          {label}
                        </option>
                      );
                    })}
                  </optgroup>
                </select>

                <div className="text-xs text-zinc-500">分录金额：{invExpectedTxn.toFixed(2)} {draftCurrency}</div>
              </div>
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="w-80 px-3 py-2 text-left">商品</th>
                    <th className="w-28 px-3 py-2 text-right">数量</th>
                    {invMode === "receipt" ? <th className="px-3 py-2 text-right">单价({draftCurrency})</th> : <th className="px-3 py-2 text-right">FIFO 成本({baseCurrency})</th>}
                    <th className="w-36 px-3 py-2 text-right">{invMode === "shipment" ? `总成本(${draftCurrency})` : "金额"}</th>
                    <th className="w-20 px-3 py-2 text-left">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {invEditingDetails.map((r) => {
                    const q = invQuoteByRow[r.rowId];
                    const qty = Number(r.qty) || 0;
                    const unit = Number(r.unitCostTxn) || 0;
                    const amtTxn = Math.round(qty * unit * 100) / 100;
                    const costBase = q?.base == null ? null : Number(q.base);
                    const costTxn = costBase == null ? null : Math.round((costBase / (draftFx || 1)) * 100) / 100;
                    return (
                      <tr key={r.rowId} className="border-t border-zinc-100">
                        <td className="px-3 py-2">
                          <select
                            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                            value={r.itemId}
                            onChange={(e) => {
                              const next = invEditingDetails.map((x) => (x.rowId === r.rowId ? { ...x, itemId: e.target.value } : x));
                              setInvEditingDetails(next);
                            }}
                          >
                            <option value="">请选择</option>
                            {inventoryItems.map((it) => (
                              <option key={it.id} value={it.id}>
                                {((it.sku ? `${it.sku} ` : "") + it.name).replace(/\s+/g, " ").trim()}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="w-full rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                            type="number"
                            step="1"
                            value={r.qty}
                            onChange={(e) => {
                              const next = invEditingDetails.map((x) => (x.rowId === r.rowId ? { ...x, qty: e.target.value } : x));
                              setInvEditingDetails(next);
                            }}
                          />
                        </td>
                        {invMode === "receipt" ? (
                          <td className="px-3 py-2 text-right">
                            <input
                              className="w-full rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                              type="number"
                              step="0.01"
                              value={r.unitCostTxn}
                              onChange={(e) => {
                                const next = invEditingDetails.map((x) => (x.rowId === r.rowId ? { ...x, unitCostTxn: e.target.value } : x));
                                setInvEditingDetails(next);
                              }}
                            />
                          </td>
                        ) : (
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {q?.err ? <span className="text-red-700">{q.err}</span> : costBase == null ? "-" : `${costBase.toFixed(2)} ${baseCurrency}`}
                          </td>
                        )}
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {invMode === "receipt" ? `${amtTxn.toFixed(2)} ${draftCurrency}` : costTxn == null ? "-" : `${costTxn.toFixed(2)} ${draftCurrency}`}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                            disabled={invEditingDetails.length <= 1}
                            onClick={() => {
                              setInvEditingDetails(invEditingDetails.filter((x) => x.rowId !== r.rowId));
                              setInvQuoteByRow((prev) => {
                                const next = { ...prev };
                                delete next[r.rowId];
                                return next;
                              });
                            }}
                            type="button"
                          >
                            删除
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
                <div>
                  明细合计：{invEditingTotals.totalTxn.toFixed(2)} {draftCurrency}；分录金额：{invExpectedTxn.toFixed(2)} {draftCurrency}
                </div>
                {Math.round(invEditingTotals.totalTxn * 100) / 100 !== Math.round(invExpectedTxn * 100) / 100 ? (
                  <div className="mt-1 text-sm text-red-700">明细合计必须与绑定的分录行金额一致。</div>
                ) : null}
              </div>
            ) : (
              <div className="mt-3 text-sm">
                {(() => {
                  const totalCostBase = invEditingTotals.totalQuoteBase;
                  const totalCostTxn = Math.round((totalCostBase / (draftFx || 1)) * 100) / 100;
                  const profitTxn = Math.round((invExpectedTxn - totalCostTxn) * 100) / 100;
                  return (
                    <div>
                      分录金额 {invExpectedTxn.toFixed(2)} {draftCurrency} − 总成本 {totalCostTxn.toFixed(2)} {draftCurrency} = 利润 {profitTxn.toFixed(2)} {draftCurrency}
                    </div>
                  );
                })()}
                {invEditingDetails.some((r) => invQuoteByRow[r.rowId]?.err) ? (
                  <div className="mt-1 text-sm text-red-700">存在库存不足或数据错误，请调整商品/数量。</div>
                ) : null}
                {invEditingDetails.some((r) => r.itemId && (Number(r.qty) || 0) > 0 && invQuoteByRow[r.rowId]?.base == null && !invQuoteByRow[r.rowId]?.err) ? (
                  <div className="mt-1 text-xs text-zinc-500">正在计算 FIFO 成本…</div>
                ) : null}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => {
                  setInvEditingDetails([
                    ...invEditingDetails,
                    { rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: "1", unitCostTxn: invMode === "receipt" ? "1" : "" },
                  ]);
                }}
                type="button"
              >
                增加行
              </button>
              <div className="flex items-center justify-end gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() => setInvModalOpen(false)}
                  disabled={busy}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={
                    busy ||
                    invEditingDetails.some((r) => !r.itemId || (Number(r.qty) || 0) <= 0 || (invMode === "receipt" && (Number(r.unitCostTxn) || 0) <= 0)) ||
                    (invMode === "receipt"
                      ? Math.round(invEditingTotals.totalTxn * 100) / 100 !== Math.round(invExpectedTxn * 100) / 100
                      : invEditingDetails.some((r) => invQuoteByRow[r.rowId]?.base == null || invQuoteByRow[r.rowId]?.err))
                  }
                  onClick={() => {
                    setInvDetails(invEditingDetails);
                    setInvConfirmed({
                      mode: invMode,
                      expectedTxn: invExpectedTxn,
                      expectedBase: invExpectedBase,
                      quoteBase: invMode === "shipment" ? invEditingTotals.totalQuoteBase : 0,
                    });
                    setInvModalOpen(false);
                  }}
                  type="button"
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
