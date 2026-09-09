import { useEffect, useMemo, useState } from "react";
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

export default function FixedAssets() {
  const { activeOrgId, orgSwitching } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
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

  const cashAccounts = useMemo(() => accounts, [accounts]);

  async function refresh() {
    const [{ accounts }, { assets }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ assets: any[] }>("/api/fixed-assets"),
    ]);
    setAccounts(accounts as any);
    setAssets(assets as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setAssets([]);
    refresh().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

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
        </div>
      </div>
    </AppShell>
  );
}
