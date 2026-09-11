import { useEffect, useMemo, useState } from "react";
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
  qty: string;
  valueBase: string;
  latestUnitCostBase: string | null;
};

type StockTakeLine = { itemId: string; countedQty: string; gainUnitCostBase: string };

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
      setJournalErr(e?.message || "加载分录失败");
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
            gainUnitCostBase: it.latestUnitCostBase != null ? String(Number(it.latestUnitCostBase) || 0) : "0",
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
            <div className="text-sm font-semibold">库存商品</div>
            <div className="mt-3 flex gap-2">
              <input className="w-44 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={itemSku} onChange={(e) => setItemSku(e.target.value)} placeholder="编号" />
              <input className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="商品名称" />
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
                新增
              </button>
            </div>
            <div className="mt-3">
              <label className="text-xs text-zinc-600">选择商品</label>
              <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)}>
                <option value="">请选择</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {(it.sku ? `${it.sku} ` : "") + it.name}
                  </option>
                ))}
              </select>
              {stock ? (
                <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-sm">
                  <div>期末数量：{Math.trunc(stock.qty)}</div>
                  <div>期末金额：{stock.valueBase.toFixed(2)}</div>
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
                入库
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
                出库
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
                流水
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
                盘点
              </button>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "receipt" ? "" : "hidden")}>
            <div className="text-sm font-semibold">入库（生成分录 + FIFO 批次）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.date} onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">数量</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={receipt.qty}
                  onChange={(e) => setReceipt({ ...receipt, qty: Math.trunc(Number(e.target.value) || 0) })}
                  type="number"
                  step="1"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-600">单价（交易币）</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={receipt.unitCostTxn}
                  onChange={(e) => setReceipt({ ...receipt, unitCostTxn: Number(e.target.value) || 0 })}
                  type="number"
                  step="0.01"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-600">币种</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.currency} onChange={(e) => setReceipt({ ...receipt, currency: e.target.value.toUpperCase() })} maxLength={3} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">汇率</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.fxRate} onChange={(e) => setReceipt({ ...receipt, fxRate: Number(e.target.value) || 1 })} type="number" step="0.0001" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">贷方科目（应付/现金）</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={receipt.offsetAccountId} onChange={(e) => setReceipt({ ...receipt, offsetAccountId: e.target.value })}>
                  <option value="">请选择</option>
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
              入库并过账
            </button>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "stockTake" ? "" : "hidden")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">盘点（Stock Take）</div>
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
                刷新
              </button>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">盘点日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={stockTakeDate} onChange={(e) => setStockTakeDate(e.target.value)} type="date" />
              </div>
              <div className="flex items-end gap-2">
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    setStockTakePreview(null);
                    try {
                      const lines = stockTakeItems
                        .map((it) => {
                          const st = stockTakeLines[String(it.id)];
                          const onHandQty = Number(it.qty || 0);
                          const countedQty = Number(st?.countedQty);
                          const gainUnitCostBase = Number(st?.gainUnitCostBase);
                          if (!Number.isFinite(countedQty) || countedQty < 0) return null;
                          if (Math.round((countedQty - onHandQty) * 10000) === 0) return null;
                          return {
                            itemId: String(it.id),
                            countedQty,
                            gainUnitCostBase: countedQty > onHandQty ? (Number.isFinite(gainUnitCostBase) ? gainUnitCostBase : 0) : undefined,
                          };
                        })
                        .filter(Boolean);
                      if (!lines.length) {
                        setErr("没有需要调整的商品（盘点数量与现有数量一致）。");
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
                  预览成本
                </button>
                <button
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      const lines = stockTakeItems
                        .map((it) => {
                          const st = stockTakeLines[String(it.id)];
                          const onHandQty = Number(it.qty || 0);
                          const countedQty = Number(st?.countedQty);
                          const gainUnitCostBase = Number(st?.gainUnitCostBase);
                          if (!Number.isFinite(countedQty) || countedQty < 0) return null;
                          if (Math.round((countedQty - onHandQty) * 10000) === 0) return null;
                          return {
                            itemId: String(it.id),
                            countedQty,
                            gainUnitCostBase: countedQty > onHandQty ? (Number.isFinite(gainUnitCostBase) ? gainUnitCostBase : 0) : undefined,
                          };
                        })
                        .filter(Boolean);
                      if (!lines.length) {
                        setErr("没有需要调整的商品（盘点数量与现有数量一致）。");
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
                  盘点并过账
                </button>
              </div>
            </div>

            {stockTakePreview ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm">
                <div>调整金额合计（本位）：{Number(stockTakePreview.totals?.adjustmentBase || 0).toFixed(2)}</div>
                <div>盘点后库存合计金额（本位）：{Number(stockTakePreview.totals?.closingValueBase || 0).toFixed(2)}</div>
              </div>
            ) : null}

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">商品</th>
                    <th className="px-3 py-2 text-right">现有数量</th>
                    <th className="px-3 py-2 text-right">盘点数量</th>
                    <th className="px-3 py-2 text-right">盘盈单价（本位）</th>
                    <th className="px-3 py-2 text-right">盘点后金额（本位）</th>
                  </tr>
                </thead>
                <tbody>
                  {stockTakeItems.map((it) => {
                    const st = stockTakeLines[String(it.id)];
                    const onHandQty = Number(it.qty || 0);
                    const countedQty = Number(st?.countedQty) || 0;
                    const diff = countedQty - onHandQty;
                    const previewRow = (stockTakePreview?.rows || []).find((r: any) => String(r.itemId) === String(it.id));
                    return (
                      <tr key={it.id} className="border-t border-zinc-100">
                        <td className="px-3 py-2">
                          {(it.sku ? `${it.sku} ` : "") + it.name} <span className="text-xs text-zinc-500">[{it.uom}]</span>
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
                                [String(it.id)]: { itemId: String(it.id), countedQty: v, gainUnitCostBase: prev[String(it.id)]?.gainUnitCostBase || "0" },
                              }));
                            }}
                            type="number"
                            step="1"
                            min={0}
                          />
                          {diff !== 0 ? <div className={"mt-1 text-xs " + (diff > 0 ? "text-blue-700" : "text-amber-700")}>差异 {diff > 0 ? "+" : ""}{Math.trunc(diff)}</div> : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="w-32 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                            value={st?.gainUnitCostBase ?? "0"}
                            onChange={(e) => {
                              const v = e.target.value;
                              setStockTakeLines((prev) => ({
                                ...prev,
                                [String(it.id)]: { itemId: String(it.id), countedQty: prev[String(it.id)]?.countedQty || "0", gainUnitCostBase: v },
                              }));
                            }}
                            type="number"
                            step="0.0001"
                            disabled={diff <= 0}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">{previewRow ? Number(previewRow.closingValueBase || 0).toFixed(2) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "shipment" ? "" : "hidden")}>
            <div className="text-sm font-semibold">出库（FIFO 计算成本 + 自动结转）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={shipment.date} onChange={(e) => setShipment({ ...shipment, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">数量</label>
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
              出库并结转成本
            </button>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (panel === "moves" ? "" : "hidden")}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">库存流水（含分录联动）</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                disabled={busy}
                onClick={() => refreshAll().catch((e) => setErr(e.message))}
              >
                刷新
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="min-w-60">
                <div className="text-xs text-zinc-600">商品</div>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={selectedItemId}
                  onChange={(e) => setSelectedItemId(e.target.value)}
                >
                  <option value="">全部商品</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {(it.sku ? `${it.sku} ` : "") + it.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="text-xs text-zinc-600">时间段</div>
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
                  <div className="text-xs text-zinc-600">期初余额</div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">数量</div>
                    <div className="font-medium">{Math.trunc(balances.openingQty)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">金额(基准)</div>
                    <div className="font-medium">{balances.openingValueBase.toFixed(2)}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-zinc-600">期末余额</div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">数量</div>
                    <div className="font-medium">{Math.trunc(balances.closingQty)}</div>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <div className="text-zinc-700">金额(基准)</div>
                    <div className="font-medium">{balances.closingValueBase.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-100">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="w-28 px-3 py-2 text-left">日期</th>
                    <th className="w-20 px-3 py-2 text-left">类型</th>
                    <th className="px-3 py-2 text-left">商品</th>
                    <th className="w-16 px-3 py-2 text-right">数量</th>
                    <th className="w-24 px-3 py-2 text-right">单价</th>
                    <th className="w-24 px-3 py-2 text-right">金额</th>
                    <th className="hidden w-20 px-3 py-2 text-left md:table-cell">状态</th>
                    <th className="hidden w-28 px-3 py-2 text-left lg:table-cell">分录号</th>
                    <th className="hidden w-16 px-3 py-2 text-left lg:table-cell">凭证</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => {
                    const qty = Number(m.qty);
                    const isOut = m.moveType === "shipment";
                    const typeLabel = m.moveType === "shipment" ? "out" : m.moveType === "receipt" ? "in" : m.moveType;
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
                              打开
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
                        暂无数据
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          {result ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
              <div className="font-semibold">结果</div>
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
                  <div className="text-sm font-semibold">分录详情</div>
                  <button
                    className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                    type="button"
                    onClick={() => setJournalModalOpen(false)}
                  >
                    关闭
                  </button>
                </div>

                <div className="mt-3">
                  {journalLoading ? (
                    <div className="text-sm text-zinc-600">加载中...</div>
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
                              <th className="px-3 py-2 text-left">行</th>
                              <th className="px-3 py-2 text-left">科目</th>
                              <th className="px-3 py-2 text-right">借</th>
                              <th className="px-3 py-2 text-right">贷</th>
                              <th className="px-3 py-2 text-left">备注</th>
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
                          <div className="mb-2 text-xs text-zinc-600">附件</div>
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
