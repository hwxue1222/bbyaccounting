import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

type Account = { id: string; code: string; name: string };
type CostCenter = { id: string; code: string; name: string };
type Currency = { id: string; code: string; isEnabled: boolean };
type InventoryItem = { id: string; name: string; uom: string };

type EntryListRow = {
  id: string;
  entryDate: string;
  status: string;
  currency: string;
  fxRate: number;
  memo: string | null;
  totalDebitBase: string;
  inventoryImpact?: boolean;
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
  const { orgs, activeOrgId, orgSwitching } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
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

  const [invModalOpen, setInvModalOpen] = useState(false);
  const [invMode, setInvMode] = useState<"receipt" | "shipment">("receipt");
  const [invExpectedTxn, setInvExpectedTxn] = useState<number>(0);
  const [invExpectedBase, setInvExpectedBase] = useState<number>(0);
  const [invDetails, setInvDetails] = useState<Array<{ rowId: string; itemId: string; qty: number; unitCostTxn: number }>>([]);
  const [invConfirmed, setInvConfirmed] = useState<null | { mode: "receipt" | "shipment"; expectedTxn: number; expectedBase: number; quoteBase: number }>(null);
  const [invLineIdx, setInvLineIdx] = useState<number | null>(null);
  const [invDefaultSide, setInvDefaultSide] = useState<"debit" | "credit">("debit");

  const [invEditingDetails, setInvEditingDetails] = useState<Array<{ rowId: string; itemId: string; qty: number; unitCostTxn: number }>>([]);
  const [invQuoteByRow, setInvQuoteByRow] = useState<Record<string, { base: number | null; err: string | null }>>({});
  const [draftLines, setDraftLines] = useState(() => [
    { accountId: "", description: "", costCenterId: "", debitTxn: 0, creditTxn: 0 },
    { accountId: "", description: "", costCenterId: "", debitTxn: 0, creditTxn: 0 },
  ]);

  const baseDiff = useMemo(() => {
    const debit = draftLines.reduce((s, l) => s + (Number(l.debitTxn) || 0) * draftFx, 0);
    const credit = draftLines.reduce((s, l) => s + (Number(l.creditTxn) || 0) * draftFx, 0);
    return Math.round((debit - credit) * 100) / 100;
  }, [draftLines, draftFx]);

  const invLine = useMemo(() => {
    if (invLineIdx == null) return null;
    return draftLines[invLineIdx] || null;
  }, [invLineIdx, draftLines]);

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
    setInventoryItems((items as any[]).map((it) => ({ id: it.id, name: it.name, uom: it.uom })));
  }

  function getInventoryLinkInfoByLine(line: { debitTxn: number; creditTxn: number }): { mode: "receipt" | "shipment"; expectedTxn: number; expectedBase: number } {
    const debit = Number(line.debitTxn) || 0;
    const credit = Number(line.creditTxn) || 0;
    if (debit > 0 && credit > 0) {
      throw new Error("该行不能同时有借和贷。");
    }
    if (debit > 0) {
      return { mode: "receipt", expectedTxn: debit, expectedBase: Math.round(debit * draftFx * 100) / 100 };
    }
    if (credit > 0) {
      return { mode: "shipment", expectedTxn: credit, expectedBase: Math.round(credit * draftFx * 100) / 100 };
    }
    throw new Error("请先在该行输入借方或贷方金额。");
  }

  function newRowId(): string {
    const c: any = (globalThis as any).crypto;
    return typeof c?.randomUUID === "function" ? c.randomUUID() : `${Date.now()}-${Math.random()}`;
  }

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
      : [{ rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: 1, unitCostTxn: info.mode === "receipt" ? info.expectedTxn : 0 }];
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
    const rows = invEditingDetails.filter((d) => d.itemId && d.qty > 0);
    (async () => {
      for (const r of rows) {
        if (cancelled) return;
        try {
          const resp = await api<{ itemId: string; qty: number; totalBase: number }>(
            `/api/inventory/shipments/quote?itemId=${encodeURIComponent(r.itemId)}&qty=${encodeURIComponent(String(r.qty))}`,
          );
          if (cancelled) return;
          setInvQuoteByRow((prev) => ({ ...prev, [r.rowId]: { base: Number(resp.totalBase), err: null } }));
        } catch (e: any) {
          if (cancelled) return;
          setInvQuoteByRow((prev) => ({ ...prev, [r.rowId]: { base: null, err: e.message } }));
        }
      }
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
      throw new Error("未找到该日期的历史汇率，请到设置里新增 FX Rate");
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
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((e) => setErr(e.message));
  }, [selectedId]);

  return (
    <AppShell title="分录">
      <div className="space-y-4">
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
                  <th className="px-3 py-2 text-left">库存</th>
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
                    <td className="px-3 py-2 text-sm">{e.inventoryImpact ? "Yes" : ""}</td>
                    <td className="px-3 py-2 text-right">{Number(e.totalDebitBase).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err ? <div className="mt-3 text-sm text-red-700">{err}</div> : null}
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold">新建草稿凭证</div>
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div>在任意分录行的借方/贷方旁点击“库存”录入入库/出库明细；过账后才会影响 FIFO 成本与库存数量。</div>
            <a className="whitespace-nowrap rounded-md border border-amber-200 bg-white px-2 py-1 text-sm hover:bg-amber-100" href="/inventory">
              查看库存 FIFO
            </a>
          </div>
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
                        <div className="flex items-center justify-end gap-2">
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
                          <button
                            className={
                              "rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 " +
                              (invLineIdx === idx && invMode === "receipt" && invDetails.length ? "border-blue-300 bg-blue-50 text-blue-700" : "border-zinc-200 bg-white")
                            }
                            onClick={() => {
                              setErr(null);
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
                            disabled={busy}
                            type="button"
                          >
                            库存
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
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
                          <button
                            className={
                              "rounded-md border px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 " +
                              (invLineIdx === idx && invMode === "shipment" && invDetails.length ? "border-blue-300 bg-blue-50 text-blue-700" : "border-zinc-200 bg-white")
                            }
                            onClick={() => {
                              setErr(null);
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
                            disabled={busy}
                            type="button"
                          >
                            库存
                          </button>
                        </div>
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
                    setErr(null);
                    if (invDetails.length) {
                      if (invLineIdx == null) {
                        setErr("请先在借方或贷方点击“库存”并确认明细。");
                        return;
                      }
                      const line = draftLines[invLineIdx];
                      if (!line) {
                        setErr("库存关联的分录行无效，请重新填写库存明细。");
                        return;
                      }
                      const debit = Number(line.debitTxn) || 0;
                      const credit = Number(line.creditTxn) || 0;
                      if (debit > 0 && credit > 0) {
                        setErr("库存关联行不能同时有借和贷。");
                        return;
                      }
                      const existingTxn = debit > 0 ? debit : credit > 0 ? credit : 0;
                      const expectedBaseFromExisting = Math.round(existingTxn * draftFx * 100) / 100;

                      const computedReceiptTxn = Math.round(invDetails.reduce((s, d) => s + (Number(d.qty) || 0) * (Number(d.unitCostTxn) || 0), 0) * 100) / 100;
                      const computedShipmentBase = invConfirmed?.quoteBase ?? 0;
                      const computedShipmentTxn = Math.round((computedShipmentBase / (draftFx || 1)) * 100) / 100;

                      if (!invConfirmed || invConfirmed.mode !== invMode) {
                        setErr("请先在库存明细弹窗点击“确认”。");
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
                            setErr("库存入库明细合计必须与该行金额一致。");
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
                          if (Math.round(expectedBaseFromExisting * 100) / 100 !== Math.round(computedShipmentBase * 100) / 100) {
                            setErr("库存出库 FIFO 成本合计必须与该行金额一致（以本位比较）。");
                            try {
                              openInventoryDetailsModal(invLineIdx, "shipment", invDefaultSide);
                            } catch {
                              // ignore
                            }
                            return;
                          }
                        }
                      }

                      if (invMode === "receipt") {
                        // ok
                      }

                      if (invMode === "shipment") {
                        // ok
                      }
                    }

                    setBusy(true);
                    try {
                      const inventoryDetails =
                        invDetails.length && invLineIdx != null
                          ? invDetails.map((d) =>
                              invMode === "receipt"
                                ? { moveType: "receipt", itemId: d.itemId, qty: d.qty, unitCostTxn: d.unitCostTxn }
                                : { moveType: "shipment", itemId: d.itemId, qty: d.qty },
                            )
                          : undefined;

                      let effectiveLines = draftLines.map((l) => ({ ...l }));
                      if (inventoryDetails?.length && invLineIdx != null) {
                        const line = effectiveLines[invLineIdx];
                        const debit = Number(line.debitTxn) || 0;
                        const credit = Number(line.creditTxn) || 0;
                        const existing = debit > 0 ? debit : credit > 0 ? credit : 0;
                        if (existing <= 0) {
                          if (invMode === "receipt") {
                            const totalTxn = Math.round(invDetails.reduce((s, d) => s + (Number(d.qty) || 0) * (Number(d.unitCostTxn) || 0), 0) * 100) / 100;
                            if (invDefaultSide === "credit") {
                              line.creditTxn = totalTxn;
                              line.debitTxn = 0;
                            } else {
                              line.debitTxn = totalTxn;
                              line.creditTxn = 0;
                            }
                          } else {
                            const totalBase = invConfirmed?.quoteBase ?? 0;
                            const totalTxn = Math.round((totalBase / (draftFx || 1)) * 100) / 100;
                            if (invDefaultSide === "debit") {
                              line.debitTxn = totalTxn;
                              line.creditTxn = 0;
                            } else {
                              line.creditTxn = totalTxn;
                              line.debitTxn = 0;
                            }
                          }
                        }
                      }

                      const resp = await api<{ entry: { id: string } }>("/api/journals", {
                        method: "POST",
                        json: {
                          entryDate: draftDate,
                          currency: draftCurrency,
                          fxRate: draftFx,
                          memo: draftMemo,
                          inventoryImpact: Boolean(inventoryDetails?.length),
                          inventoryLinkLineNo: invLineIdx != null && inventoryDetails?.length ? invLineIdx + 1 : undefined,
                          inventoryDetails,
                          lines: effectiveLines.map((l) => ({
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

      {invModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl">
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
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">商品</th>
                    <th className="px-3 py-2 text-right">数量</th>
                    {invMode === "receipt" ? <th className="px-3 py-2 text-right">单价({draftCurrency})</th> : <th className="px-3 py-2 text-right">FIFO 成本(本位)</th>}
                    <th className="px-3 py-2 text-right">金额</th>
                    <th className="px-3 py-2 text-left">操作</th>
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
                                {it.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                            type="number"
                            step="0.0001"
                            value={r.qty}
                            onChange={(e) => {
                              const next = invEditingDetails.map((x) => (x.rowId === r.rowId ? { ...x, qty: Number(e.target.value) || 0 } : x));
                              setInvEditingDetails(next);
                            }}
                          />
                        </td>
                        {invMode === "receipt" ? (
                          <td className="px-3 py-2 text-right">
                            <input
                              className="w-28 rounded-md border border-zinc-200 px-2 py-1 text-right text-sm"
                              type="number"
                              step="0.0001"
                              value={r.unitCostTxn}
                              onChange={(e) => {
                                const next = invEditingDetails.map((x) => (x.rowId === r.rowId ? { ...x, unitCostTxn: Number(e.target.value) || 0 } : x));
                                setInvEditingDetails(next);
                              }}
                            />
                          </td>
                        ) : (
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {q?.err ? <span className="text-red-700">{q.err}</span> : costBase == null ? "-" : costBase.toFixed(2)}
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
                <div>
                  FIFO 合计：{invEditingTotals.totalQuoteBase.toFixed(2)} (本位)；分录金额：{invExpectedBase.toFixed(2)} (本位)
                </div>
                {invEditingDetails.some((r) => invQuoteByRow[r.rowId]?.err) ? (
                  <div className="mt-1 text-sm text-red-700">存在库存不足或数据错误，请调整商品/数量。</div>
                ) : null}
                {invEditingDetails.some((r) => r.itemId && r.qty > 0 && invQuoteByRow[r.rowId]?.base == null && !invQuoteByRow[r.rowId]?.err) ? (
                  <div className="mt-1 text-xs text-zinc-500">正在计算 FIFO 成本…</div>
                ) : null}
                {Math.round(invEditingTotals.totalQuoteBase * 100) / 100 !== Math.round(invExpectedBase * 100) / 100 ? (
                  <div className="mt-1 text-sm text-red-700">FIFO 合计必须与绑定的分录行金额一致（以本位比较）。</div>
                ) : null}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => {
                  setInvEditingDetails([
                    ...invEditingDetails,
                    { rowId: newRowId(), itemId: inventoryItems[0]?.id || "", qty: 1, unitCostTxn: invMode === "receipt" ? 1 : 0 },
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
                    invEditingDetails.some((r) => !r.itemId || r.qty <= 0 || (invMode === "receipt" && r.unitCostTxn <= 0)) ||
                    (invMode === "receipt"
                      ? Math.round(invEditingTotals.totalTxn * 100) / 100 !== Math.round(invExpectedTxn * 100) / 100
                      : invEditingDetails.some((r) => invQuoteByRow[r.rowId]?.base == null || invQuoteByRow[r.rowId]?.err) ||
                        Math.round(invEditingTotals.totalQuoteBase * 100) / 100 !== Math.round(invExpectedBase * 100) / 100)
                  }
                  onClick={() => {
                    setInvDetails(invEditingDetails);
                    setInvConfirmed({ mode: invMode, expectedTxn: invExpectedTxn, expectedBase: invExpectedBase, quoteBase: invMode === "shipment" ? invEditingTotals.totalQuoteBase : 0 });
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
