import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import PartyAging from "@/components/PartyAging";
import PartyList from "@/components/PartyList";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";
import FilterBar from "@/components/ui/FilterBar";

export default function Customers() {
  const tr = useTr();
  const { orgs, activeOrgId } = useAuthStore();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = (active?.baseCurrency || "").toUpperCase();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") || "list") as "list" | "aging";

  return (
    <AppShell title={tr("客户", "Customers")} subtitle={tr("维护客户主数据，并查看应收账龄。", "Manage customers and view AR aging.")}>
      <div className="space-y-4">
        <FilterBar
          left={
            <Segmented className="grid-cols-2">
              <SegmentedItem active={tab === "list"} onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "list" }) as any)}>
                {tr("客户", "Customers")}
              </SegmentedItem>
              <SegmentedItem active={tab === "aging"} onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "aging" }) as any)}>
                {tr("AR 账龄", "AR Aging")}
              </SegmentedItem>
            </Segmented>
          }
        />

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
