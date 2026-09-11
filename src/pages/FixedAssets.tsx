import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type Account = { id: string; code: string; name: string };
type Asset = {
  id: string;
  assetNo?: string | null;
  name: string;
  category?: string | null;
  acquisitionDate: string;
  costBase: string;
  purchaseCurrency?: string | null;
  purchaseFxRate?: number | null;
  purchaseMemo?: string | null;
  purchaseCostTxn?: string | null;
  purchaseOffsetAccountId?: string | null;
  usefulLifeMonths: number;
  salvageValueBase: string;
  status: string;
  disposedAt: string | null;
  assetAccountId?: string | null;
  accumDepAccountId?: string | null;
  depExpenseAccountId?: string | null;
  purchaseEntryId?: string | null;
  purchaseVoucherNo?: string | null;
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

type ScheduleRow = {
  assetId: string;
  assetNo?: string | null;
  category?: string | null;
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

type DepEntryRow = {
  entryId: string;
  entryDate: string;
  voucherNo: string | null;
  memo: string | null;
  debitBase: string;
  creditBase: string;
  assetNos?: string | null;
};

type PurchaseEntryRow = {
  entryId: string;
  entryDate: string;
  status: string;
  voucherNo: string | null;
  memo: string | null;
  assetNos?: string | null;
  costBase: string;
};

type DisposeEntryRow = {
  entryId: string;
  entryDate: string;
  voucherNo: string | null;
  memo: string | null;
  assetNos?: string | null;
  costDisposed: string;
  accumDepDisposed: string;
};

export default function FixedAssets() {
  const { activeOrgId, orgSwitching, orgs } = useAuthStore();
  const tr = useTr();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = active?.baseCurrency || "BASE";
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"list" | "purchase" | "depreciate" | "dispose" | "schedule">("list");
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
    category: "",
    assetNo: "",
    name: "Laptop",
    acquisitionDate: new Date().toISOString().slice(0, 10),
    costTxn: 2000,
    currency: "SGD",
    fxRate: 1,
    usefulLifeMonths: 36,
    salvageBase: 0,
    offsetAccountId: "",
    memo: "",
  });
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });

  const [purchasePeriod, setPurchasePeriod] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });
  const [purchaseEntries, setPurchaseEntries] = useState<PurchaseEntryRow[]>([]);

  const [depEntries, setDepEntries] = useState<DepEntryRow[]>([]);

  const [disposePeriod, setDisposePeriod] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });
  const [disposeEntries, setDisposeEntries] = useState<DisposeEntryRow[]>([]);

  const [journalModalOpen, setJournalModalOpen] = useState(false);
  const [journalDetail, setJournalDetail] = useState<JournalDetail | null>(null);
  const [journalErr, setJournalErr] = useState<string | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);

  const [editMetaOpen, setEditMetaOpen] = useState(false);
  const [editMetaAssetId, setEditMetaAssetId] = useState<string | null>(null);
  const [editMetaCategory, setEditMetaCategory] = useState<string>("");
  const [editMetaAssetNo, setEditMetaAssetNo] = useState<string>("");

  const [disposeForm, setDisposeForm] = useState({
    assetId: "",
    date: new Date().toISOString().slice(0, 10),
    proceedsBase: 0,
    cashAccountId: "",
    gainLossAccountId: "",
  });

  const cashAccounts = useMemo(
    () => accounts.filter((a) => ((a as any).isActive ?? true) || a.id === disposeForm.cashAccountId),
    [accounts, disposeForm.cashAccountId],
  );

  const gainLossAccounts = useMemo(
    () => accounts.filter((a) => ((a as any).isActive ?? true) || a.id === disposeForm.gainLossAccountId),
    [accounts, disposeForm.gainLossAccountId],
  );

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

  const categoryOrder = [
    "Machinery and Equipment",
    "Vehicles",
    "Computer",
    "Furniture and Fixtures",
    "Renovation",
    "Intangible Fixed Assets",
  ];

  const assetsByCategory = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of assets) {
      const c = (a.category || "Uncategorized").trim() || "Uncategorized";
      const arr = map.get(c) || [];
      arr.push(a);
      map.set(c, arr);
    }
    return map;
  }, [assets]);

  const categoriesToRender = useMemo(() => {
    const existing = Array.from(assetsByCategory.keys());
    const ordered = categoryOrder.filter((c) => assetsByCategory.has(c));
    const rest = existing.filter((c) => !categoryOrder.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...rest];
  }, [assetsByCategory]);

  const scheduleByCategory = useMemo(() => {
    const map = new Map<string, ScheduleRow[]>();
    for (const r of scheduleRows) {
      const c = (r.category || "Uncategorized").trim() || "Uncategorized";
      const arr = map.get(c) || [];
      arr.push(r);
      map.set(c, arr);
    }
    return map;
  }, [scheduleRows]);

  const scheduleCategoriesToRender = useMemo(() => {
    const existing = Array.from(scheduleByCategory.keys());
    const ordered = categoryOrder.filter((c) => scheduleByCategory.has(c));
    const rest = existing.filter((c) => !categoryOrder.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...rest];
  }, [scheduleByCategory]);

  function sumScheduleRows(rows: ScheduleRow[]): ScheduleTotals {
    return rows.reduce(
      (acc, r) => {
        acc.openingCost += r.openingCost;
        acc.additions += r.additions;
        acc.disposals += r.disposals;
        acc.closingCost += r.closingCost;
        acc.openingAccumDep += r.openingAccumDep;
        acc.depExpense += r.depExpense;
        acc.accumDepDisposed += r.accumDepDisposed;
        acc.closingAccumDep += r.closingAccumDep;
        acc.netBookValue += r.netBookValue;
        return acc;
      },
      {
        openingCost: 0,
        additions: 0,
        disposals: 0,
        closingCost: 0,
        openingAccumDep: 0,
        depExpense: 0,
        accumDepDisposed: 0,
        closingAccumDep: 0,
        netBookValue: 0,
      },
    );
  }

  function fmtDisposal(v: unknown): string {
    const n = Math.abs(Number(v) || 0);
    return `(${n.toFixed(2)})`;
  }

  async function refresh() {
    const [{ accounts }, { assets }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ assets: any[] }>("/api/fixed-assets"),
    ]);
    setAccounts(accounts as any);
    setAssets(assets as any);
  }

  async function refreshSchedule(start: string, end: string) {
    const r = await api<{ items: ScheduleRow[]; totals: ScheduleTotals }>(
      `/api/reports/fixed-assets-schedule?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );
    setScheduleRows((r.items || []) as any);
    setScheduleTotals((r.totals || null) as any);
  }

  async function deleteAsset(id: string) {
    await api(`/api/fixed-assets/${encodeURIComponent(id)}` as any, { method: "DELETE" });
    await refresh();
    await refreshSchedule(scheduleStart, scheduleEnd);
  }

  async function updateAssetMeta(id: string, category: string, assetNo: string) {
    await api(`/api/fixed-assets/${encodeURIComponent(id)}` as any, {
      method: "PATCH",
      json: { category, assetNo: assetNo.trim() || undefined },
    });
    await refresh();
    await refreshSchedule(scheduleStart, scheduleEnd);
  }

  async function refreshDepEntries(p: string) {
    if (!/^\d{4}-\d{2}$/.test(p)) {
      setDepEntries([]);
      return;
    }
    const r = await api<{ entries: DepEntryRow[] }>(`/api/fixed-assets/depreciation/entries?period=${encodeURIComponent(p)}`);
    setDepEntries((r.entries || []) as any);
  }

  async function refreshPurchaseEntries(p: string) {
    if (!/^\d{4}-\d{2}$/.test(p)) {
      setPurchaseEntries([]);
      return;
    }
    const r = await api<{ entries: PurchaseEntryRow[] }>(`/api/fixed-assets/purchase/entries?period=${encodeURIComponent(p)}`);
    setPurchaseEntries((r.entries || []) as any);
  }

  async function refreshDisposeEntries(p: string) {
    if (!/^\d{4}-\d{2}$/.test(p)) {
      setDisposeEntries([]);
      return;
    }
    const r = await api<{ entries: DisposeEntryRow[] }>(`/api/fixed-assets/disposal/entries?period=${encodeURIComponent(p)}`);
    setDisposeEntries((r.entries || []) as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setAssets([]);
    refresh()
      .then(() => Promise.all([refreshSchedule(scheduleStart, scheduleEnd), refreshDepEntries(period)]))
      .catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    if (tab !== "dispose") return;
    if (!/^\d{4}-\d{2}$/.test(disposePeriod)) return;
    const t = setTimeout(() => {
      refreshDisposeEntries(disposePeriod).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [activeOrgId, orgSwitching, tab, disposePeriod]);

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    if (tab !== "depreciate") return;
    if (!/^\d{4}-\d{2}$/.test(period)) return;
    const t = setTimeout(() => {
      refreshDepEntries(period).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [activeOrgId, orgSwitching, tab, period]);

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    if (tab !== "purchase") return;
    if (!/^\d{4}-\d{2}$/.test(purchasePeriod)) return;
    const t = setTimeout(() => {
      refreshPurchaseEntries(purchasePeriod).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [activeOrgId, orgSwitching, tab, purchasePeriod]);

  useEffect(() => {
    if (!activeOrgId) return;
    const mode = params.get("mode");
    if (mode === "purchase") {
      setTab("purchase");
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
      setTab("depreciate");
      const p = params.get("period");
      if (p && /^\d{4}-\d{2}$/.test(p)) setPeriod(p);
    }
    if (mode === "dispose") {
      setTab("dispose");
      const date = params.get("date");
      setDisposeForm((d) => ({
        ...d,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : d.date,
      }));
    }
  }, [activeOrgId, params]);

  return (
    <AppShell title={tr("固定资产", "Fixed Assets")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
          <div className="grid grid-cols-5 gap-1">
            <button
              className={
                tab === "list"
                  ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                  : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              }
              type="button"
              onClick={() => setTab("list")}
            >
              资产列表
            </button>
            <button
              className={
                tab === "purchase"
                  ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                  : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              }
              type="button"
              onClick={() => setTab("purchase")}
            >
              购买
            </button>
            <button
              className={
                tab === "depreciate"
                  ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                  : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              }
              type="button"
              onClick={() => setTab("depreciate")}
            >
              折旧
            </button>
            <button
              className={
                tab === "dispose"
                  ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                  : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              }
              type="button"
              onClick={() => setTab("dispose")}
            >
              处置
            </button>
            <button
              className={
                tab === "schedule"
                  ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                  : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              }
              type="button"
              onClick={() => setTab("schedule")}
            >
              变动表
            </button>
          </div>
        </div>

        <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (tab === "list" ? "" : "hidden")}>
          <div className="text-sm font-semibold">资产列表</div>
          <div className="mt-3 space-y-4">
            {categoriesToRender.map((cat) => {
              const rows = assetsByCategory.get(cat) || [];
              if (!rows.length) return null;
              return (
                <div key={cat} className="rounded-lg border border-zinc-100">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                    <div className="text-sm font-semibold">{cat}</div>
                    <div className="text-xs text-zinc-600">{rows.length} 项</div>
                  </div>
                  <div className="max-h-[520px] overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-white text-xs text-zinc-600">
                        <tr>
                          <th className="px-3 py-2 text-left">编号</th>
                          <th className="px-3 py-2 text-left">名称</th>
                          <th className="px-3 py-2 text-left">购置日</th>
                          <th className="px-3 py-2 text-left">分录号</th>
                          <th className="px-3 py-2 text-right">金额（交易币）</th>
                          <th className="px-3 py-2 text-left">币种</th>
                          <th className="px-3 py-2 text-right">成本（本位）</th>
                          <th className="px-3 py-2 text-right">折旧月数</th>
                          <th className="px-3 py-2 text-left">备注</th>
                          <th className="px-3 py-2 text-left">状态</th>
                          <th className="px-3 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.id} className="border-t border-zinc-100">
                            <td className="px-3 py-2 whitespace-nowrap">{a.assetNo || "-"}</td>
                            <td className="px-3 py-2">{a.name}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{String(a.acquisitionDate || "").slice(0, 10)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {a.purchaseEntryId ? (
                                <button
                                  className="text-blue-700 hover:underline"
                                  type="button"
                                  onClick={() => openJournalModal(a.purchaseEntryId!)}
                                >
                                  {a.purchaseVoucherNo || "(无分录号)"}
                                </button>
                              ) : (
                                <span className="text-zinc-400">-</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">{Number(a.purchaseCostTxn || 0).toFixed(2)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{a.purchaseCurrency || "-"}</td>
                            <td className="px-3 py-2 text-right">{Number(a.costBase || 0).toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{Number(a.usefulLifeMonths || 0)}</td>
                            <td className="px-3 py-2">{a.purchaseMemo || ""}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{a.status}</td>
                            <td className="px-3 py-2 text-right">
                              <button
                                className="mr-2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                                disabled={busy}
                                onClick={() => {
                                  setErr(null);
                                  setEditMetaAssetId(a.id);
                                  setEditMetaCategory(String(a.category || ""));
                                  setEditMetaAssetNo(String(a.assetNo || ""));
                                  setEditMetaOpen(true);
                                }}
                                type="button"
                              >
                                编辑
                              </button>
                              <button
                                className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                                disabled={busy}
                                onClick={async () => {
                                  const ok = window.confirm("确认删除该固定资产？此操作将从资产列表与变动表移除该记录。");
                                  if (!ok) return;
                                  setBusy(true);
                                  setErr(null);
                                  try {
                                    await deleteAsset(a.id);
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
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (tab === "purchase" ? "" : "hidden")}>
          <div className="text-sm font-semibold">新增资产（自动生成购置分录）</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs text-zinc-600">大类</label>
              <select
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                value={assetForm.category}
                onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })}
              >
                <option value="">请选择</option>
                <option value="Machinery and Equipment">Machinery and Equipment</option>
                <option value="Vehicles">Vehicles</option>
                <option value="Computer">Computer</option>
                <option value="Furniture and Fixtures">Furniture and Fixtures</option>
                <option value="Renovation">Renovation</option>
                <option value="Intangible Fixed Assets">Intangible Fixed Assets</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-600">固定资产编号</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={assetForm.assetNo}
                onChange={(e) => setAssetForm({ ...assetForm, assetNo: e.target.value.toUpperCase() })}
                placeholder={assetForm.category ? "例如：FA-COM00001" : "请先选择大类"}
              />
              <div className="mt-1 text-xs text-zinc-500">留空则系统自动生成（按大类递增）。</div>
            </div>
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
                    {a.code} {a.name}{(a as any).isActive === false ? tr("（已删除）", " (inactive)") : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-zinc-600">备注</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={assetForm.memo}
                onChange={(e) => setAssetForm({ ...assetForm, memo: e.target.value })}
              />
            </div>
          </div>
          <button
            className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
            disabled={busy || !assetForm.offsetAccountId || !assetForm.category}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const memo = assetForm.memo.trim();
                const r = await api<{ entryId: string; voucherNo?: string | null }>("/api/fixed-assets", {
                  method: "POST",
                  json: { ...assetForm, assetNo: assetForm.assetNo.trim() || undefined, memo: memo ? memo : undefined },
                });
                const entryId = (r as any).entryId || (r as any)?.data?.entryId;
                if (!entryId) {
                  throw new Error("保存草稿失败：未返回凭证 ID");
                }
                window.location.href = "/journal";
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存草稿
          </button>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}

          <div className="mt-6 border-t border-zinc-100 pt-4">
            <div className="text-sm font-semibold">购买流水</div>
            <div className="mt-3 flex gap-2">
              <input
                className="w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={purchasePeriod}
                onChange={(e) => setPurchasePeriod(e.target.value)}
                type="month"
              />
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">日期</th>
                    <th className="px-3 py-2 text-left">分录号</th>
                    <th className="px-3 py-2 text-left">资产编号</th>
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-right">成本（本位 {baseCurrency}）</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseEntries.length ? (
                    purchaseEntries.map((e) => (
                      <tr key={e.entryId} className="border-t border-zinc-100">
                        <td className="px-3 py-2">{e.entryDate}</td>
                        <td className="px-3 py-2">
                          <button className="text-blue-700 hover:underline" onClick={() => openJournalModal(e.entryId)} type="button">
                            {e.voucherNo || "-"}
                          </button>
                        </td>
                        <td className="px-3 py-2">{e.assetNos || ""}</td>
                        <td className="px-3 py-2">{e.status}</td>
                        <td className="px-3 py-2 text-right">{Number(e.costBase || 0).toFixed(2)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-3 py-6 text-center text-sm text-zinc-500" colSpan={5}>
                        暂无购买流水
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (tab === "depreciate" ? "" : "hidden")}>
          <div className="text-sm font-semibold">折旧分录</div>
          <div className="mt-3 flex gap-2">
            <input className="w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={period} onChange={(e) => setPeriod(e.target.value)} type="month" />
          </div>

          <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-600">
                <tr>
                  <th className="px-3 py-2 text-left">日期</th>
                  <th className="px-3 py-2 text-left">分录号</th>
                  <th className="px-3 py-2 text-left">资产编号</th>
                  <th className="px-3 py-2 text-left">备注</th>
                  <th className="px-3 py-2 text-right">借（本位 {baseCurrency}）</th>
                </tr>
              </thead>
              <tbody>
                {depEntries.length ? (
                  depEntries.map((e) => (
                    <tr key={e.entryId} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{e.entryDate}</td>
                      <td className="px-3 py-2">
                        <button className="text-blue-700 hover:underline" onClick={() => openJournalModal(e.entryId)} type="button">
                          {e.voucherNo || "-"}
                        </button>
                      </td>
                      <td className="px-3 py-2">{e.assetNos || ""}</td>
                      <td className="px-3 py-2">{e.memo || ""}</td>
                      <td className="px-3 py-2 text-right">{Number(e.debitBase || 0).toFixed(2)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-zinc-500" colSpan={5}>
                      暂无 61xx 分录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (tab === "dispose" ? "" : "hidden")}>
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
                {gainLossAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}{(a as any).isActive === false ? tr("（已删除）", " (inactive)") : ""}
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
                setTab("list");
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            处置并过账
          </button>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}

          <div className="mt-6 border-t border-zinc-100 pt-4">
            <div className="text-sm font-semibold">处置流水</div>
            <div className="mt-3 flex gap-2">
              <input
                className="w-40 rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={disposePeriod}
                onChange={(e) => setDisposePeriod(e.target.value)}
                type="month"
              />
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">日期</th>
                    <th className="px-3 py-2 text-left">分录号</th>
                    <th className="px-3 py-2 text-left">资产编号</th>
                    <th className="px-3 py-2 text-right">处置成本（本位 {baseCurrency}）</th>
                    <th className="px-3 py-2 text-right">处置累计折旧（本位 {baseCurrency}）</th>
                  </tr>
                </thead>
                <tbody>
                  {disposeEntries.length ? (
                    disposeEntries.map((e) => (
                      <tr key={e.entryId} className="border-t border-zinc-100">
                        <td className="px-3 py-2">{e.entryDate}</td>
                        <td className="px-3 py-2">
                          <button className="text-blue-700 hover:underline" onClick={() => openJournalModal(e.entryId)} type="button">
                            {e.voucherNo || "-"}
                          </button>
                        </td>
                        <td className="px-3 py-2">{e.assetNos || ""}</td>
                        <td className="px-3 py-2 text-right">{fmtDisposal(e.costDisposed)}</td>
                        <td className="px-3 py-2 text-right">{fmtDisposal(e.accumDepDisposed)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-3 py-6 text-center text-sm text-zinc-500" colSpan={5}>
                        暂无处置流水
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (tab === "schedule" ? "" : "hidden")}>
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

          <div className="mt-3 space-y-4">
            {scheduleCategoriesToRender.map((cat) => {
              const rows = scheduleByCategory.get(cat) || [];
              if (!rows.length) return null;
              const totals = sumScheduleRows(rows);
              return (
                <div key={cat} className="rounded-lg border border-zinc-100">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                    <div className="text-sm font-semibold">{cat}</div>
                    <div className="text-xs text-zinc-600">{rows.length} 项</div>
                  </div>
                  <div className="overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-white text-xs text-zinc-600">
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
                        {rows.map((r) => (
                          <tr key={r.assetId} className="border-t border-zinc-100">
                            <td className="px-3 py-2">
                              <div className="font-medium">{r.assetNo ? `${r.assetNo} · ${r.name}` : r.name}</div>
                              <div className="text-xs text-zinc-500">
                                {r.acquisitionDate} · {r.status}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">{r.openingCost.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{r.additions.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{fmtDisposal(r.disposals)}</td>
                            <td className="px-3 py-2 text-right">{r.closingCost.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{r.openingAccumDep.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{r.depExpense.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{fmtDisposal(r.accumDepDisposed)}</td>
                            <td className="px-3 py-2 text-right">{r.closingAccumDep.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{r.netBookValue.toFixed(2)}</td>
                          </tr>
                        ))}
                        <tr className="border-t border-zinc-200 bg-zinc-50">
                          <td className="px-3 py-2 font-medium">小计（本位 {baseCurrency}）</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.openingCost.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.additions.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{fmtDisposal(totals.disposals)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.closingCost.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.openingAccumDep.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.depExpense.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{fmtDisposal(totals.accumDepDisposed)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.closingAccumDep.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{totals.netBookValue.toFixed(2)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {scheduleTotals ? (
              <div className="overflow-auto rounded-lg border border-zinc-100">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="bg-zinc-50">
                      <td className="px-3 py-2 font-medium">合计（本位 {baseCurrency}）</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.openingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.additions.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtDisposal(scheduleTotals.disposals)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.closingCost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.openingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.depExpense.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtDisposal(scheduleTotals.accumDepDisposed)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.closingAccumDep.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-medium">{scheduleTotals.netBookValue.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>
      </div>

      {editMetaOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
          onMouseDown={() => {
            setEditMetaOpen(false);
          }}
        >
          <div
            className="w-full max-w-xl rounded-xl bg-white p-4 shadow-xl"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">编辑资产信息</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                type="button"
                onClick={() => setEditMetaOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">大类</label>
                <select
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
                  value={editMetaCategory}
                  onChange={(e) => setEditMetaCategory(e.target.value)}
                >
                  <option value="">请选择</option>
                  <option value="Machinery and Equipment">Machinery and Equipment</option>
                  <option value="Vehicles">Vehicles</option>
                  <option value="Computer">Computer</option>
                  <option value="Furniture and Fixtures">Furniture and Fixtures</option>
                  <option value="Renovation">Renovation</option>
                  <option value="Intangible Fixed Assets">Intangible Fixed Assets</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">固定资产编号</label>
                <input
                  className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                  value={editMetaAssetNo}
                  onChange={(e) => setEditMetaAssetNo(e.target.value.toUpperCase())}
                  placeholder={editMetaCategory ? "例如：FA-COM00001" : "请先选择大类"}
                />
                <div className="mt-1 text-xs text-zinc-500">留空则保持当前值不变。</div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                type="button"
                disabled={busy}
                onClick={() => setEditMetaOpen(false)}
              >
                取消
              </button>
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                type="button"
                disabled={busy || !editMetaAssetId || !editMetaCategory.trim()}
                onClick={async () => {
                  if (!editMetaAssetId) return;
                  setBusy(true);
                  setErr(null);
                  try {
                    await updateAssetMeta(editMetaAssetId, editMetaCategory, editMetaAssetNo);
                    setEditMetaOpen(false);
                  } catch (e: any) {
                    setErr(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
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
    </AppShell>
  );
}
