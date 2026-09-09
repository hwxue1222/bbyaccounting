import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type MemberRow = {
  id: string;
  userId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
};

export default function Users() {
  const { orgs, activeOrgId, orgSwitching, createInvite } = useAuthStore();
  const tr = useTr();
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await api<{ members: any[] }>("/api/users/members");
    setMembers(r.members as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setInviteUrl(null);
    refresh().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  return (
    <AppShell title={tr("用户管理", "User Management")}>
      {!canManage ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 shadow-sm">只有 Owner/Admin 可以管理用户。</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">邀请用户</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-zinc-600">邮箱</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div>
                <label className="text-xs text-zinc-600">角色</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  {(["admin", "accountant", "viewer", "auditor"] as const).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !inviteEmail.trim()}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                setInviteUrl(null);
                try {
                  const r = await createInvite(inviteEmail, inviteRole);
                  setInviteUrl(r.inviteUrl);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              生成邀请链接
            </button>
            {inviteUrl ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm">
                <div className="text-xs text-zinc-600">邀请链接</div>
                <div className="mt-1 break-all font-mono text-xs">{inviteUrl}</div>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">成员列表</div>
              <button className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50" onClick={() => refresh()}>
                刷新
              </button>
            </div>

            <div className="mt-3 max-h-[520px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Email</th>
                    <th className="px-3 py-2 text-left">Role</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{m.email}</td>
                      <td className="px-3 py-2">
                        <select
                          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm"
                          value={m.role}
                          disabled={active?.role !== "owner"}
                          onChange={async (e) => {
                            setErr(null);
                            try {
                              await api(`/api/users/members/${m.id}`, { method: "PATCH", json: { role: e.target.value } });
                              await refresh();
                            } catch (err: any) {
                              setErr(err.message);
                            }
                          }}
                        >
                          {(["admin", "accountant", "viewer", "auditor"] as const).map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">{m.status}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                          onClick={async () => {
                            setErr(null);
                            try {
                              await api(`/api/users/members/${m.id}`, {
                                method: "PATCH",
                                json: { status: m.status === "active" ? "disabled" : "active" },
                              });
                              await refresh();
                            } catch (err: any) {
                              setErr(err.message);
                            }
                          }}
                        >
                          {m.status === "active" ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
          </div>
        </div>
      )}
    </AppShell>
  );
}
