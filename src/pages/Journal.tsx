import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";

type Account = { id: string; code: string; name: string };
type CostCenter = { id: string; code: string; name: string };

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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [entries, setEntries] = useState<EntryListRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [draftDate, setDraftDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [draftCurrency, setDraftCurrency] = useState("SGD");
  const [draftFx, setDraftFx] = useState(1);
  const [draftMemo, setDraftMemo] = useState("");
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
    const [{ accounts }, { costCenters }, { entries }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
      api<{ entries: any[] }>("/api/journals"),
    ]);
    setAccounts(accounts as any);
    setCostCenters(costCenters as any);
    setEntries(entries as any);
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
      <div className="grid gap-4 lg:grid-cols-2">
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
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">日期</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">币种</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftCurrency} onChange={(e) => setDraftCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">汇率（交易币 → 本位）</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftFx} onChange={(e) => setDraftFx(Number(e.target.value) || 1)} type="number" step="0.0001" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">摘要</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={draftMemo} onChange={(e) => setDraftMemo(e.target.value)} />
              </div>
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
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
                          className="w-24 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
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
                          className="w-24 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
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

            <div className="mt-3 flex items-center justify-between">
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

