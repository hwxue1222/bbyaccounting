import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

type Account = { id: string; code: string; name: string };
type Asset = {
  id: string;
  name: string;
  acquisitionDate: string;
  costBase: string;
  usefulLifeMonths: number;
  salvageValueBase: string;
  status: string;
  disposedAt: string | null;
};

type ScheduleRow = {
  assetId: string;
  name: string;
  acquisitionDate: string;
  status: string;
  openingCost: number;
  additions: number;
  disposals: number;
  closingCost: number;
  openingAccumDep: number;
  depExpense: number;
  accumDepDisposed: number;
  closingAccumDep: number;
  netBookValue: number;
};

type ScheduleTotals = Omit<ScheduleRow, "assetId" | "name" | "acquisitionDate" | "status">;

export default function FixedAssets() {
  const { activeOrgId, orgSwitching, orgs } = useAuthStore();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = active?.baseCurrency || "BASE";
  const [params] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([]);
  const [scheduleTotals, setScheduleTotals] = useState<ScheduleTotals | null>(null);
  const [scheduleStart, setScheduleStart] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    return `${y}-01-01`;
  });
  const [scheduleEnd, setScheduleEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assetForm, setAssetForm] = useState({
    name: "Laptop",
    acquisitionDate: new Date().toISOString().slice(0, 10),
    costTxn: 2000,
    currency: "SGD",
    fxRate: 1,
    usefulLifeMonths: 36,
    salvageBase: 0,
    offsetAccountId: "",
  });
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });

  const [disposeForm, setDisposeForm] = useState({
    assetId: "",
    date: new Date().toISOString().slice(0, 10),
    proceedsBase: 0,
    cashAccountId: "",
    gainLossAccountId: "",
  });

  const cashAccounts = useMemo(() => accounts, [accounts]);

  async function refresh() {
    const [{ accounts }, { assets }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ assets: any[] }>("/api/fixed-assets"),
    ]);
    setAccounts(accounts as any);
    setAssets(assets as any);
  }

  async function refreshSchedule(start: string, end: string) {
    const r = await api<{ data: { items: ScheduleRow[]; totals: ScheduleTotals } }>(
      `/api/reports/fixed-assets-schedule?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
    setScheduleRows(r.data.items as any);
    setScheduleTotals(r.data.totals as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setAssets([]);
    refresh()
      .then(() => refreshSchedule(scheduleStart, scheduleEnd))
      .catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  useEffect(() => {
    if (!activeOrgId) return;
    const mode = params.get("mode");
    if (mode === "purchase") {
      const date = params.get("date");
      const amount = params.get("amount");
      const currency = params.get("currency");
      const fx = params.get("fx");
      setAssetForm((p) => ({
        ...p,
        acquisitionDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : p.acquisitionDate,
        costTxn: amount ? Number(amount) || p.costTxn : p.costTxn,
        currency: currency ? String(currency).toUpperCase().slice(0, 3) : p.currency,
        fxRate: fx ? Number(fx) || p.fxRate : p.fxRate,
      }));
    }
    if (mode === "depreciate") {
      const p = params.get("period");
      if (p && /^\d{4}-\d{2}$/.test(p)) setPeriod(p);
    }
    if (mode === "dispose") {
      const date = params.get("date");
      setDisposeForm((d) => ({
        ...d,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : d.date,
      }));
    }
  }, [activeOrgId, params]);

  return (
    <AppShell title="固定资产">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold">资产列表</div>
          <div className="mt-3 max-h-[520px] overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                <tr>
                  <th className="px-3 py-2 text-left">名称</th>
                  <th className="px-3 py-2 text-left">购置日</th>
                  <th className="px-3 py-2 text-right">成本</th>
                  <th className="px-3 py-2 text-left">状态</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2">{a.name}</td>
                    <td className="px-3 py-2">{a.acquisitionDate}</td>
                    <td className="px-3 py-2 text-right">{Number(a.costBase).toFixed(2)}</td>
                    <td className="px-3 py-2">{a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">新增资产（自动生成购置分录）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">名称</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.name} onChange={(e) => setAssetForm({ ...assetForm, name: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">购置日</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.acquisitionDate} onChange={(e) => setAssetForm({ ...assetForm, acquisitionDate: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">金额（交易币）</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.costTxn} onChange={(e) => setAssetForm({ ...assetForm, costTxn: Number(e.target.value) || 0 })} type="number" step="0.01" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">币种</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.currency} onChange={(e) => setAssetForm({ ...assetForm, currency: e.target.value.toUpperCase() })} maxLength={3} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">汇率</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.fxRate} onChange={(e) => setAssetForm({ ...assetForm, fxRate: Number(e.target.value) || 1 })} type="number" step="0.0001" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">折旧月数</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.usefulLifeMonths} onChange={(e) => setAssetForm({ ...assetForm, usefulLifeMonths: Number(e.target.value) || 0 })} type="number" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">残值（本位）</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={assetForm.salvageBase} onChange={(e) => setAssetForm({ ...assetForm, salvageBase: Number(e.target.value) || 0 })} type="number" step="0.01" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">贷方科目（现金/应付）</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={assetForm.offsetAccountId} onChange={(e) => setAssetForm({ ...assetForm, offsetAccountId: e.target.value })}>
                  <option value="">请选择</option>
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !assetForm.offsetAccountId}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api("/api/fixed-assets", { method: "POST", json: assetForm });
                  await refresh();
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              新增并过账
            </button>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">按期折旧（生成折旧分录）</div>
            <div className="mt-3 flex gap-2">
              <input className="w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
              <button
                className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
                disabled={busy || !/^\d{4}-\d{2}$/.test(period)}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await api("/api/fixed-assets/depreciate", { method: "POST", json: { period } });
                  } catch (e: any) {
                    setErr(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                生成折旧
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">处置资产（自动生成处置分录）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">资产</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={disposeForm.assetId}
                  onChange={(e) => setDisposeForm({ ...disposeForm, assetId: e.target.value })}
                >
                  <option value="">请选择</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.acquisitionDate})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">处置日</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={disposeForm.date} onChange={(e) => setDisposeForm({ ...disposeForm, date: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">处置收入（本位 {baseCurrency}）</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={disposeForm.proceedsBase}
                  onChange={(e) => setDisposeForm({ ...disposeForm, proceedsBase: Number(e.target.value) || 0 })}
                  type="number"
                  step="0.01"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-600">收款科目（现金/银行）</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={disposeForm.cashAccountId}
                  onChange={(e) => setDisposeForm({ ...disposeForm, cashAccountId: e.target.value })}
                >
                  <option value="">请选择</option>
                  {cashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">损益科目（可选）</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={disposeForm.gainLossAccountId}
                  onChange={(e) => setDisposeForm({ ...disposeForm, gainLossAccountId: e.target.value })}
                >
                  <option value="">默认</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !disposeForm.assetId || !disposeForm.cashAccountId}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api(`/api/fixed-assets/${disposeForm.assetId}/dispose` as any, {
                    method: "POST",
                    json: {
                      date: disposeForm.date,
                      proceedsBase: disposeForm.proceedsBase,
                      cashAccountId: disposeForm.cashAccountId,
                      gainLossAccountId: disposeForm.gainLossAccountId || undefined,
                    },
                  });
                  await refresh();
                  await refreshSchedule(scheduleStart, scheduleEnd);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              处置并过账
            </button>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">Fixed Assets Schedule（固定资产变动表）</div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <label className="text-xs text-zinc-600">开始日期</label>
                <input className="mt-1 w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">结束日期</label>
                <input className="mt-1 w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} />
              </div>
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleStart) || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleEnd)}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await refreshSchedule(scheduleStart, scheduleEnd);
                  } catch (e: any) {
                    setErr(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                刷新
              </button>
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">资产</th>
                    <th className="px-3 py-2 text-right">成本期初</th>
                    <th className="px-3 py-2 text-right">+增加</th>
                    <th className="px-3 py-2 text-right">-处置</th>
                    <th className="px-3 py-2 text-right">成本期末</th>
                    <th className="px-3 py-2 text-right">折旧期初</th>
                    <th className="px-3 py-2 text-right">+当期折旧</th>
                    <th className="px-3 py-2 text-right">-处置</th>
                    <th className="px-3 py-2 text-right">折旧期末</th>
                    <th className="px-3 py-2 text-right">净值</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduleRows.map((r) => (
                    <tr key={r.assetId} className="border-t border-zinc-100">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-zinc-500">{r.acquisitionDate} · {r.status}</div>
                      </td>
                      <td className="px-3 py-2 text-right">{r.openingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.additions.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.disposals.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.closingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.openingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.depExpense.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.accumDepDisposed.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.closingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">{r.netBookValue.toFixed(2)}</td>
                    </tr>
                  ))}
                  {scheduleTotals ? (
                    <tr className="border-t border-zinc-200 bg-zinc-50">
                      <td className="px-3 py-2 font-medium">合计（本位 {baseCurrency}）</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.openingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.additions.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.disposals.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.closingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.openingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.depExpense.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.accumDepDisposed.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.closingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.netBookValue.toFixed(2)}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
