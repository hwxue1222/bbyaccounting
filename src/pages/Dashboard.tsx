import { Link } from "react-router-dom";
import AppShell from "@/components/AppShell";

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
  return (
    <AppShell title="工作台">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="分录" desc="手工凭证（借贷平衡）、上传附件、过账" to="/journal" />
        <Card title="库存 FIFO" desc="入库/出库联动分录，自动计算出货成本" to="/inventory" />
        <Card title="固定资产" desc="新增资产、按期折旧、处置" to="/fixed-assets" />
        <Card title="报表" desc="Balance Sheet / P&L / Trial Balance / GL" to="/reports" />
      </div>
    </AppShell>
  );
}

