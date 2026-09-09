import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

type Account = { id: string; code: string; name: string };
type CostCenter = { id: string; code: string; name: string };
type Currency = { id: string; code: string; isEnabled: boolean };

type EntryListRow = {
  id: string;
  entryDate: string;
  status: string;
  currency: string;
  fxRate: number;
  memo: string | null;
  totalDebitBase: string;
};

type EntryDetail = {
  entry: { id: string; entryDate: string; status: string; currency: string; fxRate: number; memo: string | null };
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

export default function Journal() {
  const { orgs, activeOrgId } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [entries, setEntries] = useState<EntryListRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const [draftCurrency, setDraftCurrency] = useState("SGD");
  const [draftFx, setDraftFx] = useState(1);
  const [draftMemo, setDraftMemo] = useState("");
  const [inventoryImpact, setInventoryImpact] = useState(false);
  const [draftLines, setDraftLines] = useState(() => [
    { accountId: "", description: "", costCenterId: "", debitTxn: 0, creditTxn: 0 },
    { accountId: "", description: "", costCenterId: "", debitTxn: 0, creditTxn: 0 },
  ]);

  const baseDiff = useMemo(() => {
    const debit = draftLines.reduce((s, l) => s + (Number(l.debitTxn) || 0) * draftFx, 0);
    const credit = draftLines.reduce((s, l) => s + (Number(l.creditTxn) || 0) * draftFx, 0);
    return Math.round((debit - credit) * 100) / 100;
  }, [draftLines, draftFx]);

  async function refresh() {
    const [{ accounts }, { costCenters }, { currencies }, { entries }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
      api<{ currencies: any[] }>("/api/settings/currencies"),
      api<{ entries: any[] }>("/api/journals"),
    ]);
    setAccounts(accounts as any);
    setCostCenters(costCenters as any);
    setCurrencies(currencies as any);
    setEntries(entries as any);
  }

  useEffect(() => {
    setDraftCurrency(baseCurrency);
    setDraftFx(1);
  }, [baseCurrency]);

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
      throw new Error("未找到该日期的历史汇率，请到设置里新增 FX Rate");
    }
    setDraftFx(Number(fx));
  }

  async function loadDetail(id: string) {
    const d = await api<EntryDetail>(`/api/journals/${id}`);
    setDetail(d);
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((e) => setErr(e.message));
  }, [selectedId]);

  return (
    <AppShell title="分录">
      <div className="grid gap-4 xl:grid-cols-[1fr_1.35fr]">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">凭证列表</div>
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
              onClick={() => refresh()}
            >
              刷新
            </button>
          </div>
          <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                <tr>
                  <th className="px-3 py-2 text-left">日期</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-right">金额(本位)</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    className={
                      "cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 " +
                      (selectedId === e.id ? "bg-blue-50" : "")
                    }
                    onClick={() => setSelectedId(e.id)}
                  >
                    <td className="px-3 py-2">{e.entryDate}</td>
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
                    <td className="px-3 py-2 text-right">{Number(e.totalDebitBase).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">新建草稿凭证</div>
          <div className="mt-3 flex items-center gap-2">
            <input id="inventoryImpact" type="checkbox" checked={inventoryImpact} onChange={(e) => setInventoryImpact(e.target.checked)} />
            <label htmlFor="inventoryImpact" className="text-sm text-zinc-700">影响库存（勾选后请到库存模块做入库/出库）</label>
          </div>
          {inventoryImpact ? (
            <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              该凭证与库存成本联动，建议在“库存 FIFO”中完成入库/出库，系统会自动生成对应分录。
            </div>
          ) : null}
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">币种</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={draftCurrency} onChange={(e) => setDraftCurrency(e.target.value.toUpperCase())}>
                  {enabledCurrencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">汇率（交易币 → 本位）</label>
                <div className="mt-1 flex items-center gap-2">
                  <input className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftFx} onChange={(e) => setDraftFx(Number(e.target.value) || 1)} type="number" step="0.0001" />
                  <button
                    className="whitespace-nowrap rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                    disabled={!draftDate.trim() || !draftCurrency.trim()}
                    onClick={async () => {
                      setErr(null);
                      try {
                        await fillFxFromHistory();
                      } catch (e: any) {
                        setErr(e.message);
                      }
                    }}
                  >
                    用历史
                  </button>
                </div>
                <div className="mt-1 text-xs text-zinc-500">本位币 {baseCurrency}：同币种时汇率为 1；其他币种可从设置里的 FX Rates 维护并回填。</div>
              </div>
              <div>
                <label className="text-xs text-zinc-600">摘要</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftMemo} onChange={(e) => setDraftMemo(e.target.value)} />
              </div>
            </div>

            <div className="mt-4 overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">科目</th>
                    <th className="px-3 py-2 text-left">摘要</th>
                    <th className="px-3 py-2 text-left">Cost Center</th>
                    <th className="px-3 py-2 text-right">借</th>
                    <th className="px-3 py-2 text-right">贷</th>
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
                            const next = [...draftLines];
                            next[idx] = { ...l, accountId: e.target.value };
                            setDraftLines(next);
                          }}
                        >
                          <option value="">请选择</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} {a.name}
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
                        >
                          <option value="">(无)</option>
                          {costCenters.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.code} {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                          value={l.debitTxn}
                          onChange={(e) => {
                            const next = [...draftLines];
                            next[idx] = { ...l, debitTxn: Number(e.target.value) || 0 };
                            setDraftLines(next);
                          }}
                          type="number"
                          step="0.01"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                          value={l.creditTxn}
                          onChange={(e) => {
                            const next = [...draftLines];
                            next[idx] = { ...l, creditTxn: Number(e.target.value) || 0 };
                            setDraftLines(next);
                          }}
                          type="number"
                          step="0.01"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className={"text-sm " + (baseDiff === 0 ? "text-green-700" : "text-amber-700")}>
                本位差额：{baseDiff.toFixed(2)}
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() => setDraftLines([...draftLines, { accountId: "", description: "", costCenterId: "", debitTxn: 0, creditTxn: 0 }])}
                >
                  增加行
                </button>
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={busy || baseDiff !== 0 || draftLines.some((l) => !l.accountId)}
                  onClick={async () => {
                    setBusy(true);
                    setErr(null);
                    try {
                      const resp = await api<{ entry: { id: string } }>("/api/journals", {
                        method: "POST",
                        json: {
                          entryDate: draftDate,
                          currency: draftCurrency,
                          fxRate: draftFx,
                          memo: draftMemo,
                          lines: draftLines.map((l) => ({
                            accountId: l.accountId,
                            description: l.description || undefined,
                            costCenterId: l.costCenterId ? l.costCenterId : null,
                            debitTxn: Number(l.debitTxn) || 0,
                            creditTxn: Number(l.creditTxn) || 0,
                          })),
                        },
                      });
                      await refresh();
                      setSelectedId(resp.entry.id);
                    } catch (e: any) {
                      setErr(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  创建草稿
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">凭证详情</div>
            {detail ? (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-zinc-600">
                    {detail.entry.entryDate} · {detail.entry.status} · {detail.entry.currency} @ {detail.entry.fxRate}
                  </div>
                  {detail.entry.status === "draft" ? (
                    <button
                      className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800"
                      onClick={async () => {
                        setBusy(true);
                        setErr(null);
                        try {
                          await api(`/api/journals/${detail.entry.id}/post`, { method: "POST" });
                          await loadDetail(detail.entry.id);
                          await refresh();
                        } catch (e: any) {
                          setErr(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      过账
                    </button>
                  ) : null}
                </div>

                <div className="overflow-auto rounded-lg border border-zinc-100">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 text-xs text-zinc-600">
                      <tr>
                        <th className="px-3 py-2 text-left">行</th>
                        <th className="px-3 py-2 text-left">科目</th>
                        <th className="px-3 py-2 text-right">借(本位)</th>
                        <th className="px-3 py-2 text-right">贷(本位)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((l) => {
                        const acc = accounts.find((a) => a.id === l.accountId);
                        return (
                          <tr key={l.id} className="border-t border-zinc-100">
                            <td className="px-3 py-2">{l.lineNo}</td>
                            <td className="px-3 py-2">{acc ? `${acc.code} ${acc.name}` : l.accountId}</td>
                            <td className="px-3 py-2 text-right">{Number(l.debitBase).toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{Number(l.creditBase).toFixed(2)}</td>
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
      </div>
    </AppShell>
  );
}
