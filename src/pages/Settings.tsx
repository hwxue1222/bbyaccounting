import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import Select from "@/components/ui/Select";
import { useUiStore } from "@/stores/uiStore";
import Input from "@/components/ui/Input";
import Label from "@/components/ui/Label";
import FilterBar from "@/components/ui/FilterBar";
import EmptyState from "@/components/ui/EmptyState";
import { Segmented, SegmentedItem } from "@/components/ui/Segmented";
import Confirm from "@/components/ui/Confirm";
import { Table, TableWrap, TD, TH, THead, TR } from "@/components/ui/Table";
import Switch from "@/components/ui/Switch";

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  isActive?: boolean;
  linkInventoryFifo?: boolean;
  linkFixedAssets?: boolean;
  lineCount?: number;
  debitBase?: number;
  creditBase?: number;
  balanceBase?: number;
};
type CostCenter = { id: string; code: string; name: string };
type Currency = { id: string; code: string; isEnabled: boolean };
type FxRate = { id: string; rateDate: string; currencyCode: string; fxRate: number };
type BankAccount = { id: string; bankName: string; accountNo: string; accountId: string; isActive: boolean };

type TaxSettings = {
  gstEnabled: boolean;
  gstRate: number;
  gstPayableAccountId: string;
  gstReceivableAccountId: string;
  sstEnabled: boolean;
  sstRate: number;
  sstPayableAccountId: string;
  sstReceivableAccountId: string;
  updatedAt: string | null;
};

export default function Settings() {
  const { orgs, activeOrgId, orgSwitching, switchOrg, createInvite, updateOrg, deleteOrg, bootstrap } = useAuthStore();
  const tr = useTr();
  const toast = useUiStore((s) => s.toast);
  const [leftTab, setLeftTab] = useState<"switch" | "profile" | "invite" | "plan">("switch");
  const [rightTab, setRightTab] = useState<"accounts" | "bankAccounts" | "costCenters" | "currencies" | "fxRates" | "tax">("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [fxRates, setFxRates] = useState<FxRate[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [tax, setTax] = useState<TaxSettings>({
    gstEnabled: false,
    gstRate: 0,
    gstPayableAccountId: "",
    gstReceivableAccountId: "",
    sstEnabled: false,
    sstRate: 0,
    sstPayableAccountId: "",
    sstReceivableAccountId: "",
    updatedAt: null,
  });
  const [err, setErr] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState<string>("");
  const [confirmDescription, setConfirmDescription] = useState<string>("");
  const [confirmDanger, setConfirmDanger] = useState(false);
  const confirmActionRef = useState<{ run: null | (() => Promise<void>) }>({ run: null })[0];

  function openConfirm(opts: { title: string; description?: string; danger?: boolean; onConfirm: () => Promise<void> }) {
    setConfirmTitle(opts.title);
    setConfirmDescription(opts.description || "");
    setConfirmDanger(Boolean(opts.danger));
    confirmActionRef.run = opts.onConfirm;
    setConfirmOpen(true);
  }

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

  function accountRiskInfo(a: Account) {
    const lineCount = Number((a as any).lineCount ?? 0) || 0;
    const debitBase = Number((a as any).debitBase ?? 0) || 0;
    const creditBase = Number((a as any).creditBase ?? 0) || 0;
    const balanceBase = Number((a as any).balanceBase ?? debitBase - creditBase) || 0;
    const hasActivity = lineCount > 0 || Math.abs(debitBase) > 0.0001 || Math.abs(creditBase) > 0.0001;
    const hasBalance = Math.abs(balanceBase) > 0.0001;
    return { lineCount, debitBase, creditBase, balanceBase, hasActivity, hasBalance };
  }

  const [newCcCode, setNewCcCode] = useState("");
  const [newCcName, setNewCcName] = useState("");

  const [newCurrencyCode, setNewCurrencyCode] = useState("");
  const [editingCurrencyId, setEditingCurrencyId] = useState<string | null>(null);
  const [editCurrencyCode, setEditCurrencyCode] = useState("");
  const [currencyBusy, setCurrencyBusy] = useState(false);

  const [fxDate, setFxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fxCurrency, setFxCurrency] = useState("SGD");
  const [fxValue, setFxValue] = useState("1");

  const [newBankName, setNewBankName] = useState("");
  const [newBankAccountNo, setNewBankAccountNo] = useState("");
  const [newBankCoaId, setNewBankCoaId] = useState("");
  const [bankBusy, setBankBusy] = useState(false);
  const [editingBankId, setEditingBankId] = useState<string | null>(null);
  const [editBankName, setEditBankName] = useState("");
  const [editBankAccountNo, setEditBankAccountNo] = useState("");
  const [editBankCoaId, setEditBankCoaId] = useState("");
  const [editBankActive, setEditBankActive] = useState(true);

  const active = useMemo(() => orgs.find((o) => o.orgId === activeOrgId) || null, [orgs, activeOrgId]);
  const activeRole = useMemo(() => (active?.role ? String(active.role) : null), [active?.role]);
  const canEditSettings = Boolean((active?.permissions || []).includes("settings.edit") || activeRole === "admin");

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
    const r = await api<{ accounts: any[]; costCenters: any[]; currencies: any[]; fxRates: any[]; bankAccounts: any[]; tax: TaxSettings }>(
      "/api/settings/bootstrap?limit=50",
    );
    setAccounts(r.accounts as any);
    setCostCenters(r.costCenters as any);
    setCurrencies(r.currencies as any);
    setFxRates(r.fxRates as any);
    setBankAccounts(r.bankAccounts as any);
    setTax(r.tax as any);
  }

  async function saveTaxSettings() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/settings/tax", {
        method: "PUT",
        json: {
          gstEnabled: tax.gstEnabled,
          gstRate: Number(tax.gstRate) || 0,
          gstPayableAccountId: tax.gstPayableAccountId || "",
          gstReceivableAccountId: tax.gstReceivableAccountId || "",
          sstEnabled: tax.sstEnabled,
          sstRate: Number(tax.sstRate) || 0,
          sstPayableAccountId: tax.sstPayableAccountId || "",
          sstReceivableAccountId: tax.sstReceivableAccountId || "",
        },
      });
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setErr(null);
    setInviteUrl(null);
    setEditingCurrencyId(null);
    refresh().catch((e) => setErr(e.message));
  }, [activeOrgId, orgSwitching]);

  return (
    <AppShell title={tr("设置", "Settings")} subtitle={tr("公司信息、权限与系统参数", "Company, permissions and system settings")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Segmented className="grid-cols-4">
            <SegmentedItem active={leftTab === "switch"} onClick={() => setLeftTab("switch")}>
              公司切换
            </SegmentedItem>
            <SegmentedItem active={leftTab === "profile"} onClick={() => setLeftTab("profile")}>
              公司资料
            </SegmentedItem>
            <SegmentedItem active={leftTab === "invite"} onClick={() => setLeftTab("invite")}>
              邀请用户
            </SegmentedItem>
            <SegmentedItem active={leftTab === "plan"} onClick={() => setLeftTab("plan")}>
              订阅方案
            </SegmentedItem>
          </Segmented>

          <Card className={"p-4 " + (leftTab === "plan" ? "" : "hidden")}>
            <div className="text-sm font-semibold">订阅方案</div>
            <div className="mt-2 text-sm text-zinc-600">
              {tr("当前方案：", "Current plan: ")}
              <span className="font-medium text-zinc-900">{String(active?.plan || "basic").toUpperCase()}</span>
              {active?.planStatus ? <Badge className="ml-2">{String(active.planStatus)}</Badge> : null}
            </div>

            <Card className="mt-4 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Basic</div>
                  <div className="mt-1 text-sm text-zinc-500">{tr("免费方案，适合小团队日常记账", "Free plan for small teams")}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold">{tr("免费", "Free")}</div>
                  <Button
                    variant="primary"
                    className="mt-2"
                    disabled={busy || !activeOrgId || !canEditSettings}
                    loading={busy}
                    onClick={async () => {
                      if (!activeOrgId) return;
                      setBusy(true);
                      setErr(null);
                      try {
                        await api("/api/settings/subscribe", { method: "POST", json: { plan: "basic" } });
                        await bootstrap();
                        toast({ type: "success", message: tr("已订阅 Basic（免费）", "Subscribed to Basic (free)") });
                      } catch (e: any) {
                        setErr(e.message);
                        toast({ type: "error", message: e?.message || tr("操作失败", "Action failed") });
                      } finally {
                        setBusy(false);
                      }
                    }}
                    type="button"
                  >
                    {tr("订阅 Basic", "Subscribe Basic")}
                  </Button>
                  {!canEditSettings ? <div className="mt-2 text-xs text-zinc-500">{tr("需要 settings.edit 权限", "Requires settings.edit permission")}</div> : null}
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold text-zinc-700">{tr("免费可用功能", "Included for free")}</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600">
                    <li>{tr("凭证录入与查询", "Journals entry & list")}</li>
                    <li>{tr("科目表（COA）与成本中心", "Chart of accounts & cost centers")}</li>
                    <li>{tr("多用户协作：邀请成员、角色权限", "Multi-user: invites, roles & permissions")}</li>
                    <li>{tr("GST/SST 税务：设置、自动税分录、报表", "GST/SST: settings, auto tax lines, reports")}</li>
                    <li>{tr("多币种与汇率维护", "Multi-currency & FX rates")}</li>
                  </ul>
                </div>
                <div>
                  <div className="text-xs font-semibold text-zinc-700">{tr("后续可升级（未启用）", "Coming soon (not enabled)")}</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600">
                    <li>{tr("自动对账与银行流水导入", "Bank feeds & reconciliation")}</li>
                    <li>{tr("高级报表与自定义报表", "Advanced & custom reports")}</li>
                    <li>{tr("审批流与操作审计", "Approval workflows & audit log")}</li>
                    <li>{tr("更细粒度的权限模板", "More granular permission templates")}</li>
                  </ul>
                </div>
              </div>
            </Card>
          </Card>

          <Card className={"p-4 " + (leftTab === "switch" ? "" : "hidden")}>
            <div className="text-sm font-semibold">公司与切换</div>
            <div className="mt-3 flex items-center gap-2">
              <Select
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
              </Select>
            </div>
            {active ? <div className="mt-2 text-sm text-zinc-600">Base currency: {active.baseCurrency}</div> : null}
          </Card>

          <Card className={"p-4 " + (leftTab === "profile" ? "" : "hidden")}>
            <div className="text-sm font-semibold">公司资料</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <Label>公司名称</Label>
                <Input className="mt-1" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <Label>公司注册号</Label>
                <Input className="mt-1" value={companyRegNo} onChange={(e) => setCompanyRegNo(e.target.value)} placeholder="例如：201901234567" />
              </div>
            </div>
            <Button
              variant="primary"
              className="mt-3"
              disabled={busy || !activeOrgId || !companyName.trim()}
              loading={busy}
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
              type="button"
            >
              保存
            </Button>

            <div className="mt-6 border-t border-zinc-100 pt-4">
              <div className="text-sm font-semibold text-red-700">危险操作</div>
              <div className="mt-2 text-sm text-zinc-600">删除公司会移除该公司的所有数据，并且无法恢复。</div>
              <Button
                variant="danger"
                className="mt-3"
                disabled={busy || !activeOrgId || !(activeRole === "admin")}
                loading={busy}
                onClick={() => {
                  if (!activeOrgId) return;
                  openConfirm({
                    title: "确定要删除公司吗？",
                    description: "此操作不可恢复。为避免误删，请在下一步再次确认。",
                    danger: true,
                    onConfirm: async () => {
                      setBusy(true);
                      setErr(null);
                      try {
                        await deleteOrg(activeOrgId);
                        setLeftTab("switch");
                      } finally {
                        setBusy(false);
                      }
                    },
                  });
                }}
                type="button"
              >
                删除公司
              </Button>
              {!(activeRole === "admin") ? (
                <div className="mt-2 text-xs text-zinc-500">仅 admin 可删除公司</div>
              ) : null}
            </div>
          </Card>

          <Card className={"p-4 " + (leftTab === "invite" ? "" : "hidden")}>
            <div className="text-sm font-semibold">邀请用户</div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <Label>邮箱</Label>
                <Input className="mt-1" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com" />
              </div>
              <div>
                <Label>角色</Label>
                <Select className="mt-1" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  {["admin", "accountant", "viewer", "auditor"].map((r) => (
                    <option key={r} value={r}>
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
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
              type="button"
            >
              生成邀请链接
            </Button>
            {inviteUrl ? (
              <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm">
                <div className="text-xs text-zinc-600">邀请链接</div>
                <div className="mt-1 break-all font-mono text-xs">{inviteUrl}</div>
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-4">
          <Segmented className="grid-cols-6">
            <SegmentedItem active={rightTab === "accounts"} onClick={() => setRightTab("accounts")}>
              科目
            </SegmentedItem>
            <SegmentedItem active={rightTab === "bankAccounts"} onClick={() => setRightTab("bankAccounts")}>
              银行账号
            </SegmentedItem>
            <SegmentedItem active={rightTab === "costCenters"} onClick={() => setRightTab("costCenters")}>
              Cost Center
            </SegmentedItem>
            <SegmentedItem active={rightTab === "currencies"} onClick={() => setRightTab("currencies")}>
              币种
            </SegmentedItem>
            <SegmentedItem active={rightTab === "fxRates"} onClick={() => setRightTab("fxRates")}>
              汇率
            </SegmentedItem>
            <SegmentedItem active={rightTab === "tax"} onClick={() => setRightTab("tax")}>
              税务
            </SegmentedItem>
          </Segmented>

          <Card className={"p-4 " + (rightTab === "accounts" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Chart of Accounts</div>

            <div className="mt-3 grid gap-3 md:grid-cols-5">
              <div>
                <Label>Code</Label>
                <Input
                  className="mt-1"
                  value={newAccountCode}
                  onChange={(e) => {
                    const code = e.target.value;
                    const norm = String(code || "").trim();
                    if (norm === "1500") setNewAccountLinkInventoryFifo(true);
                    if (norm.startsWith("16") || norm.startsWith("61")) setNewAccountLinkFixedAssets(true);
                    setNewAccountCode(code);
                  }}
                />
              </div>
              <div className="md:col-span-2">
                <Label>Name</Label>
                <Input className="mt-1" value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} />
              </div>
              <div>
                <Label>Type</Label>
                <Select className="mt-1" value={newAccountType} onChange={(e) => setNewAccountType(e.target.value as any)}>
                  {(["asset", "liability", "equity", "income", "cogs", "expense"] as const).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Normal</Label>
                <Select className="mt-1" value={newAccountNormal} onChange={(e) => setNewAccountNormal(e.target.value as any)}>
                  <option value="debit">debit</option>
                  <option value="credit">credit</option>
                </Select>
              </div>
              <div className="md:col-span-5 flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-3 text-sm text-zinc-700">
                  <Switch checked={newAccountLinkInventoryFifo} onClick={() => setNewAccountLinkInventoryFifo((v) => !v)} disabled={busy} />
                  <span>链接库存 FIFO（分录显示“库存”按钮）</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-zinc-700">
                  <Switch checked={newAccountLinkFixedAssets} onClick={() => setNewAccountLinkFixedAssets((v) => !v)} disabled={busy} />
                  <span>链接固定资产（分录显示“购买/折旧/处置”按钮）</span>
                </div>
              </div>
              <div className="md:col-span-5">
                <Button
                  variant="primary"
                  disabled={busy || !newAccountCode.trim() || !newAccountName.trim()}
                  loading={busy}
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
                  type="button"
                >
                  新增科目
                </Button>
              </div>
            </div>

            <TableWrap className="mt-3 max-h-[360px]">
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH className="text-right">Action</TH>
                  </TR>
                </THead>
                <tbody>
                  {accounts.filter((a) => (a as any).isActive ?? true).map((a) => (
                    <TR key={a.id}>
                      <TD>{a.code}</TD>
                      <TD>{a.name}</TD>
                      <TD>{a.type}</TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => {
                              const r = accountRiskInfo(a);
                              const doOpen = () => {
                                setEditingAccountId(a.id);
                                setEditAccountCode(a.code);
                                setEditAccountName(a.name);
                                setEditAccountType(a.type as any);
                                setEditAccountNormal((a.normalBalance as any) || "debit");
                                setEditAccountActive((a as any).isActive ?? true);
                                setEditAccountLinkInventoryFifo(Boolean((a as any).linkInventoryFifo));
                                setEditAccountLinkFixedAssets(Boolean((a as any).linkFixedAssets));
                              };

                              if (r.hasActivity || r.hasBalance) {
                                openConfirm({
                                  title: tr("确认编辑科目？", "Edit this account?") ,
                                  description: tr(
                                    `该科目已有变动/余额（行数 ${r.lineCount}，借 ${r.debitBase.toFixed(2)}，贷 ${r.creditBase.toFixed(2)}，余额 ${r.balanceBase.toFixed(2)}）。修改科目信息可能影响报表与历史凭证展示。`,
                                    `This account has activity/balance (lines ${r.lineCount}, Dr ${r.debitBase.toFixed(2)}, Cr ${r.creditBase.toFixed(2)}, Bal ${r.balanceBase.toFixed(2)}). Editing may affect reports and past journals.`,
                                  ),
                                  onConfirm: async () => {
                                    doOpen();
                                  },
                                });
                                return;
                              }
                              doOpen();
                            }}
                            type="button"
                          >
                            {tr("编辑", "Edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              const r = accountRiskInfo(a);
                              const msg = r.hasActivity || r.hasBalance
                                ? tr(
                                    `该科目已有变动/余额（行数 ${r.lineCount}，借 ${r.debitBase.toFixed(2)}，贷 ${r.creditBase.toFixed(2)}，余额 ${r.balanceBase.toFixed(2)}）。删除后历史凭证不会删除，但该科目将不可再选。`,
                                    `This account has activity/balance (lines ${r.lineCount}, Dr ${r.debitBase.toFixed(2)}, Cr ${r.creditBase.toFixed(2)}, Bal ${r.balanceBase.toFixed(2)}). Past journals remain, but this account will no longer be selectable.`,
                                  )
                                : tr("历史凭证不会删除，只是不再可选。", "Past journals remain; it will just be inactive.");

                              openConfirm({
                                title: tr("确认删除科目？", "Delete this account?") ,
                                description: msg,
                                danger: true,
                                onConfirm: async () => {
                                  setErr(null);
                                  await api(`/api/settings/accounts/${a.id}` as any, { method: "PATCH", json: { isActive: false } });
                                  if (editingAccountId === a.id) {
                                    setEditingAccountId(null);
                                  }
                                  await refresh();
                                },
                              });
                            }}
                            type="button"
                          >
                            {tr("删除", "Delete")}
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>

          <div className={"rounded-xl border border-zinc-200 bg-white p-4 shadow-sm " + (rightTab === "bankAccounts" ? "" : "hidden")}>
            <div className="text-sm font-semibold">银行账号</div>
            <div className="mt-1 text-sm text-zinc-500">用于付款方式选择（银行转账）。</div>

            <div className="mt-3 grid gap-3 md:grid-cols-5">
              <div>
                <Label>银行</Label>
                <Input className="mt-1" value={newBankName} onChange={(e) => setNewBankName(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <Label>账号</Label>
                <Input className="mt-1" value={newBankAccountNo} onChange={(e) => setNewBankAccountNo(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-zinc-600">对应科目（Bank）</label>
                <Select className="mt-1" value={newBankCoaId} onChange={(e) => setNewBankCoaId(e.target.value)}>
                  <option value="" disabled>
                    请选择
                  </option>
                  {(() => {
                    const active = accounts.filter((a) => a.isActive ?? true);
                    const bankLike = active.filter((a) => a.type === "asset" && /bank|银行/i.test(`${a.code} ${a.name}`));
                    const list = (bankLike.length ? bankLike : active).slice().sort((a, b) => `${a.code} ${a.name}`.localeCompare(`${b.code} ${b.name}`));
                    return list.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ));
                  })()}
                </Select>
              </div>
              <div className="md:col-span-5">
                <Button
                  variant="primary"
                  disabled={bankBusy || !newBankName.trim() || !newBankAccountNo.trim() || !newBankCoaId}
                  loading={bankBusy}
                  onClick={async () => {
                    setErr(null);
                    setBankBusy(true);
                    try {
                      await api<{ bankAccount: BankAccount }>("/api/settings/bank-accounts", {
                        method: "POST",
                        json: { bankName: newBankName.trim(), accountNo: newBankAccountNo.trim(), accountId: newBankCoaId },
                      });
                      setNewBankName("");
                      setNewBankAccountNo("");
                      setNewBankCoaId("");
                      const r = await api<{ bankAccounts: BankAccount[] }>("/api/settings/bank-accounts");
                      setBankAccounts(r.bankAccounts);
                    } catch (e: any) {
                      setErr(e.message);
                    } finally {
                      setBankBusy(false);
                    }
                  }}
                  type="button"
                >
                  新增银行账号
                </Button>
              </div>
            </div>

            <TableWrap className="mt-4">
              <Table>
                <THead>
                  <TR>
                    <TH>银行</TH>
                    <TH>账号</TH>
                    <TH>对应科目</TH>
                    <TH>状态</TH>
                    <TH className="text-right"></TH>
                  </TR>
                </THead>
                <tbody>
                  {bankAccounts
                    .filter((b) => b.isActive)
                    .slice()
                    .sort((a, b) => `${a.bankName} ${a.accountNo}`.localeCompare(`${b.bankName} ${b.accountNo}`))
                    .map((b) => {
                      const isEditing = editingBankId === b.id;
                      const accountLabel = (() => {
                        const a = accounts.find((x) => x.id === b.accountId);
                        if (!a) return b.accountId;
                        return `${a.code} ${a.name}`;
                      })();
                      return (
                        <TR key={b.id}>
                          <TD>
                            {isEditing ? (
                              <Input className="w-full" value={editBankName} onChange={(e) => setEditBankName(e.target.value)} />
                            ) : (
                              b.bankName
                            )}
                          </TD>
                          <TD>
                            {isEditing ? (
                              <Input className="w-full" value={editBankAccountNo} onChange={(e) => setEditBankAccountNo(e.target.value)} />
                            ) : (
                              b.accountNo
                            )}
                          </TD>
                          <TD>
                            {isEditing ? (
                              <Select className="w-full" value={editBankCoaId} onChange={(e) => setEditBankCoaId(e.target.value)}>
                                {accounts
                                  .filter((a) => a.isActive ?? true)
                                  .slice()
                                  .sort((a, b) => `${a.code} ${a.name}`.localeCompare(`${b.code} ${b.name}`))
                                  .map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.code} {a.name}
                                    </option>
                                  ))}
                              </Select>
                            ) : (
                              accountLabel
                            )}
                          </TD>
                          <TD>
                            {isEditing ? (
                              <div className="flex items-center gap-3 text-sm text-zinc-700">
                                <Switch checked={editBankActive} onClick={() => setEditBankActive((v) => !v)} disabled={bankBusy} />
                                启用
                              </div>
                            ) : (
                              <span className="text-zinc-600">启用</span>
                            )}
                          </TD>
                          <TD className="text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {isEditing ? (
                                <>
                                  <Button
                                    onClick={() => {
                                      setEditingBankId(null);
                                    }}
                                    type="button"
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    variant="primary"
                                    disabled={bankBusy || !editBankName.trim() || !editBankAccountNo.trim() || !editBankCoaId}
                                    loading={bankBusy}
                                    onClick={async () => {
                                      setErr(null);
                                      setBankBusy(true);
                                      try {
                                        await api<{ bankAccount: BankAccount }>(`/api/settings/bank-accounts/${b.id}`, {
                                          method: "PATCH",
                                          json: {
                                            bankName: editBankName.trim(),
                                            accountNo: editBankAccountNo.trim(),
                                            accountId: editBankCoaId,
                                            isActive: editBankActive,
                                          },
                                        });
                                        setEditingBankId(null);
                                        const r = await api<{ bankAccounts: BankAccount[] }>("/api/settings/bank-accounts");
                                        setBankAccounts(r.bankAccounts);
                                      } catch (e: any) {
                                        setErr(e.message);
                                      } finally {
                                        setBankBusy(false);
                                      }
                                    }}
                                    type="button"
                                  >
                                    保存
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    onClick={() => {
                                      setEditingBankId(b.id);
                                      setEditBankName(b.bankName);
                                      setEditBankAccountNo(b.accountNo);
                                      setEditBankCoaId(b.accountId);
                                      setEditBankActive(true);
                                    }}
                                    type="button"
                                  >
                                    修改
                                  </Button>
                                  <Button
                                    variant="danger"
                                    disabled={bankBusy}
                                    loading={bankBusy}
                                    onClick={() => {
                                      openConfirm({
                                        title: "确认删除该银行账号？",
                                        description: "删除后将无法再用于付款方式选择。",
                                        danger: true,
                                        onConfirm: async () => {
                                          setErr(null);
                                          setBankBusy(true);
                                          try {
                                            await api(`/api/settings/bank-accounts/${b.id}`, { method: "PATCH", json: { isActive: false } });
                                            const r = await api<{ bankAccounts: BankAccount[] }>("/api/settings/bank-accounts");
                                            setBankAccounts(r.bankAccounts);
                                          } finally {
                                            setBankBusy(false);
                                          }
                                        },
                                      });
                                    }}
                                    type="button"
                                  >
                                    删除
                                  </Button>
                                </>
                              )}
                            </div>
                          </TD>
                        </TR>
                      );
                    })}
                </tbody>
              </Table>
            </TableWrap>

            {!bankAccounts.filter((b) => b.isActive).length ? <EmptyState className="mt-3" title="暂无银行账号" /> : null}
          </div>

          {editingAccountId && rightTab === "accounts" ? (
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">编辑科目</div>
                <Button size="sm" onClick={() => setEditingAccountId(null)} type="button">
                  关闭
                </Button>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-5">
                <div>
                  <Label>Code</Label>
                  <Input className="mt-1" value={editAccountCode} onChange={(e) => setEditAccountCode(e.target.value)} />
                </div>
                <div className="md:col-span-2">
                  <Label>Name</Label>
                  <Input className="mt-1" value={editAccountName} onChange={(e) => setEditAccountName(e.target.value)} />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select className="mt-1" value={editAccountType} onChange={(e) => setEditAccountType(e.target.value as any)}>
                    {(["asset", "liability", "equity", "income", "cogs", "expense"] as const).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>Normal</Label>
                  <Select className="mt-1" value={editAccountNormal} onChange={(e) => setEditAccountNormal(e.target.value as any)}>
                    <option value="debit">debit</option>
                    <option value="credit">credit</option>
                  </Select>
                </div>
                <div className="md:col-span-2">
                  <Label>Active</Label>
                  <div className="mt-1 flex items-center gap-3">
                    <Switch checked={editAccountActive} onClick={() => setEditAccountActive((v) => !v)} disabled={busy} />
                    <div className="text-sm text-zinc-700">{editAccountActive ? "启用" : "停用"}</div>
                  </div>
                </div>
                <div className="md:col-span-5 flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-3 text-sm text-zinc-700">
                    <Switch checked={editAccountLinkInventoryFifo} onClick={() => setEditAccountLinkInventoryFifo((v) => !v)} disabled={busy} />
                    链接库存 FIFO（分录显示“库存”按钮）
                  </div>
                  <div className="flex items-center gap-3 text-sm text-zinc-700">
                    <Switch checked={editAccountLinkFixedAssets} onClick={() => setEditAccountLinkFixedAssets((v) => !v)} disabled={busy} />
                    链接固定资产（分录显示“购买/折旧/处置”按钮）
                  </div>
                </div>
                <div className="md:col-span-5">
                  <Button
                    variant="primary"
                    disabled={busy || !editAccountCode.trim() || !editAccountName.trim()}
                    loading={busy}
                    onClick={() => {
                      const doSave = async () => {
                        setErr(null);
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
                      };

                      const original = accounts.find((x) => x.id === editingAccountId) || null;
                      if (original) {
                        const r = accountRiskInfo(original);
                        const hasChanges =
                          String(original.code || "") !== String(editAccountCode.trim()) ||
                          String(original.name || "") !== String(editAccountName.trim()) ||
                          String(original.type || "") !== String(editAccountType) ||
                          String(original.normalBalance || "") !== String(editAccountNormal) ||
                          Boolean((original as any).isActive ?? true) !== Boolean(editAccountActive) ||
                          Boolean((original as any).linkInventoryFifo) !== Boolean(editAccountLinkInventoryFifo) ||
                          Boolean((original as any).linkFixedAssets) !== Boolean(editAccountLinkFixedAssets);

                        if (hasChanges && (r.hasActivity || r.hasBalance)) {
                          openConfirm({
                            title: tr("确认保存修改？", "Confirm save changes?") ,
                            description: tr(
                              `该科目已有变动/余额（行数 ${r.lineCount}，借 ${r.debitBase.toFixed(2)}，贷 ${r.creditBase.toFixed(2)}，余额 ${r.balanceBase.toFixed(2)}）。保存修改可能影响报表与历史凭证展示。`,
                              `This account has activity/balance (lines ${r.lineCount}, Dr ${r.debitBase.toFixed(2)}, Cr ${r.creditBase.toFixed(2)}, Bal ${r.balanceBase.toFixed(2)}). Saving changes may affect reports and past journals.`,
                            ),
                            onConfirm: async () => {
                              await doSave();
                            },
                          });
                          return;
                        }
                      }
                      void doSave().catch((e: any) => setErr(e.message));
                    }}
                    type="button"
                  >
                    保存修改
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          <Card className={"p-4 " + (rightTab === "costCenters" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Cost Centers</div>

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <Label>Code</Label>
                <Input className="mt-1" value={newCcCode} onChange={(e) => setNewCcCode(e.target.value)} />
              </div>
              <div className="md:col-span-2">
                <Label>Name</Label>
                <Input className="mt-1" value={newCcName} onChange={(e) => setNewCcName(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <Button
                  variant="primary"
                  disabled={busy || !newCcCode.trim() || !newCcName.trim()}
                  loading={busy}
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
                  type="button"
                >
                  新增 Cost Center
                </Button>
              </div>
            </div>

            <TableWrap className="mt-3 max-h-[220px]">
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Name</TH>
                  </TR>
                </THead>
                <tbody>
                  {costCenters.map((c) => (
                    <TR key={c.id}>
                      <TD>{c.code}</TD>
                      <TD>{c.name}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>

          <Card className={"p-4 " + (rightTab === "currencies" ? "" : "hidden")}>
            <div className="text-sm font-semibold">Currencies</div>
            {active ? <div className="mt-1 text-xs text-zinc-600">Base currency: {active.baseCurrency}（默认）</div> : null}

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <Label>Currency code</Label>
                <Input className="mt-1 w-40" value={newCurrencyCode} onChange={(e) => setNewCurrencyCode(e.target.value.toUpperCase())} maxLength={3} />
              </div>
              <Button
                variant="primary"
                disabled={busy || newCurrencyCode.trim().length !== 3}
                loading={busy}
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
                type="button"
              >
                添加币种
              </Button>
            </div>

            <TableWrap className="mt-3 max-h-[220px]">
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Enabled</TH>
                    <TH className="text-right">Action</TH>
                  </TR>
                </THead>
                <tbody>
                  {currencies.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        {editingCurrencyId === c.id ? (
                          <Input
                            className="w-24 px-2 py-1"
                            value={editCurrencyCode}
                            onChange={(e) => setEditCurrencyCode(e.target.value.toUpperCase())}
                            maxLength={3}
                            disabled={currencyBusy}
                          />
                        ) : (
                          c.code
                        )}
                      </TD>
                      <TD>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={c.isEnabled}
                            disabled={currencyBusy || active?.baseCurrency?.toUpperCase() === c.code.toUpperCase()}
                            onClick={async () => {
                              setErr(null);
                              try {
                                await api(`/api/settings/currencies/${c.id}`, { method: "PATCH", json: { isEnabled: !c.isEnabled } });
                                await refresh();
                              } catch (e: any) {
                                setErr(e.message);
                              }
                            }}
                          />
                          <span className="text-sm text-zinc-700">{c.isEnabled ? "启用" : "停用"}</span>
                        </div>
                      </TD>
                      <TD className="text-right">
                        {editingCurrencyId === c.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              disabled={currencyBusy}
                              onClick={() => {
                                setEditingCurrencyId(null);
                                setEditCurrencyCode("");
                              }}
                              type="button"
                            >
                              {tr("取消", "Cancel")}
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={
                                currencyBusy ||
                                editCurrencyCode.trim().length !== 3 ||
                                editCurrencyCode.trim().toUpperCase() === c.code.toUpperCase()
                              }
                              loading={currencyBusy}
                              onClick={async () => {
                                setCurrencyBusy(true);
                                setErr(null);
                                try {
                                  await api(`/api/settings/currencies/${c.id}`, {
                                    method: "PATCH",
                                    json: { code: editCurrencyCode.trim().toUpperCase() },
                                  });
                                  setEditingCurrencyId(null);
                                  setEditCurrencyCode("");
                                  await refresh();
                                } catch (e: any) {
                                  setErr(e.message);
                                } finally {
                                  setCurrencyBusy(false);
                                }
                              }}
                              type="button"
                            >
                              {tr("保存", "Save")}
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              disabled={currencyBusy || active?.baseCurrency?.toUpperCase() === c.code.toUpperCase()}
                              onClick={() => {
                                setEditingCurrencyId(c.id);
                                setEditCurrencyCode(c.code.toUpperCase());
                              }}
                              type="button"
                            >
                              {tr("修改", "Rename")}
                            </Button>
                          </div>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>

          <Card className={"p-4 " + (rightTab === "fxRates" ? "" : "hidden")}>
            <div className="text-sm font-semibold">FX Rates</div>
            <div className="mt-1 text-xs text-zinc-500">{tr("基准币同币种时汇率为 1，其他币种请维护历史汇率用于自动回填。", "FX rate is 1 for base currency; maintain historical FX rates for other currencies.")}</div>

            <FilterBar
              className="mt-3"
              left={
                <div className="grid w-full gap-3 md:grid-cols-4">
                  <div>
                    <Label>Date</Label>
                    <Input className="mt-1" value={fxDate} onChange={(e) => setFxDate(e.target.value)} />
                  </div>
                  <div>
                    <Label>Currency</Label>
                    <Select className="mt-1" value={fxCurrency} onChange={(e) => setFxCurrency(e.target.value)}>
                      {currencies.filter((c) => c.isEnabled).map((c) => (
                        <option key={c.id} value={c.code}>
                          {c.code}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>Rate</Label>
                    <Input className="mt-1" value={fxValue} onChange={(e) => setFxValue(e.target.value)} type="number" step="0.0001" />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="primary"
                      className="w-full"
                      disabled={!fxDate.trim() || !fxCurrency.trim() || !Number.isFinite(Number(fxValue)) || Number(fxValue) <= 0}
                      loading={busy}
                      onClick={async () => {
                        setErr(null);
                        try {
                          const rate = Number(fxValue);
                          await api("/api/settings/fx-rates", {
                            method: "POST",
                            json: { rateDate: fxDate, currencyCode: fxCurrency, fxRate: rate },
                          });
                          await refresh();
                        } catch (e: any) {
                          setErr(e.message);
                        }
                      }}
                    >
                      保存汇率
                    </Button>
                  </div>
                </div>
              }
            />

            {fxRates.length ? (
              <TableWrap className="mt-3 max-h-[260px]">
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Currency</TH>
                      <TH className="text-right">Rate</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {fxRates.map((r) => (
                      <TR key={r.id}>
                        <TD>{r.rateDate}</TD>
                        <TD>{r.currencyCode}</TD>
                        <TD className="text-right">{Number(r.fxRate).toFixed(6)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            ) : (
              <EmptyState
                className="mt-3"
                title={tr("暂无汇率记录", "No FX rates")}
                description={tr("先新增一条汇率（日期 + 币种 + 汇率），之后分录页可用“用历史”自动回填。", "Add a rate (date + currency + rate), then use 'Use history' to auto-fill on journals.")}
              />
            )}
          </Card>

          <Card className={"p-4 " + (rightTab === "tax" ? "" : "hidden")}>
            <div className="text-sm font-semibold">GST / SST</div>

            <div className="mt-3 grid gap-4">
              <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Switch
                      checked={tax.gstEnabled}
                      disabled={!(activeRole === "admin")}
                      onClick={() => setTax((prev) => ({ ...prev, gstEnabled: !prev.gstEnabled }))}
                    />
                    GST
                  </div>
                  <div className="text-xs text-zinc-500">输出税科目用于自动生成税分录与报表汇总</div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <div>
                    <Label>税率（%）</Label>
                    <Input
                      className="mt-1"
                      type="number"
                      step="0.01"
                      min={0}
                      max={100}
                      value={tax.gstRate}
                      disabled={!(activeRole === "admin")}
                      onChange={(e) => setTax((prev) => ({ ...prev, gstRate: Number(e.target.value) || 0 }))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Label>GST Payable 科目</Label>
                    <Input
                      className="mt-1 bg-zinc-50"
                      value={(accounts.find((a) => a.id === tax.gstPayableAccountId)?.name || "GST payable") as any}
                      readOnly
                    />
                    <div className="mt-1 text-xs text-zinc-500">系统固定使用 GST payable（无需手动设置）</div>
                  </div>
                  <div className="md:col-span-2">
                    <Label>GST Receivable 科目</Label>
                    <Input
                      className="mt-1 bg-zinc-50"
                      value={(accounts.find((a) => a.id === tax.gstReceivableAccountId)?.name || "GST receivable") as any}
                      readOnly
                    />
                    <div className="mt-1 text-xs text-zinc-500">系统固定使用 GST receivable（无需手动设置）</div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Switch
                      checked={tax.sstEnabled}
                      disabled={!(activeRole === "admin")}
                      onClick={() => setTax((prev) => ({ ...prev, sstEnabled: !prev.sstEnabled }))}
                    />
                    SST
                  </div>
                  <div className="text-xs text-zinc-500">输出税科目用于自动生成税分录与报表汇总</div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <div>
                    <Label>税率（%）</Label>
                    <Input
                      className="mt-1"
                      type="number"
                      step="0.01"
                      min={0}
                      max={100}
                      value={tax.sstRate}
                      disabled={!(activeRole === "admin")}
                      onChange={(e) => setTax((prev) => ({ ...prev, sstRate: Number(e.target.value) || 0 }))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Label>SST Payable 科目</Label>
                    <Input
                      className="mt-1 bg-zinc-50"
                      value={(accounts.find((a) => a.id === tax.sstPayableAccountId)?.name || "SST payable") as any}
                      readOnly
                    />
                    <div className="mt-1 text-xs text-zinc-500">系统固定使用 SST payable（无需手动设置）</div>
                  </div>
                  <div className="md:col-span-2">
                    <Label>SST Receivable 科目</Label>
                    <Input
                      className="mt-1 bg-zinc-50"
                      value={(accounts.find((a) => a.id === tax.sstReceivableAccountId)?.name || "SST receivable") as any}
                      readOnly
                    />
                    <div className="mt-1 text-xs text-zinc-500">系统固定使用 SST receivable（无需手动设置）</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-zinc-500">{tax.updatedAt ? `最后更新：${tax.updatedAt}` : ""}</div>
                <Button variant="primary" disabled={busy || !(activeRole === "admin")} loading={busy} onClick={saveTaxSettings} type="button">
                  保存
                </Button>
              </div>

              {!(activeRole === "admin") ? <div className="text-xs text-zinc-500">仅 admin 可修改税务设置</div> : null}
            </div>
          </Card>
        </div>
      </div>

      {err ? <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}

      <Confirm
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDescription || undefined}
        danger={confirmDanger}
        confirmText={confirmDanger ? tr("删除", "Delete") : tr("确认", "Confirm")}
        cancelText={tr("取消", "Cancel")}
        onClose={() => {
          if (busy) return;
          setConfirmOpen(false);
          confirmActionRef.run = null;
        }}
        onConfirm={async () => {
          const run = confirmActionRef.run;
          setConfirmOpen(false);
          confirmActionRef.run = null;
          if (!run) return;
          await run();
        }}
      />
    </AppShell>
  );
}
