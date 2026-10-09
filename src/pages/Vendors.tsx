import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import AppShell from "@/components/AppShell";
import PartyAging from "@/components/PartyAging";
import PartyList from "@/components/PartyList";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";
import FilterBar from "@/components/ui/FilterBar";

export default function Vendors() {
  const tr = useTr();
  const { orgs, activeOrgId } = useAuthStore();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const baseCurrency = (active?.baseCurrency || "").toUpperCase();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") || "list") as "list" | "aging";

  return (
    <AppShell title={tr("供应商", "Vendors")} subtitle={tr("维护供应商主数据，并查看应付账龄。", "Manage vendors and view AP aging.")}>
      <div className="space-y-4">
        <FilterBar
          left={
            <Segmented className="grid-cols-2">
              <SegmentedItem active={tab === "list"} onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "list" }) as any)}>
                {tr("供应商", "Vendors")}
              </SegmentedItem>
              <SegmentedItem active={tab === "aging"} onClick={() => setParams((p) => ({ ...Object.fromEntries(p.entries()), tab: "aging" }) as any)}>
                {tr("AP 账龄", "AP Aging")}
              </SegmentedItem>
            </Segmented>
          }
        />

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
