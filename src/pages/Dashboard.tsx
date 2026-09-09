import { Link } from "react-router-dom";
import AppShell from "@/components/AppShell";
import { useTr } from "@/lib/tr";

function Card({ title, desc, to }: { title: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:shadow"
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-zinc-500">{desc}</div>
    </Link>
  );
}

export default function Dashboard() {
  const tr = useTr();
  return (
    <AppShell title={tr("工作台", "Dashboard")}>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={tr("分录", "Journals")} desc={tr("手工凭证（借贷平衡）、上传附件、过账", "Manual journals, attachments, posting")} to="/journal" />
        <Card title={tr("库存 FIFO", "Inventory FIFO")} desc={tr("入库/出库联动分录，自动计算出货成本", "Inventory linked to journals with FIFO costing")} to="/inventory" />
        <Card title={tr("固定资产", "Fixed Assets")} desc={tr("新增资产、按期折旧、处置", "Add assets, depreciation, disposal")} to="/fixed-assets" />
        <Card title={tr("报表", "Reports")} desc={tr("资产负债表 / 损益表 / 试算平衡表 / 总账", "Balance Sheet / P&L / Trial Balance / GL")} to="/reports" />
      </div>
    </AppShell>
  );
}
