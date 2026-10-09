import AppShell from "@/components/AppShell";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import { useEffect } from "react";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export default function PendingApproval() {
  const tr = useTr();
  const { user, logout, bootstrap } = useAuthStore();

  useEffect(() => {
    const t = window.setInterval(() => {
      bootstrap().catch(() => null);
    }, 2500);
    return () => window.clearInterval(t);
  }, [bootstrap]);

  return (
    <AppShell title={tr("等待审批", "Pending Approval")} subtitle={tr("SuperAdmin 审批通过后自动进入系统", "You will enter the system after approval")}> 
      <Card className="p-4 text-sm text-zinc-700">
        <div className="text-base font-semibold">{tr("注册成功，等待 SuperAdmin 审批", "Signed up. Waiting for SuperAdmin approval")}</div>
        <div className="mt-2 text-sm text-zinc-600">
          {tr(
            `当前账号：${user?.email || ""}。审批通过后页面会自动进入系统。`,
            `Current account: ${user?.email || ""}. You can use the system after approval.`,
          )}
        </div>
        <Button className="mt-4" onClick={() => logout()}>
          {tr("退出登录", "Logout")}
        </Button>
      </Card>
    </AppShell>
  );
}
