import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  isActive?: boolean;
  linkInventoryFifo?: boolean;
  linkFixedAssets?: boolean;
};
type CostCenter = { id: string; code: string; name: string };
type Currency = { id: string; code: string; isEnabled: boolean };
type FxRate = { id: string; rateDate: string; currencyCode: string; fxRate: number };

export default function Settings() {
  const { orgs, activeOrgId, orgSwitching, switchOrg, createInvite, updateOrg } = useAuthStore();
  const tr = useTr();
  const [leftTab, setLeftTab] = useState<"switch" | "profile" | "invite">("switch");
  const [rightTab, setRightTab] = useState<"accounts" | "costCenters" | "currencies" | "fxRates">("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [fxRates, setFxRates] = useState<FxRate[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newAccountCode, setNewAccountCode] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountType, setNewAccountType] = useState<"asset" | "liability" | "equity" | "income" | "cogs" | "expense">("expense");
  const [newAccountNormal, setNewAccountNormal] = useState<"debit" | "credit">("debit");
  const [newAccountLinkInventoryFifo, setNewAccountLinkInventoryFifo] = useState(false);
  const [newAccountLinkFixedAssets, setNewAccountLinkFixedAssets] = useState(false);

  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountCode, setEditAccountCode] = useState("");
  const [editAccountName, setEditAccountName] = useState("");
  const [editAccountType, setEditAccountType] = useState<"asset" | "liability" | "equity" | "income" | "cogs" | "expense">("expense");
  const [editAccountNormal, setEditAccountNormal] = useState<"debit" | "credit">("debit");
  const [editAccountActive, setEditAccountActive] = useState(true);
  const [editAccountLinkInventoryFifo, setEditAccountLinkInventoryFifo] = useState(false);
  const [editAccountLinkFixedAssets, setEditAccountLinkFixedAssets] = useState(false);

  const [newCcCode, setNewCcCode] = useState("");
  const [newCcName, setNewCcName] = useState("");

  const [newCurrencyCode, setNewCurrencyCode] = useState("");

  const [fxDate, setFxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fxCurrency, setFxCurrency] = useState("SGD");
  const [fxValue, setFxValue] = useState(1);

  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);

  const [companyName, setCompanyName] = useState("");
  const [companyRegNo, setCompanyRegNo] = useState("");

  useEffect(() => {
    setCompanyName(active?.orgName || "");
    setCompanyRegNo(active?.registrationNo || "");
  }, [active?.orgId, active?.orgName, active?.registrationNo]);

  useEffect(() => {
    if (active?.baseCurrency) {
      setFxCurrency(active.baseCurrency.toUpperCase());
    }
  }, [active?.baseCurrency]);

  async function refresh() {
    const [{ accounts }, { costCenters }, { currencies }, { fxRates }] = await Promise.all([
      api<{ accounts: any[] }>("/api/settings/accounts"),
      api<{ costCenters: any[] }>("/api/settings/cost-centers"),
      api<{ currencies: any[] }>("/api/settings/currencies"),
      api<{ fxRates: any[] }>("/api/settings/fx-rates?limit=50"),
    ]);
    setAccounts(accounts as any);
    setCostCenters(costCenters as any);
    setCurrencies(currencies as any);
    setFxRates(fxRates as any);
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setInviteUrl(null);
    refresh().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  return (
    <AppShell title={tr("设置", "Settings")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
            <div className="grid grid-cols-3 gap-1">
              <button
                className={
                  leftTab === "switch"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setLeftTab("switch")}
              >
                公司切换
              </button>
              <button
                className={
                  leftTab === "profile"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setLeftTab("profile")}
              >
                公司资料
              </button>
              <button
                className={
                  leftTab === "invite"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setLeftTab("invite")}
              >
                邀请用户
              </button>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (leftTab === "switch" ? "" : "hidden")}
          >
            <div className="text-sm font-semibold">公司与切换</div>
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

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (leftTab === "profile" ? "" : "hidden")}
          >
            <div className="text-sm font-semibold">公司资料</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">公司名称</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">公司注册号</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm" value={companyRegNo} onChange={(e) => setCompanyRegNo(e.target.value)} placeholder="例如：201901234567" />
              </div>
            </div>
            <button
              className="mt-3 rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              disabled={busy || !activeOrgId || !companyName.trim()}
              onClick={async () => {
                if (!activeOrgId) return;
                setBusy(true);
                setErr(null);
                try {
                  await updateOrg(activeOrgId, companyName.trim(), companyRegNo.trim() ? companyRegNo.trim() : null);
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存
            </button>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (leftTab === "invite" ? "" : "hidden")}
          >
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
          <div className="rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
            <div className="grid grid-cols-4 gap-1">
              <button
                className={
                  rightTab === "accounts"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setRightTab("accounts")}
              >
                科目
              </button>
              <button
                className={
                  rightTab === "costCenters"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setRightTab("costCenters")}
              >
                Cost Center
              </button>
              <button
                className={
                  rightTab === "currencies"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setRightTab("currencies")}
              >
                币种
              </button>
              <button
                className={
                  rightTab === "fxRates"
                    ? "rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700"
                    : "rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                }
                type="button"
                onClick={() => setRightTab("fxRates")}
              >
                汇率
              </button>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (rightTab === "accounts" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Chart of Accounts</div>

            <div className="mt-3 grid gap-3 md:grid-cols-5">
              <div>
                <label className="text-xs text-zinc-600">Code</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={newAccountCode} onChange={(e) => setNewAccountCode(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">Name</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">Type</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={newAccountType} onChange={(e) => setNewAccountType(e.target.value as any)}>
                  {(["asset", "liability", "equity", "income", "cogs", "expense"] as const).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">Normal</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={newAccountNormal} onChange={(e) => setNewAccountNormal(e.target.value as any)}>
                  <option value="debit">debit</option>
                  <option value="credit">credit</option>
                </select>
              </div>
              <div className="md:col-span-5 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={newAccountLinkInventoryFifo} onChange={(e) => setNewAccountLinkInventoryFifo(e.target.checked)} />
                  链接库存 FIFO（分录显示“库存”按钮）
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={newAccountLinkFixedAssets} onChange={(e) => setNewAccountLinkFixedAssets(e.target.checked)} />
                  链接固定资产（分录显示“购买/折旧/处置”按钮）
                </label>
              </div>
              <div className="md:col-span-5">
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={!newAccountCode.trim() || !newAccountName.trim()}
                  onClick={async () => {
                    setErr(null);
                    try {
                      await api("/api/settings/accounts", {
                        method: "POST",
                        json: {
                          code: newAccountCode.trim(),
                          name: newAccountName.trim(),
                          type: newAccountType,
                          normalBalance: newAccountNormal,
                          linkInventoryFifo: newAccountLinkInventoryFifo,
                          linkFixedAssets: newAccountLinkFixedAssets,
                        },
                      });
                      setNewAccountCode("");
                      setNewAccountName("");
                      setNewAccountLinkInventoryFifo(false);
                      setNewAccountLinkFixedAssets(false);
                      await refresh();
                    } catch (e: any) {
                      setErr(e.message);
                    }
                  }}
                >
                  新增科目
                </button>
              </div>
            </div>

            <div className="mt-3 max-h-[360px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{a.code}</td>
                      <td className="px-3 py-2">{a.name}</td>
                      <td className="px-3 py-2">{a.type}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                          onClick={() => {
                            setEditingAccountId(a.id);
                            setEditAccountCode(a.code);
                            setEditAccountName(a.name);
                            setEditAccountType(a.type as any);
                            setEditAccountNormal((a.normalBalance as any) || "debit");
                            setEditAccountActive((a as any).isActive ?? true);
                            setEditAccountLinkInventoryFifo(Boolean((a as any).linkInventoryFifo));
                            setEditAccountLinkFixedAssets(Boolean((a as any).linkFixedAssets));
                          }}
                        >
                          编辑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {editingAccountId && rightTab === "accounts" ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">编辑科目</div>
                <button className="text-sm text-zinc-600 hover:underline" onClick={() => setEditingAccountId(null)}>
                  关闭
                </button>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-5">
                <div>
                  <label className="text-xs text-zinc-600">Code</label>
                  <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={editAccountCode} onChange={(e) => setEditAccountCode(e.target.value)} />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">Name</label>
                  <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={editAccountName} onChange={(e) => setEditAccountName(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-zinc-600">Type</label>
                  <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={editAccountType} onChange={(e) => setEditAccountType(e.target.value as any)}>
                    {(["asset", "liability", "equity", "income", "cogs", "expense"] as const).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-zinc-600">Normal</label>
                  <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={editAccountNormal} onChange={(e) => setEditAccountNormal(e.target.value as any)}>
                    <option value="debit">debit</option>
                    <option value="credit">credit</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-zinc-600">Active</label>
                  <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={editAccountActive ? "yes" : "no"} onChange={(e) => setEditAccountActive(e.target.value === "yes")}>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                </div>
                <div className="md:col-span-5 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input type="checkbox" checked={editAccountLinkInventoryFifo} onChange={(e) => setEditAccountLinkInventoryFifo(e.target.checked)} />
                    链接库存 FIFO（分录显示“库存”按钮）
                  </label>
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input type="checkbox" checked={editAccountLinkFixedAssets} onChange={(e) => setEditAccountLinkFixedAssets(e.target.checked)} />
                    链接固定资产（分录显示“购买/折旧/处置”按钮）
                  </label>
                </div>
                <div className="md:col-span-5">
                  <button
                    className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                    disabled={!editAccountCode.trim() || !editAccountName.trim()}
                    onClick={async () => {
                      setErr(null);
                      try {
                        await api(`/api/settings/accounts/${editingAccountId}` as any, {
                          method: "PATCH",
                          json: {
                            code: editAccountCode.trim(),
                            name: editAccountName.trim(),
                            type: editAccountType,
                            normalBalance: editAccountNormal,
                            isActive: editAccountActive,
                            linkInventoryFifo: editAccountLinkInventoryFifo,
                            linkFixedAssets: editAccountLinkFixedAssets,
                          },
                        });
                        setEditingAccountId(null);
                        await refresh();
                      } catch (e: any) {
                        setErr(e.message);
                      }
                    }}
                  >
                    保存修改
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (rightTab === "costCenters" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Cost Centers</div>

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <label className="text-xs text-zinc-600">Code</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={newCcCode} onChange={(e) => setNewCcCode(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">Name</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={newCcName} onChange={(e) => setNewCcName(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <button
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={!newCcCode.trim() || !newCcName.trim()}
                  onClick={async () => {
                    setErr(null);
                    try {
                      await api("/api/settings/cost-centers", {
                        method: "POST",
                        json: { code: newCcCode.trim(), name: newCcName.trim() },
                      });
                      setNewCcCode("");
                      setNewCcName("");
                      await refresh();
                    } catch (e: any) {
                      setErr(e.message);
                    }
                  }}
                >
                  新增 Cost Center
                </button>
              </div>
            </div>

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

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (rightTab === "currencies" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Currencies</div>
            {active ? <div className="mt-1 text-xs text-zinc-600">Base currency: {active.baseCurrency}（默认）</div> : null}

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <label className="text-xs text-zinc-600">Currency code</label>
                <input className="mt-1 w-40 rounded-md border border-zinc-200 px-2 py-2 text-sm" value={newCurrencyCode} onChange={(e) => setNewCurrencyCode(e.target.value.toUpperCase())} maxLength={3} />
              </div>
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={newCurrencyCode.trim().length !== 3}
                onClick={async () => {
                  setErr(null);
                  try {
                    await api("/api/settings/currencies", { method: "POST", json: { code: newCurrencyCode.trim(), isEnabled: true } });
                    setNewCurrencyCode("");
                    await refresh();
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
              >
                添加币种
              </button>
            </div>

            <div className="mt-3 max-h-[220px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Code</th>
                    <th className="px-3 py-2 text-left">Enabled</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {currencies.map((c) => (
                    <tr key={c.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{c.code}</td>
                      <td className="px-3 py-2">{c.isEnabled ? "yes" : "no"}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={active?.baseCurrency?.toUpperCase() === c.code.toUpperCase()}
                          onClick={async () => {
                            setErr(null);
                            try {
                              await api(`/api/settings/currencies/${c.id}`, { method: "PATCH", json: { isEnabled: !c.isEnabled } });
                              await refresh();
                            } catch (e: any) {
                              setErr(e.message);
                            }
                          }}
                        >
                          {c.isEnabled ? "Disable" : "Enable"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (rightTab === "fxRates" ? "" : "hidden")}>
            <div className="text-sm font-semibold">FX Rates</div>

            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <div>
                <label className="text-xs text-zinc-600">Date</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={fxDate} onChange={(e) => setFxDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-zinc-600">Currency</label>
                <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm" value={fxCurrency} onChange={(e) => setFxCurrency(e.target.value)}>
                  {currencies.filter((c) => c.isEnabled).map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-600">Rate</label>
                <input className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-2 text-sm" value={fxValue} onChange={(e) => setFxValue(Number(e.target.value) || 0)} type="number" step="0.0001" />
              </div>
              <div className="flex items-end">
                <button
                  className="w-full rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  disabled={!fxDate.trim() || !fxCurrency.trim() || !fxValue || fxValue <= 0}
                  onClick={async () => {
                    setErr(null);
                    try {
                      await api("/api/settings/fx-rates", {
                        method: "POST",
                        json: { rateDate: fxDate, currencyCode: fxCurrency, fxRate: fxValue },
                      });
                      await refresh();
                    } catch (e: any) {
                      setErr(e.message);
                    }
                  }}
                >
                  保存汇率
                </button>
              </div>
            </div>

            <div className="mt-3 max-h-[260px] overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Currency</th>
                    <th className="px-3 py-2 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {fxRates.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">{r.rateDate}</td>
                      <td className="px-3 py-2">{r.currencyCode}</td>
                      <td className="px-3 py-2 text-right">{Number(r.fxRate).toFixed(6)}</td>
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
