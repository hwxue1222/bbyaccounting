import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type Account = { id: string; code: string; name: string; type: string };
type CostCenter = { id: string; code: string; name: string };

export default function Reports() {
  const { activeOrgId, orgSwitching } = useAuthStore();
  const tr = useTr();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [tab, setTab] = useState<"tb" | "pl" | "bs" | "gl">("tb");
  const [hideZero, setHideZero] = useState(true);
  const [start, setStart] = useState(() => {
    const d = new Date();
    const s = new Date(d.getFullYear(), d.getMonth(), 1);
    return s.toISOString().slice(0, 10);
  });
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState<string>("");
  const [costCenterId, setCostCenterId] = useState<string>("");
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accountOptions = useMemo(
    () => accounts.filter((a) => ((a as any).isActive ?? true) || a.id === accountId).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [accounts, accountId],
  );

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setRows([]);
    setAccountId("");
    setCostCenterId("");
    Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
    ])
      .then(([a, c]) => {
        setAccounts(a.accounts as any);
        setCostCenters(c.costCenters as any);
      })
      .catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const ccParam = costCenterId ? `&costCenterId=${encodeURIComponent(costCenterId)}` : "";
      if (tab === "tb") {
        const r = await api<{ rows: any[] }>(`/api/reports/trial-balance?start=${start}&end=${end}${ccParam}`);
        setRows(r.rows);
      } else if (tab === "pl") {
        const r = await api<{ rows: any[] }>(`/api/reports/profit-loss?start=${start}&end=${end}${ccParam}`);
        setRows(r.rows);
      } else if (tab === "bs") {
        const r = await api<{ rows: any[] }>(`/api/reports/balance-sheet?asOf=${asOf}${ccParam}`);
        setRows(r.rows);
      } else {
        const accountParam = accountId ? `accountId=${encodeURIComponent(accountId)}&` : "";
        const r = await api<{ sections: any[] }>(`/api/reports/gl?${accountParam}start=${start}&end=${end}${ccParam}`);
        setRows(r.sections);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const exportUrl = useMemo(() => {
    const ccParam = costCenterId ? `&costCenterId=${encodeURIComponent(costCenterId)}` : "";
    if (tab === "pl") {
      return `/api/reports/profit-loss.xlsx?start=${start}&end=${end}${ccParam}`;
    }
    if (tab === "bs") {
      return `/api/reports/balance-sheet.xlsx?asOf=${asOf}${ccParam}`;
    }
    return null;
  }, [tab, start, end, asOf, costCenterId]);

  const displayRows = useMemo(() => {
    if (!hideZero) return rows;

    if (tab === "gl") return rows;

    if (tab === "tb") {
      return rows.filter((r) => {
        const nums = [
          Number(r.openingDebit ?? 0),
          Number(r.openingCredit ?? 0),
          Number(r.periodDebit ?? 0),
          Number(r.periodCredit ?? 0),
          Number(r.closingDebit ?? 0),
          Number(r.closingCredit ?? 0),
        ];
        return nums.some((n) => Math.round(n * 100) / 100 !== 0);
      });
    }

    if (tab === "pl" || tab === "bs") {
      return rows.filter((r) => {
        if (r.isHeader || r.isTotal) return true;
        const amt = Number(r.amount ?? 0);
        return Math.round(amt * 100) / 100 !== 0;
      });
    }

    return rows;
  }, [rows, tab, hideZero]);

  function fmtBalance(net: number) {
    const n = Number(net || 0);
    const abs = Math.abs(n);
    const side = n >= 0 ? "Dr" : "Cr";
    return `${abs.toFixed(2)} ${side}`;
  }

  const glRows = useMemo(() => {
    if (tab !== "gl") return [] as any[];

    const sections = Array.isArray(displayRows) ? (displayRows as any[]) : [];
    const out: any[] = [];
    const isZero = (x: number) => Math.round(Number(x || 0) * 100) / 100 === 0;

    for (const s of sections) {
      const accountsIn = Array.isArray(s.accounts) ? s.accounts : [];
      const accounts = hideZero
        ? accountsIn.filter((a: any) => {
            const opening = Number(a.openingNet || 0);
            const closing = Number(a.closingNet || 0);
            const pd = Number(a.periodDebit || 0);
            const pc = Number(a.periodCredit || 0);
            return !(isZero(opening) && isZero(closing) && isZero(pd) && isZero(pc));
          })
        : accountsIn;

      if (!accounts.length) continue;

      out.push({ kind: "section", label: s.label || s.type });
      for (const a of accounts) {
        out.push({ kind: "account", accountCode: a.accountCode, accountName: a.accountName });
        out.push({ kind: "opening", balanceNet: Number(a.openingNet || 0) });
        for (const l of a.lines || []) out.push(l);
        out.push({ kind: "closing", balanceNet: Number(a.closingNet || 0) });
      }
    }

    return out;
  }, [tab, displayRows, hideZero]);

  return (
    <AppShell title={tr("报表", "Reports")}>
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {([
              { k: "tb", t: "Trial Balance" },
              { k: "pl", t: "Profit & Loss" },
              { k: "bs", t: "Balance Sheet" },
              { k: "gl", t: "General Ledger" },
            ] as const).map((x) => (
              <button
                key={x.k}
                className={
                  "rounded-md px-3 py-2 text-sm " +
                  (tab === x.k ? "bg-blue-700 text-white" : "border border-zinc-200 bg-white hover:bg-zinc-50")
                }
                onClick={() => setTab(x.k)}
              >
                {x.t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {exportUrl ? (
              <a
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                href={exportUrl}
              >
                导出XLSX
              </a>
            ) : null}
            <button
              className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
              disabled={busy}
              onClick={run}
            >
              {busy ? "生成中..." : "生成"}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {tab === "bs" ? (
            <>
              <input className="rounded-md border border-zinc-200 px-3 py-2 text-sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </>
          ) : (
            <>
              <input className="rounded-md border border-zinc-200 px-3 py-2 text-sm" value={start} onChange={(e) => setStart(e.target.value)} />
              <input className="rounded-md border border-zinc-200 px-3 py-2 text-sm" value={end} onChange={(e) => setEnd(e.target.value)} />
            </>
          )}

          {tab === "gl" ? (
            <select className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All Accounts</option>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          ) : null}

          <select className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
            <option value="">All Cost Centers</option>
            <option value="__none__">(No Cost Center)</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            {tr("不显示金额为 0 的科目", "Hide zero-amount accounts")}
          </label>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <div className="mt-4 max-h-[560px] overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
              {tab === "gl" ? (
                <tr>
                  <th className="px-3 py-2 text-left">科目</th>
                  <th className="px-3 py-2 text-left">日期</th>
                  <th className="px-3 py-2 text-left">摘要</th>
                  <th className="px-3 py-2 text-left">成本中心</th>
                  <th className="px-3 py-2 text-right">借</th>
                  <th className="px-3 py-2 text-right">贷</th>
                  <th className="px-3 py-2 text-right">余额</th>
                </tr>
              ) : tab === "tb" ? (
                <tr>
                  <th className="px-3 py-2 text-left">Code</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-right">Opening Dr</th>
                  <th className="px-3 py-2 text-right">Opening Cr</th>
                  <th className="px-3 py-2 text-right">Period Dr</th>
                  <th className="px-3 py-2 text-right">Period Cr</th>
                  <th className="px-3 py-2 text-right">Closing Dr</th>
                  <th className="px-3 py-2 text-right">Closing Cr</th>
                </tr>
              ) : tab === "pl" ? (
                <tr>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              ) : (
                <tr>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              )}
            </thead>
            <tbody>
              {tab === "gl"
                ? glRows.map((r, idx) => {
                    if (r.kind === "section") {
                      return (
                        <tr key={idx} className="border-t border-zinc-100 bg-zinc-50 font-semibold">
                          <td className="px-3 py-2" colSpan={7}>
                            {r.label}
                          </td>
                        </tr>
                      );
                    }
                    if (r.kind === "account") {
                      return (
                        <tr key={idx} className="border-t border-zinc-100 bg-white font-semibold">
                          <td className="px-3 py-2" colSpan={7}>
                            {`${r.accountCode} ${r.accountName}`.trim()}
                          </td>
                        </tr>
                      );
                    }
                    if (r.kind === "opening") {
                      return (
                        <tr key={idx} className="border-t border-zinc-100 bg-white">
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2 text-zinc-600">Opening Balance</td>
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2 text-right"></td>
                          <td className="px-3 py-2 text-right"></td>
                          <td className="px-3 py-2 text-right">{fmtBalance(Number(r.balanceNet || 0))}</td>
                        </tr>
                      );
                    }
                    if (r.kind === "closing") {
                      return (
                        <tr key={idx} className="border-t border-zinc-100 bg-zinc-50 font-medium">
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2 text-zinc-700">Closing Balance</td>
                          <td className="px-3 py-2"></td>
                          <td className="px-3 py-2 text-right"></td>
                          <td className="px-3 py-2 text-right"></td>
                          <td className="px-3 py-2 text-right">{fmtBalance(Number(r.balanceNet || 0))}</td>
                        </tr>
                      );
                    }
                    const cc = r.costCenterCode ? `${r.costCenterCode} ${r.costCenterName || ""}`.trim() : "";
                    return (
                      <tr key={idx} className="border-t border-zinc-100">
                        <td className="px-3 py-2"></td>
                        <td className="px-3 py-2">{r.entryDate}</td>
                        <td className="px-3 py-2">{r.memo || r.description || ""}</td>
                        <td className="px-3 py-2">{cc}</td>
                        <td className="px-3 py-2 text-right">{Number(r.debitBase ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.creditBase ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{fmtBalance(Number(r.balanceNet || 0))}</td>
                      </tr>
                    );
                  })
                : displayRows.map((r, idx) =>
                    tab === "tb" ? (
                      <tr key={idx} className="border-t border-zinc-100">
                        <td className="px-3 py-2">{r.code}</td>
                        <td className="px-3 py-2">{r.name}</td>
                        <td className="px-3 py-2 text-right">{Number(r.openingDebit ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.openingCredit ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.periodDebit ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.periodCredit ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.closingDebit ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{Number(r.closingCredit ?? 0).toFixed(2)}</td>
                      </tr>
                    ) : tab === "pl" ? (
                      <tr
                        key={idx}
                        className={
                          ("border-t border-zinc-100 " +
                            (r.isTotal ? "bg-zinc-50 font-semibold" : r.isHeader ? "bg-white font-semibold" : "")).trim()
                        }
                      >
                        <td className={"px-3 py-2 " + (r.isHeader ? "text-zinc-900" : "")}>{r.isHeader ? r.name : `${r.code ? `${r.code} ` : ""}${r.name || ""}`.trim()}</td>
                        <td className="px-3 py-2 text-right">{r.amount === null || r.amount === undefined ? "" : Number(r.amount).toFixed(2)}</td>
                      </tr>
                    ) : (
                      <tr
                        key={idx}
                        className={
                          ("border-t border-zinc-100 " +
                            (r.isTotal ? "bg-zinc-50 font-semibold" : r.isHeader ? "bg-white font-semibold" : "")).trim()
                        }
                      >
                        <td className="px-3 py-2" style={{ paddingLeft: `${8 + Number(r.indent || 0) * 16}px` }}>
                          {r.label || r.name || ""}
                        </td>
                        <td className="px-3 py-2 text-right">{r.amount === null || r.amount === undefined ? "" : Number(r.amount).toFixed(2)}</td>
                      </tr>
                    ),
                  )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
