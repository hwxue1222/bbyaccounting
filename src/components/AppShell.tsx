import type React from "react";
import { NavLink } from "react-router-dom";
import { Building2, FileText, LayoutDashboard, Package, Settings, Warehouse, LogOut, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";

function SideLink({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
          isActive ? "bg-blue-50 text-blue-700" : "text-zinc-700 hover:bg-zinc-100",
        )
      }
    >
      <div className="h-4 w-4">{icon}</div>
      <div className="truncate">{label}</div>
    </NavLink>
  );
}

export default function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { orgs, activeOrgId, switchOrg, createOrg, user, logout } = useAuthStore();
  const active = orgs.find((o) => o.orgId === activeOrgId) || null;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white md:flex md:flex-col">
          <div className="border-b border-zinc-200 p-4">
            <div className="flex items-center gap-2">
              <Warehouse className="h-5 w-5 text-blue-700" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">BBY Accounting</div>
                <div className="truncate text-xs text-zinc-500">MVP</div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-xs text-zinc-500">当前组织</div>
              <div className="mt-1 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-zinc-500" />
                <select
                  className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                  value={activeOrgId || ""}
                  onChange={(e) => switchOrg(e.target.value)}
                >
                  <option value="" disabled>
                    请选择
                  </option>
                  {orgs.map((o) => (
                    <option key={o.orgId} value={o.orgId}>
                      {o.orgName}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
                onClick={async () => {
                  const name = window.prompt("组织名称");
                  if (!name || !name.trim()) return;
                  const base = (window.prompt("本位币（默认 SGD）", active?.baseCurrency || "SGD") || "SGD").toUpperCase();
                  await createOrg(name.trim(), base);
                }}
              >
                新增组织
              </button>
              {active ? (
                <div className="mt-1 text-xs text-zinc-500">
                  Base: {active.baseCurrency} · Role: {active.role}
                </div>
              ) : null}
            </div>
          </div>

          <nav className="flex-1 space-y-1 p-3">
            <SideLink to="/" label="工作台" icon={<LayoutDashboard className="h-4 w-4" />} />
            <SideLink to="/journal" label="分录" icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/inventory" label="库存 FIFO" icon={<Package className="h-4 w-4" />} />
            <SideLink to="/fixed-assets" label="固定资产" icon={<Warehouse className="h-4 w-4" />} />
            <SideLink to="/reports" label="报表" icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/users" label="用户" icon={<Users className="h-4 w-4" />} />
            <SideLink to="/settings" label="设置" icon={<Settings className="h-4 w-4" />} />
          </nav>

          <div className="border-t border-zinc-200 p-3">
            <div className="mb-2 truncate text-xs text-zinc-500">{user?.email || ""}</div>
            <button
              className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
              onClick={() => logout()}
            >
              <LogOut className="h-4 w-4" />
              退出
            </button>
          </div>
        </aside>

        <main className="flex-1">
          <header className="border-b border-zinc-200 bg-white">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">{title}</div>
              </div>
            </div>
          </header>

          <div className="mx-auto w-full max-w-6xl px-4 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
