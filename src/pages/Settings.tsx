import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

type Account = { id: string; code: string; name: string; type: string; normalBalance: string };
type CostCenter = { id: string; code: string; name: string };

export default function Settings() {
  const { orgs, activeOrgId, switchOrg, createInvite } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);

  async function refresh() {
    const [{ accounts }, { costCenters }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
    ]);
    setAccounts(accounts as any);
    setCostCenters(costCenters as any);
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message));
  }, []);

  return (
    <AppShell title="设置">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">组织与切换</div>
            <div className="mt-3 flex items-center gap-2">
              <select
                className="w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm"
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
            {active ? <div className="mt-2 text-sm text-zinc-600">Base currency: {active.baseCurrency}</div> : null}
          </div>

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
                  {['owner','admin','accountant','viewer','auditor'].map((r) => (
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
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">Chart of Accounts（只读）</div>
            <div className="mt-3 max-h-[360px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{a.code}</td>
                      <td className="px-3 py-2">{a.name}</td>
                      <td className="px-3 py-2">{a.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">Cost Centers（只读）</div>
            <div className="mt-3 max-h-[220px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Name</th>
                  </tr>
                </thead>
                <tbody>
                  {costCenters.map((c) => (
                    <tr key={c.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{c.code}</td>
                      <td className="px-3 py-2">{c.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {err ? <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
    </AppShell>
  );
}

