import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";

type PendingReq = {
  id: string;
  email: string;
  orgName: string;
  baseCurrency: string;
  industry: string;
  createdAt: string;
};

type OrgRow = {
  orgId: string;
  orgName: string;
  baseCurrency: string;
  createdAt: string;
  adminEmails: string[];
};

export default function SuperAdmin() {
  const tr = useTr();
  const { user } = useAuthStore();
  const [requests, setRequests] = useState<PendingReq[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [adminOrgId, setAdminOrgId] = useState<string>("");
  const [adminEmail, setAdminEmail] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canView = useMemo(() => Boolean((user as any)?.isSuperAdmin), [user]);

  async function refresh() {
    const r = await api<{ requests: any[] }>("/api/superadmin/pending-signups");
    setRequests(r.requests as any);
  }

  async function refreshOrgs() {
    const r = await api<{ orgs: any[] }>("/api/superadmin/orgs");
    setOrgs(r.orgs as any);
  }

  useEffect(() => {
    setErr(null);
    if (!canView) return;
    Promise.all([refresh(), refreshOrgs()]).catch((e) => setErr(e.message));
  }, [canView]);

  if (!canView) {
    return (
      <AppShell title="SuperAdmin" subtitle={tr("全局管理员控制台", "Global admin console")}>
        <Card className="p-4 text-sm text-zinc-600">Forbidden</Card>
      </AppShell>
    );
  }

  return (
    <AppShell title="SuperAdmin" subtitle={tr("全局管理员控制台", "Global admin console")}>
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">待审批注册</div>
          <Button size="sm" onClick={() => refresh()}>
            刷新
          </Button>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <TableWrap className="mt-3 max-h-[560px]">
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Company</TH>
                <TH>Industry</TH>
                <TH>Base</TH>
                <TH>Created</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <tbody>
              {requests.map((r) => (
                <TR key={r.id}>
                  <TD>{r.email}</TD>
                  <TD>{r.orgName}</TD>
                  <TD>{r.industry}</TD>
                  <TD>{r.baseCurrency}</TD>
                  <TD>{String(r.createdAt).slice(0, 10)}</TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        loading={busy}
                        onClick={async () => {
                          setBusy(true);
                          setErr(null);
                          try {
                            await api("/api/superadmin/approve-signup", { method: "POST", json: { requestId: r.id } });
                            await refresh();
                          } catch (e: any) {
                            setErr(e.message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {tr("批准", "Approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        loading={busy}
                        onClick={async () => {
                          setBusy(true);
                          setErr(null);
                          try {
                            await api("/api/superadmin/reject-signup", { method: "POST", json: { requestId: r.id } });
                            await refresh();
                          } catch (e: any) {
                            setErr(e.message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {tr("拒绝", "Reject")}
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Card className="mt-4 p-4">
        <div className="text-sm font-semibold">公司 Admin 管理</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Select className="w-64" value={adminOrgId} onChange={(e) => setAdminOrgId(e.target.value)}>
            <option value="">选择公司</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </Select>
          <Input className="w-64" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@example.com" />
          <Button
            variant="primary"
            disabled={busy || !adminOrgId || !adminEmail.trim()}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api("/api/superadmin/set-org-admin", { method: "POST", json: { orgId: adminOrgId, email: adminEmail.trim() } });
                setAdminEmail("");
                await refreshOrgs();
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            设为 Admin
          </Button>
          <Button disabled={busy} onClick={() => refreshOrgs()}>
            刷新列表
          </Button>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <TableWrap className="mt-3 max-h-[560px]">
          <Table>
            <THead>
              <TR>
                <TH>Company</TH>
                <TH>Base</TH>
                <TH>Admins</TH>
              </TR>
            </THead>
            <tbody>
              {orgs.map((o) => (
                <TR key={o.orgId}>
                  <TD>{o.orgName}</TD>
                  <TD>{o.baseCurrency}</TD>
                  <TD>{Array.isArray(o.adminEmails) ? o.adminEmails.join(", ") : ""}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </AppShell>
  );
}
