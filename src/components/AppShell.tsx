import type React from "react";

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Building2, FileText, Package, Settings, Warehouse, LogOut, Users, Handshake, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";

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
      end
    >
      <div className="h-4 w-4">{icon}</div>
      <div className="truncate">{label}</div>
    </NavLink>
  );
}

export default function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { orgs, activeOrgId, pendingOrgId, orgSwitching, switchOrg, createOrg, user, logout } = useAuthStore();
  const active = orgs.find((o) => o.orgId === activeOrgId) || null;
  const { lang, setLang } = useUiStore();
  const tr = useTr();
  const inflight = useUiStore((s) => s.inflight);

  const [showMask, setShowMask] = useState(false);

  useEffect(() => {
    if (!inflight) {
      setShowMask(false);
      return;
    }
    const t = window.setTimeout(() => setShowMask(true), 300);
    return () => window.clearTimeout(t);
  }, [inflight]);


  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {showMask ? (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/25">
          <div className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-xl">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-blue-700" />
            <div className="text-sm font-medium text-zinc-800">{tr("刷新中...", "Refreshing...")}</div>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-[1000] hidden w-64 border-r border-zinc-200 bg-white md:flex md:flex-col">
          <div className="border-b border-zinc-200 p-4">
            <div className="flex items-center gap-2">
              <Warehouse className="h-5 w-5 text-blue-700" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">BBY Accounting</div>
                <div className="truncate text-xs text-zinc-500">MVP</div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-xs text-zinc-500">{tr("当前公司", "Company")}</div>
              <div className="mt-1 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-zinc-500" />
                <select
                  className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                  value={(pendingOrgId || activeOrgId) || ""}
                  onChange={(e) => switchOrg(e.target.value)}
                  disabled={orgSwitching}
                >
                  <option value="" disabled>
                    {tr("请选择", "Select")}
                  </option>
                  {orgs.map((o) => (
                    <option key={o.orgId} value={o.orgId}>
                      {o.orgName}
                    </option>
                  ))}
                </select>
              </div>
              {orgSwitching ? <div className="mt-1 text-xs text-zinc-500">{tr("切换中...", "Switching...")}</div> : null}
              <button
                className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50"
                onClick={async () => {
                  const name = window.prompt(tr("公司名称", "Company name"));
                  if (!name || !name.trim()) return;
                  const base = (window.prompt(tr("基准币（默认 SGD）", "Base currency (default SGD)"), active?.baseCurrency || "SGD") || "SGD").toUpperCase();
                  await createOrg(name.trim(), base);
                }}
                disabled={orgSwitching}
              >
                {tr("新增公司", "New company")}
              </button>
              {active ? (
                <div className="mt-1 text-xs text-zinc-500">
                  Base: {active.baseCurrency} · Role: {active.role}
                </div>
              ) : null}
            </div>
          </div>

          <nav className="flex-1 space-y-1 p-3">
            <SideLink to="/settings" label={tr("设置", "Settings")} icon={<Settings className="h-4 w-4" />} />
            <SideLink to="/journal" label={tr("分录", "Journals")} icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/inventory" label={tr("库存 FIFO", "Inventory FIFO")} icon={<Package className="h-4 w-4" />} />
            <SideLink to="/fixed-assets" label={tr("固定资产", "Fixed Assets")} icon={<Warehouse className="h-4 w-4" />} />
            <SideLink to="/vendors" label={tr("供应商", "Vendors")} icon={<Handshake className="h-4 w-4" />} />
            <SideLink to="/customers" label={tr("客户", "Customers")} icon={<UserRound className="h-4 w-4" />} />
            <SideLink to="/reports" label={tr("报表", "Reports")} icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/users" label={tr("用户", "Users")} icon={<Users className="h-4 w-4" />} />
          </nav>

          <div className="border-t border-zinc-200 p-3">
            <div className="mb-2 truncate text-xs text-zinc-500">{user?.email || ""}</div>
            <div className="mb-2 rounded-xl border border-zinc-200 bg-white p-1">
              <div className="grid grid-cols-2 gap-1">
                <button
                  className={
                    lang === "zh"
                      ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                      : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  }
                  type="button"
                  onClick={() => setLang("zh")}
                >
                  中文
                </button>
                <button
                  className={
                    lang === "en"
                      ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                      : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  }
                  type="button"
                  onClick={() => setLang("en")}
                >
                  EN
                </button>
              </div>
            </div>
            <button
              className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
              onClick={() => logout()}
            >
              <LogOut className="h-4 w-4" />
              {tr("退出", "Logout")}
            </button>
          </div>
        </aside>

        <main className="flex-1 md:pl-64">
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
