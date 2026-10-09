import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import Select from "@/components/ui/Select";
import IconButton from "@/components/ui/IconButton";
import { Copy } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";
import EmptyState from "@/components/ui/EmptyState";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";
import Switch from "@/components/ui/Switch";

type MemberRow = {
  id: string;
  userId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
};

type RolePermRow = {
  role: string;
  permissions: string[];
};

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
};

const PERM_GROUPS: Array<{ key: string; label: string; actions: string[] }> = [
  { key: "settings", label: "Settings", actions: ["view", "edit"] },
  { key: "journal", label: "Journals", actions: ["view", "edit"] },
  { key: "inventory", label: "Inventory FIFO", actions: ["view", "edit"] },
  { key: "fixedAssets", label: "Fixed Assets", actions: ["view", "edit"] },
  { key: "vendors", label: "Vendors", actions: ["view", "edit"] },
  { key: "customers", label: "Customers", actions: ["view", "edit"] },
  { key: "reports", label: "Reports", actions: ["view"] },
  { key: "users", label: "Users", actions: ["manage"] },
];

export default function Users() {
  const { orgs, activeOrgId, orgSwitching, createInvite, user } = useAuthStore();
  const tr = useTr();
  const toast = useUiStore((s) => s.toast);
  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const canManage = Boolean((active?.permissions || []).includes("users.manage") || active?.role === "admin");

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rolePerms, setRolePerms] = useState<RolePermRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);

  const rolePermByRole = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rolePerms) m.set(String(r.role), Array.isArray(r.permissions) ? r.permissions : []);
    return m;
  }, [rolePerms]);

  async function refresh() {
    const r = await api<{ members: any[] }>("/api/users/members");
    setMembers(r.members as any);
  }

  async function refreshRolePerms() {
    const r = await api<{ roles: any[] }>("/api/users/role-permissions");
    setRolePerms(r.roles as any);
  }

  async function refreshInvitations() {
    const r = await api<{ invitations: any[] }>("/api/users/invitations");
    setInvitations(r.invitations as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setInviteUrl(null);
    Promise.all([refresh(), refreshRolePerms(), refreshInvitations()]).catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  return (
    <AppShell title={tr("用户管理", "User Management")} subtitle={tr("邀请与管理公司成员", "Invite and manage company members")}>
      {!canManage ? (
        <Card className="p-4 text-sm text-zinc-600">只有 Admin 可以管理用户。</Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">角色权限</div>
            <TableWrap className="mt-3 max-h-[520px]">
              <Table>
                <THead>
                  <TR>
                    <TH>Role</TH>
                    <TH>Permissions</TH>
                    <TH className="text-right">Action</TH>
                  </TR>
                </THead>
                <tbody>
                  {(["admin", "accountant", "viewer", "auditor"] as const).map((role) => {
                    const perms = rolePermByRole.get(role) ?? [];
                    const permSet = new Set(perms);
                    return (
                      <TR key={role} className="align-top">
                        <TD className="font-medium">{role}</TD>
                        <TD>
                          <div className="grid gap-2">
                            {PERM_GROUPS.map((g) => (
                              <div key={g.key} className="grid gap-1">
                                <div className="text-xs font-semibold text-zinc-700">{g.label}</div>
                                <div className="flex flex-wrap gap-3">
                                  {g.actions.map((a) => {
                                    const p = `${g.key}.${a}`;
                                    const checked = permSet.has(p);
                                    const disabled = busy || !canManage;
                                    return (
                                      <div key={p} className="inline-flex items-center gap-2 text-xs text-zinc-700">
                                        <Switch
                                          checked={checked}
                                          disabled={disabled}
                                          onClick={async () => {
                                            const next = !checked ? Array.from(new Set([...perms, p])) : perms.filter((x) => x !== p);
                                            setBusy(true);
                                            setErr(null);
                                            try {
                                              await api("/api/users/role-permissions", { method: "PATCH", json: { role, permissions: next } });
                                              await refreshRolePerms();
                                            } catch (err: any) {
                                              setErr(err.message);
                                            } finally {
                                              setBusy(false);
                                            }
                                          }}
                                        />
                                        {a}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </TD>
                        <TD className="text-right">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              setErr(null);
                              try {
                                await refreshRolePerms();
                              } catch (err: any) {
                                setErr(err.message);
                              }
                            }}
                          >
                            刷新
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            {!canManage ? <div className="mt-2 text-xs text-zinc-500">没有权限修改角色权限。</div> : null}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">邀请用户</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <Label>邮箱</Label>
                <Input className="mt-1" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div>
                <Label>角色</Label>
                <Select className="mt-1" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  {(["admin", "accountant", "viewer", "auditor"] as const).map((r) => (
                    <option key={r} value={r} disabled={r === "admin" && !(user as any)?.isSuperAdmin}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Button
              variant="primary"
              className="mt-3"
              disabled={busy || !inviteEmail.trim()}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                setInviteUrl(null);
                try {
                  const r = await createInvite(inviteEmail, inviteRole);
                  setInviteUrl(r.inviteUrl);
                  await refreshInvitations();
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              生成邀请链接
            </Button>
            {inviteUrl ? (
              <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-zinc-600">邀请链接</div>
                  <IconButton
                    aria-label="Copy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteUrl);
                        toast({ type: "success", message: "已复制邀请链接" });
                      } catch {
                        toast({ type: "error", message: "复制失败，请手动复制" });
                      }
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </IconButton>
                </div>
                <div className="mt-2 break-all font-mono text-xs text-zinc-700">{inviteUrl}</div>
              </div>
            ) : null}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">待接受邀请</div>
              <Button size="sm" disabled={busy} onClick={() => refreshInvitations()}>
                刷新
              </Button>
            </div>
            {invitations.length ? (
              <TableWrap className="mt-3 max-h-[260px]">
                <Table>
                  <THead>
                    <TR>
                      <TH>Email</TH>
                      <TH>Role</TH>
                      <TH>Expires</TH>
                      <TH className="text-right">Action</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {invitations.map((inv) => (
                      <TR key={inv.id}>
                        <TD>{inv.email}</TD>
                        <TD>{inv.role}</TD>
                        <TD className="text-xs text-zinc-600">{String(inv.expiresAt || "").slice(0, 10)}</TD>
                        <TD className="text-right">
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            loading={busy}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                await api(`/api/users/invitations/${inv.id}/revoke`, { method: "POST" });
                                await refreshInvitations();
                              } catch (e: any) {
                                setErr(e.message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            Revoke
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            ) : (
              <EmptyState className="mt-3" title={tr("暂无邀请", "No invitations")} description={tr("生成一条邀请链接后会出现在这里。", "Create an invitation link and it will show up here.")} />
            )}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">成员列表</div>
              <Button size="sm" onClick={() => refresh()}>
                刷新
              </Button>
            </div>

            <TableWrap className="mt-3 max-h-[520px]">
              <Table>
                <THead>
                  <TR>
                    <TH>Email</TH>
                    <TH>Role</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Action</TH>
                  </TR>
                </THead>
                <tbody>
                  {members.map((m) => (
                    <TR key={m.id}>
                      <TD>{m.email}</TD>
                      <TD>
                        <Select
                          className="w-full"
                          value={m.role}
                          disabled={busy}
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
                            <option key={r} value={r} disabled={r === "admin" && !(user as any)?.isSuperAdmin}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </TD>
                      <TD>{m.status}</TD>
                      <TD className="text-right">
                        <Button
                          size="sm"
                          variant={m.status === "active" ? "danger" : "secondary"}
                          disabled={busy}
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
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>

            {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
