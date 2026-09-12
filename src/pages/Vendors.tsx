import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import PartyAging from "@/components/PartyAging";
import PartyList from "@/components/PartyList";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

export default function Vendors() {
  const tr = useTr();
  const { orgs, activeOrgId } = useAuthStore();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = (active?.baseCurrency || "").toUpperCase();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") || "list") as "list" | "aging";

  return (
    <AppShell title={tr("供应商", "Vendors")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">{tr("供应商与AP账龄", "Vendors & AP aging")}</div>
              <div className="mt-1 text-sm text-zinc-500">{tr("维护供应商主数据，并查看应付账龄。", "Manage vendors and view AP aging.")}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className={
                  tab === "list"
                    ? "rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white"
                    : "rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                }
                onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "list" }) as any)}
                type="button"
              >
                {tr("供应商", "Vendors")}
              </button>
              <button
                className={
                  tab === "aging"
                    ? "rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white"
                    : "rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                }
                onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "aging" }) as any)}
                type="button"
              >
                {tr("AP 账龄", "AP Aging")}
              </button>
            </div>
          </div>
        </div>

        {tab === "list" ? (
          <PartyList title={tr("供应商列表", "Vendor list")} listEndpoint="/api/vendors" listKey="vendors" createEndpoint="/api/vendors" patchEndpointPrefix="/api/vendors/" />
        ) : (
          <PartyAging
            title={tr("AP Aging（应付账龄）", "AP Aging")}
            endpointPrefix="/api/reports/ap-aging?asOf="
            idKey="vendorId"
            codeKey="vendorCode"
            nameKey="vendorName"
            baseCurrency={baseCurrency}
            emptyText={tr("暂无未结清应付单据", "No open AP documents")}
          />
        )}
      </div>
    </AppShell>
  );
}
