import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import PartyAging from "@/components/PartyAging";
import PartyList from "@/components/PartyList";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

export default function Customers() {
  const tr = useTr();
  const { orgs, activeOrgId } = useAuthStore();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = (active?.baseCurrency || "").toUpperCase();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") || "list") as "list" | "aging";

  return (
    <AppShell title={tr("客户", "Customers")}>
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">{tr("客户与AR账龄", "Customers & AR aging")}</div>
              <div className="mt-1 text-sm text-zinc-500">{tr("维护客户主数据，并查看应收账龄。", "Manage customers and view AR aging.")}</div>
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
                {tr("客户", "Customers")}
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
                {tr("AR 账龄", "AR Aging")}
              </button>
            </div>
          </div>
        </div>

        {tab === "list" ? (
          <PartyList title={tr("客户列表", "Customer list")} listEndpoint="/api/customers" listKey="customers" createEndpoint="/api/customers" patchEndpointPrefix="/api/customers/" />
        ) : (
          <PartyAging
            title={tr("AR Aging（应收账龄）", "AR Aging")}
            endpointPrefix="/api/reports/ar-aging?asOf="
            idKey="customerId"
            codeKey="customerCode"
            nameKey="customerName"
            baseCurrency={baseCurrency}
            emptyText={tr("暂无未结清应收单据", "No open AR documents")}
          />
        )}
      </div>
    </AppShell>
  );
}

