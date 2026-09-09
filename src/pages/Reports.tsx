import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";

type Account = { id: string; code: string; name: string; type: string };
type CostCenter = { id: string; code: string; name: string };

export default function Reports() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [tab, setTab] = useState<"tb" | "pl" | "bs" | "gl">("tb");
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

  const accountOptions = useMemo(() => accounts.slice().sort((a, b) => a.code.localeCompare(b.code)), [accounts]);

  useEffect(() => {
    Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
    ])
      .then(([a, c]) => {
        setAccounts(a.accounts as any);
        setCostCenters(c.costCenters as any);
      })
      .catch((e) => setErr(e.message));
  }, []);

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
        const r = await api<{ lines: any[] }>(`/api/reports/gl?${accountParam}start=${start}&end=${end}${ccParam}`);
        setRows(r.lines);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="报表">
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
          <button
            className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
            disabled={busy}
            onClick={run}
          >
            {busy ? "生成中..." : "生成"}
          </button>
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
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <div className="mt-4 max-h-[560px] overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
              {tab === "gl" ? (
                <tr>
                  {!accountId ? <th className="px-3 py-2 text-left">科目</th> : null}
                  <th className="px-3 py-2 text-left">日期</th>
                  <th className="px-3 py-2 text-left">摘要</th>
                  <th className="px-3 py-2 text-right">借</th>
                  <th className="px-3 py-2 text-right">贷</th>
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
                  <th className="px-3 py-2 text-left">Section</th>
                  <th className="px-3 py-2 text-left">Code</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              ) : (
                <tr>
                  <th className="px-3 py-2 text-left">Section</th>
                  <th className="px-3 py-2 text-left">Code</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((r, idx) =>
                tab === "gl" ? (
                  <tr key={idx} className="border-t border-zinc-100">
                    {!accountId ? <td className="px-3 py-2">{r.accountCode ? `${r.accountCode} ${r.accountName || ""}`.trim() : ""}</td> : null}
                    <td className="px-3 py-2">{r.entryDate}</td>
                    <td className="px-3 py-2">{r.memo || r.description || ""}</td>
                    <td className="px-3 py-2 text-right">{Number(r.debitBase ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{Number(r.creditBase ?? 0).toFixed(2)}</td>
                  </tr>
                ) : tab === "tb" ? (
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
                  <tr key={idx} className={("border-t border-zinc-100 " + (r.isTotal ? "bg-zinc-50 font-semibold" : "")).trim()}>
                    <td className="px-3 py-2">{r.section}</td>
                    <td className="px-3 py-2">{r.code}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right">{Number(r.amount ?? 0).toFixed(2)}</td>
                  </tr>
                ) : (
                  <tr key={idx} className={("border-t border-zinc-100 " + (r.isTotal ? "bg-zinc-50 font-semibold" : "")).trim()}>
                    <td className="px-3 py-2">{r.section}</td>
                    <td className="px-3 py-2">{r.code}</td>
                    <td className="px-3 py-2">{r.variance !== undefined ? `${r.name} (${Number(r.variance).toFixed(2)})` : r.name}</td>
                    <td className="px-3 py-2 text-right">{Number(r.debit ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">{Number(r.credit ?? 0).toFixed(2)}</td>
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
