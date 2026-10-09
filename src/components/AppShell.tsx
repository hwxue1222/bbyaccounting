import type React from "react";

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Building2, FileText, Package, Settings, Warehouse, LogOut, Users, Handshake, UserRound, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useUiStore } from "@/stores/uiStore";
import { useTr } from "@/lib/tr";
import ToastViewport from "@/components/ui/Toast";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";
import PageHeader from "@/components/ui/PageHeader";
import Modal from "@/components/ui/Modal";

function SideLink({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
          isActive
            ? "bg-blue-50 text-blue-800 ring-1 ring-blue-100"
            : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900",
        )
      }
      end
    >
      <div className="h-4 w-4">{icon}</div>
      <div className="truncate">{label}</div>
    </NavLink>
  );
}

export default function AppShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { orgs, activeOrgId, pendingOrgId, orgSwitching, switchOrg, createOrg, user, logout } = useAuthStore();
  const active = orgs.find((o) => o.orgId === activeOrgId) || null;
  const { lang, setLang } = useUiStore();
  const tr = useTr();
  const inflight = useUiStore((s) => s.inflight);
  const inflightStartedAt = useUiStore((s) => s.inflightStartedAt);

  const [showMask, setShowMask] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!inflight) {
      setShowMask(false);
      return;
    }
    const t = window.setTimeout(() => setShowMask(true), 1200);
    return () => window.clearTimeout(t);
  }, [inflight]);


  return (
    <div className="min-h-screen">
      <ToastViewport />
      <Modal
        open={mobileNavOpen}
        title={tr("菜单", "Menu")}
        onClose={() => setMobileNavOpen(false)}
        widthClassName="max-w-md"
      >
        <div className="space-y-4">
          <div>
            <div className="text-xs text-zinc-500">{tr("当前公司", "Company")}</div>
            <div className="mt-1 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-zinc-500" />
              <Select
                className="py-1"
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
              </Select>
            </div>
            {active ? <div className="mt-1 text-xs text-zinc-500">Base: {active.baseCurrency} · Role: {active.role}</div> : null}
          </div>

          <nav className="space-y-1">
            {(user as any)?.isSuperAdmin ? (
              <NavLink
                to="/superadmin"
                onClick={() => setMobileNavOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
                    isActive ? "bg-blue-50 text-blue-800 ring-1 ring-blue-100" : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900",
                  )
                }
                end
              >
                <UserRound className="h-4 w-4" />
                SuperAdmin
              </NavLink>
            ) : null}
            <SideLink to="/settings" label={tr("设置", "Settings")} icon={<Settings className="h-4 w-4" />} />
            <SideLink to="/journal" label={tr("分录", "Journals")} icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/inventory" label={tr("库存 FIFO", "Inventory FIFO")} icon={<Package className="h-4 w-4" />} />
            <SideLink to="/fixed-assets" label={tr("固定资产", "Fixed Assets")} icon={<Warehouse className="h-4 w-4" />} />
            <SideLink to="/vendors" label={tr("供应商", "Vendors")} icon={<Handshake className="h-4 w-4" />} />
            <SideLink to="/customers" label={tr("客户", "Customers")} icon={<UserRound className="h-4 w-4" />} />
            <SideLink to="/reports" label={tr("报表", "Reports")} icon={<FileText className="h-4 w-4" />} />
            <SideLink to="/users" label={tr("用户", "Users")} icon={<Users className="h-4 w-4" />} />
          </nav>

          <div>
            <div className="mb-2 truncate text-xs text-zinc-500">{user?.email || ""}</div>
            <Segmented className="grid-cols-2">
              <SegmentedItem active={lang === "zh"} onClick={() => setLang("zh")}>中文</SegmentedItem>
              <SegmentedItem active={lang === "en"} onClick={() => setLang("en")}>EN</SegmentedItem>
            </Segmented>
            <Button className="mt-3 w-full" onClick={() => logout()}>
              <LogOut className="h-4 w-4" />
              {tr("退出", "Logout")}
            </Button>
          </div>
        </div>
      </Modal>
      {showMask ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex items-center gap-3 rounded-xl bg-white/95 px-4 py-3 shadow-xl ring-1 ring-zinc-200">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-200 border-t-blue-700" />
          <div className="text-sm font-medium text-zinc-800">
            {tr("刷新中...", "Refreshing...")}
            {inflightStartedAt ? (
              <span className="ml-2 text-xs font-normal text-zinc-500">{Math.max(1, Math.round((Date.now() - inflightStartedAt) / 1000))}s</span>
            ) : null}
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
                <Select
                  className="py-1"
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
                </Select>
              </div>
              {orgSwitching ? <div className="mt-1 text-xs text-zinc-500">{tr("切换中...", "Switching...")}</div> : null}
              <Button
                className="mt-2 w-full"
                onClick={async () => {
                  if (!(user as any)?.isSuperAdmin) return;
                  const name = window.prompt(tr("公司名称", "Company name"));
                  if (!name || !name.trim()) return;
                  const industry =
                    (window.prompt(tr("行业：restaurant/trading/service", "Industry: restaurant/trading/service"), "restaurant") || "restaurant").trim() ||
                    "restaurant";
                  const base = (window.prompt(tr("基准币（默认 SGD）", "Base currency (default SGD)"), active?.baseCurrency || "SGD") || "SGD").toUpperCase();
                  await createOrg(name.trim(), base, industry);
                }}
                disabled={orgSwitching}
              >
                {tr("新增公司", "New company")}
              </Button>
              {!(user as any)?.isSuperAdmin ? <div className="mt-1 text-xs text-zinc-500">Only SuperAdmin can create companies.</div> : null}
              {active ? (
                <div className="mt-1 text-xs text-zinc-500">
                  Base: {active.baseCurrency} · Role: {active.role}
                </div>
              ) : null}
            </div>
          </div>

          <nav className="flex-1 space-y-1 p-3">
            {(user as any)?.isSuperAdmin ? <SideLink to="/superadmin" label="SuperAdmin" icon={<UserRound className="h-4 w-4" />} /> : null}
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
            <div className="mb-2">
              <Segmented className="grid-cols-2">
                <SegmentedItem active={lang === "zh"} onClick={() => setLang("zh")}>
                  中文
                </SegmentedItem>
                <SegmentedItem active={lang === "en"} onClick={() => setLang("en")}>
                  EN
                </SegmentedItem>
              </Segmented>
            </div>
            <Button className="w-full" onClick={() => logout()}>
              <LogOut className="h-4 w-4" />
              {tr("退出", "Logout")}
            </Button>
          </div>
        </aside>

        <main className="flex-1 md:pl-64">
          <header className="border-b border-zinc-200 bg-white">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4">
              <div className="md:hidden">
                <Button size="sm" onClick={() => setMobileNavOpen(true)} aria-label={tr("打开菜单", "Open menu")}>
                  <Menu className="h-4 w-4" />
                </Button>
              </div>
              <div className="w-full">
                <PageHeader title={title} subtitle={subtitle} actions={actions} />
              </div>
            </div>
          </header>

          <div className="mx-auto w-full max-w-6xl px-4 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
