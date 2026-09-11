import { useEffect, useMemo, useState } from "react";
import { useRef } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type Account = { id: string; code: string; name: string };
type Item = { id: string; sku: string | null; name: string; uom: string; inventoryAccountId: string | null; cogsAccountId: string | null };
type Move = {
  id: string;
  moveType: string;
  moveDate: string;
  qty: string;
  unitCostBase: string | null;
  unitCostTxn: string | null;
  currency: string | null;
  fxRate: string | null;
  status: string;
  entryId: string | null;
  voucherNo?: string | null;
  entrySeq?: number | null;
  itemId: string;
  itemSku?: string | null;
  itemName: string;
  uom: string;
};

type JournalDetail = {
  entry: {
    id: string;
    entryDate: string;
    voucherNo: string | null;
    status: string;
    currency: string;
    fxRate: number;
    memo: string | null;
  };
  lines: Array<{ id: string; lineNo: number; accountId: string; debitTxn: number; creditTxn: number; description?: string | null }>;
  attachments: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string }>;
};

type StockTakeItemRow = {
  id: string;
  sku: string | null;
  name: string;
  uom: string;
  isActive?: boolean;
  qty: string;
  valueBase: string;
  latestUnitCostBase: string | null;
};

type StockTakeLine = { itemId: string; countedQty: string };

export default function Inventory() {
  const { activeOrgId, orgSwitching } = useAuthStore();
  const tr = useTr();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemSku, setItemSku] = useState("");
  const [itemName, setItemName] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [stock, setStock] = useState<{ qty: number; valueBase: number } | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);
  const [balances, setBalances] = useState<
    | {
        openingQty: number;
        openingValueBase: number;
        inQty: number;
        inValueBase: number;
        outQty: number;
        outValueBase: number;
        closingQty: number;
        closingValueBase: number;
      }
    | null
  >(null);

  const [receipt, setReceipt] = useState({ date: new Date().toISOString().slice(0, 10), qty: 1, unitCostTxn: 10, currency: "SGD", fxRate: 1, offsetAccountId: "" });
  const [shipment, setShipment] = useState({ date: new Date().toISOString().slice(0, 10), qty: 1 });
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [journalModalOpen, setJournalModalOpen] = useState(false);
  const [journalDetail, setJournalDetail] = useState<JournalDetail | null>(null);
  const [journalErr, setJournalErr] = useState<string | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);

  const [panel, setPanel] = useState<"receipt" | "shipment" | "moves" | "stockTake">("moves");

  const [stockTakeDate, setStockTakeDate] = useState(today);
  const [stockTakeItems, setStockTakeItems] = useState<StockTakeItemRow[]>([]);
  const [stockTakeLines, setStockTakeLines] = useState<Record<string, StockTakeLine>>({});
  const [stockTakePreview, setStockTakePreview] = useState<any>(null);
  const [stockTakePreviewBusy, setStockTakePreviewBusy] = useState(false);
  const stockTakePreviewReqIdRef = useRef(0);

  const stockTakeItemsSorted = useMemo(() => {
    const arr = [...stockTakeItems];
    arr.sort((a, b) => {
      const sa = (a.sku || "").trim();
      const sb = (b.sku || "").trim();
      const aHas = Boolean(sa);
      const bHas = Boolean(sb);
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (sa && sb) {
        const cmp = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
        if (cmp !== 0) return cmp;
      }
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    return arr;
  }, [stockTakeItems]);

  const stockTakeChangedLines = useMemo(() => {
    return stockTakeItemsSorted
      .map((it) => {
        const st = stockTakeLines[String(it.id)];
        const onHandQty = Number(it.qty || 0);
        const countedQty = Number(st?.countedQty);
        if (!Number.isFinite(countedQty) || countedQty < 0) return null;
        const diff = countedQty - onHandQty;
        if (Math.round(diff * 10000) === 0) return null;
        return { itemId: String(it.id), countedQty };
      })
      .filter(Boolean) as Array<{ itemId: string; countedQty: number }>;
  }, [stockTakeItemsSorted, stockTakeLines]);

  const stockTakeChangedKey = useMemo(() => {
    if (!stockTakeChangedLines.length) return "";
    return stockTakeChangedLines.map((l) => `${l.itemId}:${Math.trunc(l.countedQty)}`).join("|");
  }, [stockTakeChangedLines]);

  useEffect(() => {
    if (panel !== "stockTake") return;

    const reqId = ++stockTakePreviewReqIdRef.current;
    const t = window.setTimeout(async () => {
      if (!stockTakeChangedLines.length) {
        setStockTakePreview(null);
        setStockTakePreviewBusy(false);
        return;
      }
      setStockTakePreviewBusy(true);
      setErr(null);
      try {
        const r = await api<any>("/api/inventory/stock-take/preview", {
          method: "POST",
          json: { date: stockTakeDate, lines: stockTakeChangedLines },
        });
        if (stockTakePreviewReqIdRef.current === reqId) {
          setStockTakePreview(r);
        }
      } catch (e: any) {
        if (stockTakePreviewReqIdRef.current === reqId) {
          setStockTakePreview(null);
          setErr(e?.message || "Failed");
        }
      } finally {
        if (stockTakePreviewReqIdRef.current === reqId) {
          setStockTakePreviewBusy(false);
        }
      }
    }, 350);

    return () => {
      window.clearTimeout(t);
    };
  }, [panel, stockTakeDate, stockTakeChangedKey, stockTakeChangedLines]);

  const offsetAccounts = useMemo(() => accounts, [accounts]);

  async function openJournalModal(entryId: string) {
    if (!entryId) return;
    setJournalModalOpen(true);
    setJournalDetail(null);
    setJournalErr(null);
    setJournalLoading(true);
    try {
      const d = await api<JournalDetail>(`/api/journals/${encodeURIComponent(entryId)}`);
      setJournalDetail(d);
    } catch (e: any) {
      setJournalErr(e?.message || tr("加载分录失败", "Failed to load journal"));
    } finally {
      setJournalLoading(false);
    }
  }

  async function refresh() {
    const [{ accounts }, { items }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ items: any[] }>("/api/inventory/items"),
    ]);
    setAccounts(accounts as any);
    setItems(items as any);
  }

  async function refreshStockTakeItems() {
    const r = await api<{ items: any[] }>("/api/inventory/stock-take/items");
    const rows = (r.items || []) as any[];
    setStockTakeItems(rows as any);
    setStockTakeLines((prev) => {
      const next: Record<string, StockTakeLine> = { ...prev };
      for (const it of rows) {
        const id = String(it.id);
        const currentQty = Number(it.qty || 0);
        if (!next[id]) {
          next[id] = {
            itemId: id,
            countedQty: String(Math.trunc(currentQty)),
          };
        }
      }
      return next;
    });
  }

  async function refreshMoves() {
    const qs = new URLSearchParams();
    qs.set("limit", "100");
    if (selectedItemId) qs.set("itemId", selectedItemId);
    if (startDate) qs.set("startDate", startDate);
    if (endDate) qs.set("endDate", endDate);
    const r = await api<{ moves: any[] }>(`/api/inventory/moves?${qs.toString()}`);
    setMoves(r.moves as any);
  }

  async function refreshBalances() {
    if (!startDate || !endDate) {
      setBalances(null);
      return;
    }
    const qs = new URLSearchParams();
    qs.set("startDate", startDate);
    qs.set("endDate", endDate);
    if (selectedItemId) qs.set("itemId", selectedItemId);
    const r = await api<any>(`/api/inventory/moves/balances?${qs.toString()}`);
    setBalances(r as any);
  }

  async function refreshStock(itemId: string) {
    const s = await api<{ itemId: string; qty: number; valueBase: number }>(`/api/inventory/stock?itemId=${encodeURIComponent(itemId)}`);
    setStock({ qty: s.qty, valueBase: s.valueBase });
  }

  async function refreshAll() {
    await Promise.all([
      refresh(),
      refreshMoves(),
      selectedItemId ? refreshStock(selectedItemId) : Promise.resolve(),
    ]);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setSelectedItemId("");
    setStock(null);
    setMoves([]);
    refresh()
      .then(() => refreshStockTakeItems())
      .catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  useEffect(() => {
    if (selectedItemId) {
      refreshStock(selectedItemId).catch((e) => setErr(e.message));
    } else {
      setStock(null);
    }
  }, [selectedItemId]);

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    refreshMoves().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching, selectedItemId, startDate, endDate]);

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    refreshBalances().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching, selectedItemId, startDate, endDate]);

  return (
    <AppShell title={tr("库存 FIFO", "Inventory FIFO")}>
      <div className={panel === "moves" ? "space-y-4" : "grid items-start gap-4 lg:grid-cols-2"}>
        {panel !== "moves" ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">{tr("库存商品", "Items")}</div>
            <div className="mt-3 flex gap-2">
              <input
                className="w-44 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={itemSku}
                onChange={(e) => setItemSku(e.target.value)}
                placeholder={tr("编号", "SKU")}
              />
              <input
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder={tr("商品名称", "Item name")}
              />
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={busy || !itemSku.trim() || !itemName.trim()}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await api("/api/inventory/items", { method: "POST", json: { sku: itemSku, name: itemName, uom: "EA" } });
                    setItemSku("");
                    setItemName("");
                    await refresh();
                  } catch (e: any) {
                    setErr(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {tr("新增", "Add")}
              </button>
            </div>
            <div className="mt-3">
              <label className="text-xs text-zinc-600">{tr("选择商品", "Select item")}</label>
              <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
                <option value="">{tr("请选择", "Select")}</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {(it.sku ? `${it.sku} ` : "") + it.name}
                  </option>
                ))}
              </select>
              {stock ? (
                <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-sm">
                  <div>
                    {tr("期末数量：", "Closing qty: ")}
                    {Math.trunc(stock.qty)}
                  </div>
                  <div>
                    {tr("期末金额：", "Closing value: ")}
                    {stock.valueBase.toFixed(2)}
                  </div>
                </div>
              ) : null}
            </div>
            {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
          </div>
        ) : null}

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
            <div className="grid grid-cols-4 gap-1">
              <button
                className={
                  panel === "receipt"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setPanel("receipt")}
              >
                {tr("入库", "Receipt")}
              </button>
              <button
                className={
                  panel === "shipment"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setPanel("shipment")}
              >
                {tr("出库", "Shipment")}
              </button>
              <button
                className={
                  panel === "moves"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setPanel("moves")}
              >
                {tr("流水", "Moves")}
              </button>
              <button
                className={
                  panel === "stockTake"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => {
                  setPanel("stockTake");
                  setErr(null);
                  setStockTakePreview(null);
                  refreshStockTakeItems().catch((e) => setErr(e.message));
                }}
              >
                {tr("盘点", "Stock take")}
              </button>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "receipt" ? "" : "hidden")}>
            <div className="text-sm font-semibold">{tr("入库（生成分录 + FIFO 批次）", "Receipt (creates journal + FIFO layer)")}</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">{tr("日期", "Date")}</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.date} onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("数量", "Quantity")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={receipt.qty}
                  onChange={(e) => setReceipt({ ...receipt, qty: Math.trunc(Number(e.target.value) || 0) })}
                  type="number"
                  step="1"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("单价（交易币）", "Unit cost (txn currency)")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={receipt.unitCostTxn}
                  onChange={(e) => setReceipt({ ...receipt, unitCostTxn: Number(e.target.value) || 0 })}
                  type="number"
                  step="0.01"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("币种", "Currency")}</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.currency} onChange={(e) => setReceipt({ ...receipt, currency: e.target.value.toUpperCase() })} maxLength={3} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("汇率", "FX rate")}</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.fxRate} onChange={(e) => setReceipt({ ...receipt, fxRate: Number(e.target.value) || 1 })} type="number" step="0.0001" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("贷方科目（应付/现金）", "Credit account (AP/Cash)")}</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={receipt.offsetAccountId} onChange={(e) => setReceipt({ ...receipt, offsetAccountId: e.target.value })}>
                  <option value="">{tr("请选择", "Select")}</option>
                  {offsetAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !selectedItemId || !receipt.offsetAccountId}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const resp = await api<any>("/api/inventory/receipts", {
                    method: "POST",
                    json: { ...receipt, itemId: selectedItemId },
                  });
                  setResult({ type: "receipt", resp });
                  await Promise.all([refreshStock(selectedItemId), refreshMoves()]);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr("入库并过账", "Post receipt")}
            </button>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "stockTake" ? "" : "hidden")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">{tr("盘点（Stock Take）", "Stock take")}</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setErr(null);
                  setStockTakePreview(null);
                  refreshStockTakeItems().catch((e) => setErr(e.message));
                }}
                type="button"
              >
                {tr("刷新", "Refresh")}
              </button>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">{tr("盘点日期", "Stock take date")}</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={stockTakeDate} onChange={(e) => setStockTakeDate(e.target.value)} type="date" />
              </div>
              <div className="flex items-end gap-2">
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={busy || stockTakePreviewBusy}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    setStockTakePreview(null);
                    try {
                      const lines = stockTakeChangedLines;
                      if (!lines.length) {
                        setStockTakePreview(null);
                        return;
                      }
                      const r = await api<any>("/api/inventory/stock-take/preview", {
                        method: "POST",
                        json: { date: stockTakeDate, lines },
                      });
                      setStockTakePreview(r);
                    } catch (e: any) {
                      setErr(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  type="button"
                >
                  {stockTakePreviewBusy ? tr("计算中...", "Calculating...") : tr("预览成本", "Preview cost")}
                </button>
                <button
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      const lines = stockTakeItemsSorted
                        .map((it) => {
                          const st = stockTakeLines[String(it.id)];
                          const onHandQty = Number(it.qty || 0);
                          const countedQty = Number(st?.countedQty);
                          if (!Number.isFinite(countedQty) || countedQty < 0) return null;
                          if (Math.round((countedQty - onHandQty) * 10000) === 0) return null;
                          return {
                            itemId: String(it.id),
                            countedQty,
                          };
                        })
                        .filter(Boolean);
                      if (!lines.length) {
                        setErr(tr("没有需要调整的商品（盘点数量与现有数量一致）。", "No adjustments needed (counted qty equals on-hand).") );
                        return;
                      }
                      const r = await api<any>("/api/inventory/stock-take", {
                        method: "POST",
                        json: { date: stockTakeDate, lines },
                      });
                      setResult(r);
                      await Promise.all([refreshMoves(), refreshStockTakeItems(), selectedItemId ? refreshStock(selectedItemId) : Promise.resolve()]);
                      if (r?.entryId) {
                        void openJournalModal(String(r.entryId));
                      }
                    } catch (e: any) {
                      setErr(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  type="button"
                >
                  {tr("盘点并过账", "Post stock take")}
                </button>
              </div>
            </div>

            {stockTakePreview ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm">
                <div>
                  {tr("调整金额合计（本位）：", "Total adjustment (base): ")}
                  {Number(stockTakePreview.totals?.adjustmentBase || 0).toFixed(2)}
                </div>
                <div>
                  {tr("盘点后库存合计金额（本位）：", "Closing inventory value (base): ")}
                  {Number(stockTakePreview.totals?.closingValueBase || 0).toFixed(2)}
                </div>
              </div>
            ) : null}

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">{tr("商品", "Item")}</th>
                    <th className="px-3 py-2 text-right">{tr("现有数量", "On-hand")}</th>
                    <th className="px-3 py-2 text-right">{tr("盘点数量", "Counted")}</th>
                    <th className="px-3 py-2 text-right">{tr("盘存成本", "Closing cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stockTakeItemsSorted.length ? (
                    stockTakeItemsSorted.map((it) => {
                      const st = stockTakeLines[String(it.id)];
                      const onHandQty = Number(it.qty || 0);
                      const countedQty = Number(st?.countedQty) || 0;
                      const diff = countedQty - onHandQty;
                      const previewRow = (stockTakePreview?.rows || []).find((r: any) => String(r.itemId) === String(it.id));
                      const isActive = it.isActive !== false;
                      const baseValue = Number(it.valueBase || 0);
                      const closingCost = previewRow ? Number(previewRow.closingValueBase || 0) : diff === 0 ? baseValue : NaN;
                      return (
                        <tr key={it.id} className="border-t border-zinc-100">
                          <td className="px-3 py-2">
                            {(it.sku ? `${it.sku} ` : "") + it.name} <span className="text-xs text-zinc-500">[{it.uom}]</span>
                            {!isActive ? <span className="ml-2 text-xs text-zinc-400">{tr("已停用", "Inactive")}</span> : null}
                          </td>
                          <td className="px-3 py-2 text-right">{Math.trunc(onHandQty)}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                              value={st?.countedQty ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                setStockTakeLines((prev) => ({
                                  ...prev,
                                  [String(it.id)]: { itemId: String(it.id), countedQty: v },
                                }));
                              }}
                              type="number"
                              step="1"
                              min={0}
                            />
                            {diff !== 0 ? (
                              <div className={"mt-1 text-xs " + (diff > 0 ? "text-blue-700" : "text-amber-700")}>
                                {tr("差异", "Diff")} {diff > 0 ? "+" : ""}
                                {Math.trunc(diff)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right">{Number.isFinite(closingCost) ? closingCost.toFixed(2) : ""}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td className="px-3 py-4 text-sm text-zinc-500" colSpan={4}>
                        {tr("没有商品。请先在左侧新增库存商品。", "No items. Please add inventory items first.")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "shipment" ? "" : "hidden")}>
            <div className="text-sm font-semibold">{tr("出库（FIFO 计算成本 + 自动结转）", "Shipment (FIFO costing + auto posting)")}</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">{tr("日期", "Date")}</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={shipment.date} onChange={(e) => setShipment({ ...shipment, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">{tr("数量", "Quantity")}</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={shipment.qty}
                  onChange={(e) => setShipment({ ...shipment, qty: Math.trunc(Number(e.target.value) || 0) })}
                  type="number"
                  step="1"
                />
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
              disabled={busy || !selectedItemId}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const resp = await api<any>("/api/inventory/shipments", { method: "POST", json: { ...shipment, itemId: selectedItemId } });
                  setResult({ type: "shipment", resp });
                  await Promise.all([refreshStock(selectedItemId), refreshMoves()]);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr("出库并结转成本", "Post shipment")}
            </button>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "moves" ? "" : "hidden")}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">{tr("库存流水（含分录联动）", "Inventory moves")}</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                disabled={busy}
                onClick={() => refreshAll().catch((e) => setErr(e.message))}
              >
                {tr("刷新", "Refresh")}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="min-w-60">
                <div className="text-xs text-zinc-600">{tr("商品", "Item")}</div>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={selectedItemId}
                  onChange={(e) => setSelectedItemId(e.target.value)}
                >
                  <option value="">{tr("全部商品", "All items")}</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {(it.sku ? `${it.sku} ` : "") + it.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-xs text-zinc-600">{tr("时间段", "Date range")}</div>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="w-36 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    type="date"
                  />
                  <span className="text-sm text-zinc-500">-</span>
                  <input
                    className="w-36 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    type="date"
                  />
                </div>
              </div>
              
            </div>

            {balances ? (
              <div className="mt-3 grid gap-2 rounded-lg border border-zinc-100 bg-zinc-50 p-3 text-sm md:grid-cols-2">
                <div>
                  <div className="text-xs text-zinc-600">{tr("期初余额", "Opening")}</div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">{tr("数量", "Qty")}</div>
                    <div className="font-medium">{Math.trunc(balances.openingQty)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">{tr("金额(基准)", "Value (base)")}</div>
                    <div className="font-medium">{balances.openingValueBase.toFixed(2)}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-600">{tr("期末余额", "Closing")}</div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">{tr("数量", "Qty")}</div>
                    <div className="font-medium">{Math.trunc(balances.closingQty)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">{tr("金额(基准)", "Value (base)")}</div>
                    <div className="font-medium">{balances.closingValueBase.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-100">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="w-28 px-3 py-2 text-left">{tr("日期", "Date")}</th>
                    <th className="w-20 px-3 py-2 text-left">{tr("类型", "Type")}</th>
                    <th className="px-3 py-2 text-left">{tr("商品", "Item")}</th>
                    <th className="w-16 px-3 py-2 text-right">{tr("数量", "Qty")}</th>
                    <th className="w-24 px-3 py-2 text-right">{tr("单价", "Unit")}</th>
                    <th className="w-24 px-3 py-2 text-right">{tr("金额", "Amount")}</th>
                    <th className="hidden w-20 px-3 py-2 text-left md:table-cell">{tr("状态", "Status")}</th>
                    <th className="hidden w-28 px-3 py-2 text-left lg:table-cell">{tr("分录号", "Voucher")}</th>
                    <th className="hidden w-16 px-3 py-2 text-left lg:table-cell">{tr("凭证", "Journal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => {
                    const qty = Number(m.qty);
                    const isOut = m.moveType === "shipment";
                    const typeLabel =
                      m.moveType === "shipment" ? tr("出库", "out") : m.moveType === "receipt" ? tr("入库", "in") : String(m.moveType || "");
                    const unitTxn = m.unitCostTxn == null ? null : Number(m.unitCostTxn);
                    const amountTxn = unitTxn == null ? null : Math.round(Math.abs(qty) * unitTxn * 100) / 100;
                    const itemLabel = ((m.itemSku ? `${m.itemSku} ` : "") + m.itemName).replace(/\s+/g, " ").trim();
                    return (
                      <tr key={m.id} className="border-t border-zinc-100">
                        <td className="px-3 py-2 whitespace-nowrap">{m.moveDate}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{typeLabel}</td>
                        <td className="px-3 py-2 break-words">{itemLabel}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {Number.isFinite(qty) ? (
                            <span className={isOut ? "text-red-700" : ""}>
                              {String(isOut ? -Math.trunc(Math.abs(qty)) : Math.trunc(qty))}
                            </span>
                          ) : (
                            m.qty
                          )}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{unitTxn == null ? "-" : `${unitTxn.toFixed(2)} ${m.currency || ""}`}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {amountTxn == null ? (
                            "-"
                          ) : (
                            <span className={isOut ? "text-red-700" : ""}>
                              {(isOut ? -amountTxn : amountTxn).toFixed(2)} {m.currency || ""}
                            </span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2 whitespace-nowrap md:table-cell">{m.status}</td>
                        <td className="hidden px-3 py-2 whitespace-nowrap lg:table-cell">
                          {m.entryId ? (
                            <button className="text-blue-700 hover:underline" onClick={() => openJournalModal(m.entryId!)} type="button">
                              {m.voucherNo || (m.entryId ? m.entryId.slice(0, 8) : "-")}
                            </button>
                          ) : (
                            m.voucherNo || "-"
                          )}
                        </td>
                        <td className="hidden px-3 py-2 whitespace-nowrap lg:table-cell">
                          {m.entryId ? (
                            <button className="text-blue-700 hover:underline" onClick={() => openJournalModal(m.entryId!)} type="button">
                              {tr("打开", "Open")}
                            </button>
                          ) : (
                            "-"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!moves.length ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-sm text-zinc-500" colSpan={9}>
                        {tr("暂无数据", "No data")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {result ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
              <div className="font-semibold">{tr("结果", "Result")}</div>
              <pre className="mt-2 overflow-auto rounded-lg bg-zinc-50 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>
            </div>
          ) : null}

          {journalModalOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
              onMouseDown={() => {
                setJournalModalOpen(false);
              }}
            >
              <div
                className="w-full max-w-5xl rounded-xl bg-white p-4 shadow-xl"
                onMouseDown={(e) => {
                  e.stopPropagation();
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold">{tr("分录详情", "Journal detail")}</div>
                  <button
                    className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                    type="button"
                    onClick={() => setJournalModalOpen(false)}
                  >
                    {tr("关闭", "Close")}
                  </button>
                </div>

                <div className="mt-3">
                  {journalLoading ? (
                    <div className="text-sm text-zinc-600">{tr("加载中...", "Loading...")}</div>
                  ) : journalErr ? (
                    <div className="text-sm text-red-700">{journalErr}</div>
                  ) : journalDetail ? (
                    <div className="space-y-3">
                      <div className="text-sm text-zinc-700">
                        {journalDetail.entry.entryDate} · {journalDetail.entry.voucherNo || "-"} · {journalDetail.entry.status} · {journalDetail.entry.currency} @ {journalDetail.entry.fxRate}
                      </div>
                      {journalDetail.entry.memo ? <div className="text-sm text-zinc-700">{journalDetail.entry.memo}</div> : null}

                      <div className="overflow-auto rounded-lg border border-zinc-100">
                        <table className="w-full text-sm">
                          <thead className="bg-zinc-50 text-xs text-zinc-600">
                            <tr>
                              <th className="px-3 py-2 text-left">{tr("行", "Line")}</th>
                              <th className="px-3 py-2 text-left">{tr("科目", "Account")}</th>
                              <th className="px-3 py-2 text-right">{tr("借", "Debit")}</th>
                              <th className="px-3 py-2 text-right">{tr("贷", "Credit")}</th>
                              <th className="px-3 py-2 text-left">{tr("备注", "Memo")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {journalDetail.lines.map((l) => {
                              const acc = accounts.find((a) => a.id === l.accountId);
                              return (
                                <tr key={l.id} className="border-t border-zinc-100">
                                  <td className="px-3 py-2 whitespace-nowrap">{l.lineNo}</td>
                                  <td className="px-3 py-2 whitespace-nowrap">{acc ? `${acc.code} ${acc.name}` : l.accountId}</td>
                                  <td className="px-3 py-2 text-right">{Number(l.debitTxn || 0).toFixed(2)}</td>
                                  <td className="px-3 py-2 text-right">{Number(l.creditTxn || 0).toFixed(2)}</td>
                                  <td className="px-3 py-2">{l.description || ""}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {journalDetail.attachments?.length ? (
                        <div>
                          <div className="mb-2 text-xs text-zinc-600">{tr("附件", "Attachments")}</div>
                          <div className="space-y-1">
                            {journalDetail.attachments.map((a) => (
                              <a
                                key={a.id}
                                className="block rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                                href={`/api/journals/${journalDetail.entry.id}/attachments/${a.id}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {a.fileName}
                              </a>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
