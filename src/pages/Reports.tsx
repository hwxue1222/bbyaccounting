import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";
import FilterBar from "@/components/ui/FilterBar";

type Account = { id: string; code: string; name: string; type: string };
type CostCenter = { id: string; code: string; name: string };

export default function Reports() {
  const { activeOrgId, orgSwitching, orgs } = useAuthStore();
  const tr = useTr();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [tab, setTab] = useState<"tb" | "pl" | "bs" | "gl" | "tax">("tb");
  const [taxKind, setTaxKind] = useState<"gst" | "sst">("gst");
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

  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = useMemo(() => (active?.baseCurrency || "BASE").toUpperCase(), [active?.baseCurrency]);

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
      } else if (tab === "tax") {
        if (taxKind === "gst") {
          const r = await api<{ enabled: boolean; gstRate?: number; rows: any[] }>(`/api/reports/tax/gst-form5?start=${start}&end=${end}`);
          setRows(r.rows);
        } else {
          const r = await api<{ enabled: boolean; sstRate?: number; rows: any[] }>(`/api/reports/tax/sst-summary?start=${start}&end=${end}`);
          setRows(r.rows);
        }
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

  async function drillToGL(nextAccountId: string, nextStart: string, nextEnd: string) {
    setBusy(true);
    setErr(null);
    setTab("gl");
    setAccountId(nextAccountId);
    setStart(nextStart);
    setEnd(nextEnd);
    try {
      const ccParam = costCenterId ? `&costCenterId=${encodeURIComponent(costCenterId)}` : "";
      const accountParam = nextAccountId ? `accountId=${encodeURIComponent(nextAccountId)}&` : "";
      const r = await api<{ sections: any[] }>(`/api/reports/gl?${accountParam}start=${nextStart}&end=${nextEnd}${ccParam}`);
      setRows(r.sections);
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
    if (tab === "tax") {
      return rows.filter((r: any) => Math.round(Number(r.amount ?? 0) * 100) / 100 !== 0);
    }

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
    return `${baseCurrency} ${abs.toFixed(2)} ${side}`;
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
    <AppShell title={tr("报表", "Reports")} subtitle={tr("生成并导出常用财务报表", "Generate and export standard financial reports")}>
      <Card className="p-4">
        <FilterBar
          left={
            <Segmented className="grid-cols-5">
              {([
                { k: "tb", t: "Trial Balance" },
                { k: "pl", t: "Profit & Loss" },
                { k: "bs", t: "Balance Sheet" },
                { k: "gl", t: "General Ledger" },
                { k: "tax", t: "Tax" },
              ] as const).map((x) => (
                <SegmentedItem key={x.k} active={tab === x.k} onClick={() => setTab(x.k)}>
                  {x.t}
                </SegmentedItem>
              ))}
            </Segmented>
          }
          right={
            <>
              {exportUrl ? (
                <Button onClick={() => window.open(exportUrl, "_blank")} type="button">
                  导出XLSX
                </Button>
              ) : null}
              <Button variant="primary" disabled={busy} onClick={run}>
                {busy ? "生成中..." : "生成"}
              </Button>
            </>
          }
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {tab === "bs" ? <Input className="w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} /> : null}
          {tab !== "bs" ? (
            <>
              <Input className="w-44" value={start} onChange={(e) => setStart(e.target.value)} />
              <Input className="w-44" value={end} onChange={(e) => setEnd(e.target.value)} />
            </>
          ) : null}

          {tab === "tax" ? (
            <Select className="w-52" value={taxKind} onChange={(e) => setTaxKind(e.target.value as any)}>
              <option value="gst">GST Form 5</option>
              <option value="sst">SST Summary</option>
            </Select>
          ) : null}

          {tab === "gl" ? (
            <Select className="w-72" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All Accounts</option>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          ) : null}

          <Select className="w-72" value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)} disabled={tab === "tax"}>
            <option value="">All Cost Centers</option>
            <option value="__none__">(No Cost Center)</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} {c.name}
              </option>
            ))}
          </Select>

          <Button onClick={() => setHideZero((v) => !v)} type="button">
            {hideZero ? tr("显示 0 金额", "Show zero") : tr("隐藏 0 金额", "Hide zero")}
          </Button>
          <div className="ml-auto text-sm text-zinc-600">{baseCurrency}</div>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <TableWrap className="mt-4 max-h-[560px]">
          <Table>
            <THead>
              {tab === "tax" ? (
                <TR>
                  <TH>Item</TH>
                  <TH className="text-right">Amount ({baseCurrency})</TH>
                </TR>
              ) : tab === "gl" ? (
                <TR>
                  <TH>科目</TH>
                  <TH>日期</TH>
                  <TH>分录号</TH>
                  <TH>摘要</TH>
                  <TH>成本中心</TH>
                  <TH className="text-right">借（{baseCurrency}）</TH>
                  <TH className="text-right">贷（{baseCurrency}）</TH>
                  <TH className="text-right">余额（{baseCurrency}）</TH>
                </TR>
              ) : tab === "tb" ? (
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH className="text-right">Opening Dr ({baseCurrency})</TH>
                  <TH className="text-right">Opening Cr ({baseCurrency})</TH>
                  <TH className="text-right">Period Dr ({baseCurrency})</TH>
                  <TH className="text-right">Period Cr ({baseCurrency})</TH>
                  <TH className="text-right">Closing Dr ({baseCurrency})</TH>
                  <TH className="text-right">Closing Cr ({baseCurrency})</TH>
                </TR>
              ) : (
                <TR>
                  <TH>Account</TH>
                  <TH className="text-right">Amount ({baseCurrency})</TH>
                </TR>
              )}
            </THead>
            <tbody>
              {tab === "tax" ? (
                (displayRows as any[]).map((r, idx) => (
                  <TR key={idx}>
                    <TD>{String(r.label || r.code || "")}</TD>
                    <TD className="text-right">{Number(r.amount ?? 0).toFixed(2)}</TD>
                  </TR>
                ))
              ) : tab === "gl"
                ? glRows.map((r, idx) => {
                    if (r.kind === "section") {
                      return (
                        <TR key={idx} className="bg-zinc-50 font-semibold hover:bg-zinc-50">
                          <TD colSpan={8}>
                            {r.label}
                          </TD>
                        </TR>
                      );
                    }
                    if (r.kind === "account") {
                      return (
                        <TR key={idx} className="bg-white font-semibold hover:bg-white">
                          <TD colSpan={8}>
                            {`${r.accountCode} ${r.accountName}`.trim()}
                          </TD>
                        </TR>
                      );
                    }
                    if (r.kind === "opening") {
                      return (
                        <TR key={idx} className="bg-white hover:bg-white">
                          <TD></TD>
                          <TD></TD>
                          <TD></TD>
                          <TD className="text-zinc-600">Opening Balance</TD>
                          <TD></TD>
                          <TD className="text-right"></TD>
                          <TD className="text-right"></TD>
                          <TD className="text-right">{fmtBalance(Number(r.balanceNet || 0))}</TD>
                        </TR>
                      );
                    }
                    if (r.kind === "closing") {
                      return (
                        <TR key={idx} className="bg-zinc-50 font-medium hover:bg-zinc-50">
                          <TD></TD>
                          <TD></TD>
                          <TD></TD>
                          <TD className="text-zinc-700">Closing Balance</TD>
                          <TD></TD>
                          <TD className="text-right"></TD>
                          <TD className="text-right"></TD>
                          <TD className="text-right">{fmtBalance(Number(r.balanceNet || 0))}</TD>
                        </TR>
                      );
                    }
                    const cc = r.costCenterCode ? `${r.costCenterCode} ${r.costCenterName || ""}`.trim() : "";
                    return (
                      <TR key={idx}>
                        <TD></TD>
                        <TD>{r.entryDate}</TD>
                        <TD>
                          {r.entryId ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/journal?entryId=${encodeURIComponent(String(r.entryId))}`)}
                              type="button"
                            >
                              {String(r.voucherNo || "").trim() || String(r.entryId).slice(0, 8)}
                            </Button>
                          ) : null}
                        </TD>
                        <TD>{r.memo || r.description || ""}</TD>
                        <TD>{cc}</TD>
                        <TD className="text-right">{Number(r.debitBase ?? 0).toFixed(2)}</TD>
                        <TD className="text-right">{Number(r.creditBase ?? 0).toFixed(2)}</TD>
                        <TD className="text-right">{fmtBalance(Number(r.balanceNet || 0))}</TD>
                      </TR>
                    );
                  })
                : displayRows.map((r, idx) =>
                    tab === "tb" ? (
                      <TR key={idx}>
                        <TD>{r.code}</TD>
                        <TD>{r.name}</TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.openingDebit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.openingCredit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.periodDebit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.periodCredit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.closingDebit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                        <TD className="text-right">
                          <Button variant="ghost" size="sm" disabled={!r.accountId} onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                            {Number(r.closingCredit ?? 0).toFixed(2)}
                          </Button>
                        </TD>
                      </TR>
                    ) : tab === "pl" ? (
                      <TR
                        key={idx}
                        className={
                          ("border-t border-zinc-100 " +
                            (r.isTotal ? "bg-zinc-50 font-semibold" : r.isHeader ? "bg-white font-semibold" : "")).trim()
                        }
                      >
                        <TD className={(r.isHeader ? "text-zinc-900" : "").trim()}>
                          {r.isHeader ? r.name : `${r.code ? `${r.code} ` : ""}${r.name || ""}`.trim()}
                        </TD>
                        <TD className="text-right">
                          {r.amount === null || r.amount === undefined ? (
                            ""
                          ) : r.accountId ? (
                            <Button variant="ghost" size="sm" onClick={() => drillToGL(String(r.accountId), start, end)} type="button">
                              {Number(r.amount).toFixed(2)}
                            </Button>
                          ) : (
                            Number(r.amount).toFixed(2)
                          )}
                        </TD>
                      </TR>
                    ) : (
                      <TR
                        key={idx}
                        className={
                          ("border-t border-zinc-100 " +
                            (r.isTotal ? "bg-zinc-50 font-semibold" : r.isHeader ? "bg-white font-semibold" : "")).trim()
                        }
                      >
                        <TD style={{ paddingLeft: `${8 + Number(r.indent || 0) * 16}px` }}>
                          {r.label || r.name || ""}
                        </TD>
                        <TD className="text-right">
                          {r.amount === null || r.amount === undefined ? (
                            ""
                          ) : r.accountId ? (
                            <Button variant="ghost" size="sm" onClick={() => drillToGL(String(r.accountId), `${asOf.slice(0, 4)}-01-01`, asOf)} type="button">
                              {Number(r.amount).toFixed(2)}
                            </Button>
                          ) : (
                            Number(r.amount).toFixed(2)
                          )}
                        </TD>
                      </TR>
                    ),
                  )}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </AppShell>
  );
}
