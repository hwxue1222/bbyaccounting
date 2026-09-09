import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

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
  itemId: string;
  itemName: string;
  uom: string;
};

export default function Inventory() {
  const { activeOrgId, orgSwitching } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [itemName, setItemName] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [stock, setStock] = useState<{ qty: number; valueBase: number } | null>(null);

  const [moveStatus, setMoveStatus] = useState<"" | "draft" | "posted">("draft");
  const [movesOnlySelectedItem, setMovesOnlySelectedItem] = useState(true);
  const [moves, setMoves] = useState<Move[]>([]);

  const [receipt, setReceipt] = useState({ date: new Date().toISOString().slice(0, 10), qty: 1, unitCostTxn: 10, currency: "SGD", fxRate: 1, offsetAccountId: "" });
  const [shipment, setShipment] = useState({ date: new Date().toISOString().slice(0, 10), qty: 1 });
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offsetAccounts = useMemo(() => accounts, [accounts]);

  async function refresh() {
    const [{ accounts }, { items }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ items: any[] }>("/api/inventory/items"),
    ]);
    setAccounts(accounts as any);
    setItems(items as any);
  }

  async function refreshMoves() {
    const qs = new URLSearchParams();
    qs.set("limit", "100");
    if (moveStatus) qs.set("status", moveStatus);
    const effectiveItemId = movesOnlySelectedItem ? selectedItemId : "";
    if (effectiveItemId) qs.set("itemId", effectiveItemId);
    const r = await api<{ moves: any[] }>(`/api/inventory/moves?${qs.toString()}`);
    setMoves(r.moves as any);
  }

  async function refreshStock(itemId: string) {
    const s = await api<{ itemId: string; qty: number; valueBase: number }>(`/api/inventory/stock?itemId=${encodeURIComponent(itemId)}`);
    setStock({ qty: s.qty, valueBase: s.valueBase });
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setSelectedItemId("");
    setStock(null);
    setMoves([]);
    refresh().catch((e) => setErr(e.message));
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
  }, [activeOrgId, orgSwitching, selectedItemId, moveStatus, movesOnlySelectedItem]);

  return (
    <AppShell title="库存 FIFO">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold">库存商品</div>
          <div className="mt-3 flex gap-2">
            <input className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="商品名称" />
            <button
              className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !itemName.trim()}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api("/api/inventory/items", { method: "POST", json: { name: itemName, uom: "EA" } });
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
                  {it.name}
                </option>
              ))}
            </select>
            {stock ? (
              <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-sm">
                <div>期末数量：{stock.qty.toFixed(4)}</div>
                <div>期末金额(本位)：{stock.valueBase.toFixed(2)}</div>
              </div>
            ) : null}
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">入库（生成分录 + FIFO 批次）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.date} onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">数量</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.qty} onChange={(e) => setReceipt({ ...receipt, qty: Number(e.target.value) || 0 })} type="number" step="0.0001" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">单价（交易币）</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={receipt.unitCostTxn} onChange={(e) => setReceipt({ ...receipt, unitCostTxn: Number(e.target.value) || 0 })} type="number" step="0.0001" />
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
                  await refreshStock(selectedItemId);
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

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">出库（FIFO 计算成本 + 自动结转）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={shipment.date} onChange={(e) => setShipment({ ...shipment, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">数量</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={shipment.qty} onChange={(e) => setShipment({ ...shipment, qty: Number(e.target.value) || 0 })} type="number" step="0.0001" />
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
                  await refreshStock(selectedItemId);
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

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">库存单据（含分录联动）</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
                disabled={busy}
                onClick={() => refreshMoves().catch((e) => setErr(e.message))}
              >
                刷新
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div>
                <label className="text-xs text-zinc-600">状态</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={moveStatus}
                  onChange={(e) => setMoveStatus(e.target.value as any)}
                >
                  <option value="draft">draft</option>
                  <option value="posted">posted</option>
                  <option value="">all</option>
                </select>
              </div>
              <label className="mt-5 flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={movesOnlySelectedItem} onChange={(e) => setMovesOnlySelectedItem(e.target.checked)} />
                仅选中商品
              </label>
              <div className="mt-5 text-xs text-zinc-500">draft=来自分录/未过账；posted=已过账并写入 FIFO</div>
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">日期</th>
                    <th className="px-3 py-2 text-left">类型</th>
                    <th className="px-3 py-2 text-left">商品</th>
                    <th className="px-3 py-2 text-right">数量</th>
                    <th className="px-3 py-2 text-right">单价</th>
                    <th className="px-3 py-2 text-right">金额</th>
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-left">凭证</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => {
                    const qty = Number(m.qty);
                    const unitTxn = m.unitCostTxn == null ? null : Number(m.unitCostTxn);
                    const amountTxn = unitTxn == null ? null : Math.round(qty * unitTxn * 100) / 100;
                    return (
                      <tr key={m.id} className="border-t border-zinc-100">
                        <td className="px-3 py-2 whitespace-nowrap">{m.moveDate}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{m.moveType}</td>
                        <td className="px-3 py-2">{m.itemName}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{Number.isFinite(qty) ? qty.toFixed(4) : m.qty}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{unitTxn == null ? "-" : `${unitTxn.toFixed(6)} ${m.currency || ""}`}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{amountTxn == null ? "-" : `${amountTxn.toFixed(2)} ${m.currency || ""}`}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{m.status}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{m.entryId ? <a className="text-blue-700 hover:underline" href="/journal">打开</a> : "-"}</td>
                      </tr>
                    );
                  })}
                  {!moves.length ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-sm text-zinc-500" colSpan={8}>
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
        </div>
      </div>
    </AppShell>
  );
}
