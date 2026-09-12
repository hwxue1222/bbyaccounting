import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

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
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm font-semibold">{props.title}</div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-xs text-zinc-600">{tr("截止日期", "As of")}</label>
            <input className="mt-1 w-44 rounded-md border border-zinc-200 px-3 py-2 text-sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} type="date" />
          </div>
          <button
            className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
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
          </button>
        </div>
      </div>

      {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      <div className="mt-3 overflow-auto rounded-lg border border-zinc-100">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
            <tr>
              <th className="px-3 py-2 text-left">{tr("对象", "Party")}</th>
              <th className="px-3 py-2 text-right">0-30</th>
              <th className="px-3 py-2 text-right">31-60</th>
              <th className="px-3 py-2 text-right">61-90</th>
              <th className="px-3 py-2 text-right">90+</th>
              <th className="px-3 py-2 text-right">{tr("合计", "Total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = String(r?.[props.idKey] || "");
              const code = String(r?.[props.codeKey] || "");
              const name = String(r?.[props.nameKey] || "");
              const label = `${code ? code + " " : ""}${name}`.trim();
              return (
                <tr key={id} className="border-t border-zinc-100">
                  <td className="px-3 py-2">{label || "-"}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmt2(r.b0_30)} {props.baseCurrency}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmt2(r.b31_60)} {props.baseCurrency}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmt2(r.b61_90)} {props.baseCurrency}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmt2(r.b90p)} {props.baseCurrency}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap font-medium">{fmt2(r.total)} {props.baseCurrency}</td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-zinc-500" colSpan={6}>
                  {busy ? tr("加载中...", "Loading...") : props.emptyText}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

