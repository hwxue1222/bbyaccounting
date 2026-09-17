import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

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
      <AppShell title="SuperAdmin">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 shadow-sm">Forbidden</div>
      </AppShell>
    );
  }

  return (
    <AppShell title="SuperAdmin">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">待审批注册</div>
          <button className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50" onClick={() => refresh()}>
            刷新
          </button>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <div className="mt-3 max-h-[560px] overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Industry</th>
                <th className="px-3 py-2 text-left">Base</th>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100">
                  <td className="px-3 py-2">{r.email}</td>
                  <td className="px-3 py-2">{r.orgName}</td>
                  <td className="px-3 py-2">{r.industry}</td>
                  <td className="px-3 py-2">{r.baseCurrency}</td>
                  <td className="px-3 py-2">{String(r.createdAt).slice(0, 10)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        className="rounded-md bg-green-700 px-2 py-1 text-xs font-medium text-white hover:bg-green-800 disabled:opacity-50"
                        disabled={busy}
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
                      </button>
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                        disabled={busy}
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
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold">公司 Admin 管理</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <select className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={adminOrgId} onChange={(e) => setAdminOrgId(e.target.value)}>
            <option value="">选择公司</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
          <input
            className="rounded-md border border-zinc-200 px-3 py-2 text-sm"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="admin@example.com"
          />
          <button
            className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
            disabled={busy || !adminOrgId || !adminEmail.trim()}
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
          </button>
          <button className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50" onClick={() => refreshOrgs()}>
            刷新列表
          </button>
        </div>

        {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

        <div className="mt-3 max-h-[560px] overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
              <tr>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Base</th>
                <th className="px-3 py-2 text-left">Admins</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.orgId} className="border-t border-zinc-100">
                  <td className="px-3 py-2">{o.orgName}</td>
                  <td className="px-3 py-2">{o.baseCurrency}</td>
                  <td className="px-3 py-2">{Array.isArray(o.adminEmails) ? o.adminEmails.join(", ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
