import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";

function fmt2(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0.00";
  return v.toFixed(2);
}

export default function PartyAging(props: {
  title: string;
  endpointPrefix: string;
  idKey: string;
  codeKey: string;
  nameKey: string;
  baseCurrency: string;
  emptyText: string;
}) {
  const tr = useTr();
  const { activeOrgId, orgSwitching } = useAuthStore();

  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(nextAsOf?: string) {
    const date = (nextAsOf || asOf).trim();
    const r = await api<any>(`${props.endpointPrefix}${encodeURIComponent(date)}`);
    setRows((r?.rows || []) as any[]);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setBusy(true);
    refresh()
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [activeOrgId, orgSwitching]);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm font-semibold">{props.title}</div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label>{tr("截止日期", "As of")}</Label>
            <Input className="mt-1 w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} type="date" />
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await refresh(asOf);
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
            type="button"
          >
            {tr("刷新", "Refresh")}
          </Button>
        </div>
      </div>

      {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      <TableWrap className="mt-3">
        <Table>
          <THead>
            <tr>
              <TH>{tr("对象", "Party")}</TH>
              <TH className="text-right">0-30</TH>
              <TH className="text-right">31-60</TH>
              <TH className="text-right">61-90</TH>
              <TH className="text-right">90+</TH>
              <TH className="text-right">{tr("合计", "Total")}</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => {
              const id = String(r?.[props.idKey] || "");
              const code = String(r?.[props.codeKey] || "");
              const name = String(r?.[props.nameKey] || "");
              const label = `${code ? code + " " : ""}${name}`.trim();
              return (
                <TR key={id}>
                  <TD>{label || "-"}</TD>
                  <TD className="text-right whitespace-nowrap">{fmt2(r.b0_30)} {props.baseCurrency}</TD>
                  <TD className="text-right whitespace-nowrap">{fmt2(r.b31_60)} {props.baseCurrency}</TD>
                  <TD className="text-right whitespace-nowrap">{fmt2(r.b61_90)} {props.baseCurrency}</TD>
                  <TD className="text-right whitespace-nowrap">{fmt2(r.b90p)} {props.baseCurrency}</TD>
                  <TD className="text-right whitespace-nowrap font-medium">{fmt2(r.total)} {props.baseCurrency}</TD>
                </TR>
              );
            })}
            {!rows.length ? (
              <TR>
                <TD className="py-8 text-center text-sm text-zinc-500" colSpan={6}>
                  {busy ? tr("加载中...", "Loading...") : props.emptyText}
                </TD>
              </TR>
            ) : null}
          </tbody>
        </Table>
      </TableWrap>
    </Card>
  );
}
