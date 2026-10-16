import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";
import { useTr } from "@/lib/tr";

type CustomerRow = {
  id: string;
  code: string | null;
  name: string;
  isActive?: boolean;
};

type InvoiceLineItem = {
  particulars: string;
  paymentMethod: string;
  amount: string;
};

const PAYMENT_MODE_OPTIONS = [
  { value: "Cash 现金", label: "Cash 现金" },
  { value: "Cheque 支票", label: "Cheque 支票" },
  { value: "Fund Transfer 转账", label: "Fund Transfer 转账" },
] as const;

type InvoiceRow = {
  id: string;
  entryId?: string | null;
  entryLineNo?: number | null;
  customerId?: string | null;
  invoiceNo: string;
  issueDate: string;
  currency: string;
  fxRate: number;
  status: string;
  billToName: string;
  memo?: string | null;
  paymentAccountName?: string | null;
  paymentBankName?: string | null;
  paymentBankAddress?: string | null;
  paymentAccountNumber?: string | null;
  paymentSwiftCode?: string | null;
  officialStamp?: string | null;
  totalTxn: string | number;
  lineItems: Array<{ particulars: string; paymentMethod: string; amount: number }>;
  customerName?: string | null;
};

type InvoiceFormState = {
  entryId: string;
  entryLineNo: string;
  customerId: string;
  invoiceNo: string;
  issueDate: string;
  currency: string;
  fxRate: string;
  status: "draft" | "issued";
  billToName: string;
  memo: string;
  paymentAccountName: string;
  paymentBankName: string;
  paymentBankAddress: string;
  paymentAccountNumber: string;
  paymentSwiftCode: string;
  officialStamp: string;
  lineItems: InvoiceLineItem[];
};

const TEMPLATE_PAYMENT_DEFAULTS = {
  paymentAccountName: "Jiangsu Association (Singapore)",
  paymentBankName: "DBS Bank Ltd",
  paymentBankAddress: "12 Marina Boulevard, Marina Bay Financial Centre Tower 3, Singapore 018982",
  paymentAccountNumber: "288-903170-7",
  paymentSwiftCode: "DBSSSGSG",
};

function blankLineItem(particulars = "", amount = ""): InvoiceLineItem {
  return {
    particulars,
    paymentMethod: "Fund Transfer 转账",
    amount,
  };
}

function makeBlankForm(baseCurrency: string): InvoiceFormState {
  return {
    entryId: "",
    entryLineNo: "",
    customerId: "",
    invoiceNo: "",
    issueDate: new Date().toISOString().slice(0, 10),
    currency: (baseCurrency || "SGD").toUpperCase(),
    fxRate: "1",
    status: "issued",
    billToName: "",
    memo: "",
    paymentAccountName: TEMPLATE_PAYMENT_DEFAULTS.paymentAccountName,
    paymentBankName: TEMPLATE_PAYMENT_DEFAULTS.paymentBankName,
    paymentBankAddress: TEMPLATE_PAYMENT_DEFAULTS.paymentBankAddress,
    paymentAccountNumber: TEMPLATE_PAYMENT_DEFAULTS.paymentAccountNumber,
    paymentSwiftCode: TEMPLATE_PAYMENT_DEFAULTS.paymentSwiftCode,
    officialStamp: "",
    lineItems: [blankLineItem("Package fee 配套费", "")],
  };
}

export default function CustomerInvoices({ baseCurrency }: { baseCurrency: string }) {
  const tr = useTr();
  const { activeOrgId, orgSwitching } = useAuthStore();
  const [params, setParams] = useSearchParams();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [invoiceNoTouched, setInvoiceNoTouched] = useState(false);
  const [form, setForm] = useState<InvoiceFormState>(() => makeBlankForm(baseCurrency));
  const prefillKeyRef = useRef<string>("");

  const customerById = useMemo(() => new Map(customers.map((customer) => [String(customer.id), customer] as const)), [customers]);

  const filteredInvoices = useMemo(() => {
    const customerId = params.get("customerId");
    if (!customerId) return invoices;
    return invoices.filter((invoice) => String(invoice.customerId || "") === customerId);
  }, [invoices, params]);

  const totalTxn = useMemo(
    () =>
      Math.round(
        form.lineItems.reduce((sum, item) => {
          const next = Number(item.amount) || 0;
          return sum + next;
        }, 0) * 100,
      ) / 100,
    [form.lineItems],
  );

  async function refreshData() {
    const [customerResp, invoiceResp] = await Promise.all([
      api<{ customers: CustomerRow[] }>("/api/customers"),
      api<{ invoices: InvoiceRow[] }>("/api/invoices", { cache: "no-store" }),
    ]);
    setCustomers(customerResp.customers || []);
    setInvoices(invoiceResp.invoices || []);
  }

  function downloadPdf(invoiceId: string) {
    const url = `/api/invoices/${encodeURIComponent(invoiceId)}/pdf`;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function openPrintPreview(invoiceId: string) {
    const href = `/invoices/${encodeURIComponent(invoiceId)}/print`;
    const popup = window.open(href, "_blank", "noopener,noreferrer");
    if (!popup) window.location.href = href;
  }

  function updateParams(mutator: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(params);
    mutator(next);
    setParams(next);
  }

  function clearInvoicePrefillParams() {
    updateParams((next) => {
      [
        "new",
        "customerId",
        "issueDate",
        "currency",
        "fxRate",
        "amountTxn",
        "description",
        "memo",
        "entryId",
        "entryLineNo",
      ].forEach((key) => next.delete(key));
      next.set("tab", "invoices");
    });
  }

  async function fillNextInvoiceNo(issueDate: string) {
    const resp = await api<{ invoiceNo: string }>(`/api/invoices/next-no?issueDate=${encodeURIComponent(issueDate)}`, { cache: "no-store" });
    setForm((current) => ({ ...current, invoiceNo: resp.invoiceNo || current.invoiceNo }));
  }

  async function submitInvoice(downloadAfterSave: boolean) {
    const lineItems = form.lineItems
      .map((item) => ({
        particulars: item.particulars.trim(),
        paymentMethod: item.paymentMethod.trim(),
        amount: Math.round((Number(item.amount) || 0) * 100) / 100,
      }))
      .filter((item) => item.particulars && item.paymentMethod && item.amount > 0);
    if (!form.billToName.trim()) {
      setErr(tr("请填写 Bill to / 客户名称", "Please fill in Bill to / customer name"));
      return;
    }
    if (!lineItems.length) {
      setErr(tr("请至少填写一行收款事项与金额", "Please add at least one line item and amount"));
      return;
    }

    setSaving(true);
    setErr(null);
    try {
      const payload = {
        entryId: form.entryId.trim() || null,
        entryLineNo: form.entryLineNo.trim() ? Number(form.entryLineNo) : null,
        customerId: form.customerId || null,
        invoiceNo: form.invoiceNo.trim() || undefined,
        issueDate: form.issueDate,
        currency: form.currency.toUpperCase(),
        fxRate: Number(form.fxRate) || 1,
        status: form.status,
        billToName: form.billToName.trim(),
        memo: form.memo.trim() || null,
        paymentAccountName: form.paymentAccountName.trim() || null,
        paymentBankName: form.paymentBankName.trim() || null,
        paymentBankAddress: form.paymentBankAddress.trim() || null,
        paymentAccountNumber: form.paymentAccountNumber.trim() || null,
        paymentSwiftCode: form.paymentSwiftCode.trim() || null,
        officialStamp: form.officialStamp.trim() || null,
        lineItems,
      };
      let invoiceId = editingId;
      if (editingId) {
        const resp = await api<{ invoice: { id: string } }>(`/api/invoices/${encodeURIComponent(editingId)}` as any, { method: "PATCH", json: payload });
        invoiceId = resp.invoice?.id || editingId;
      } else {
        const resp = await api<{ invoice: { id: string } }>("/api/invoices", { method: "POST", json: payload });
        invoiceId = resp.invoice?.id || null;
      }
      await refreshData();
      setFormOpen(false);
      setEditingId(null);
      setInvoiceNoTouched(false);
      clearInvoicePrefillParams();
      if (downloadAfterSave && invoiceId) {
        window.setTimeout(() => downloadPdf(invoiceId as string), 0);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function openNewForm(prefill?: Partial<InvoiceFormState>) {
    setEditingId(null);
    setInvoiceNoTouched(false);
    setFormOpen(true);
    setErr(null);
    setForm({
      ...makeBlankForm(baseCurrency),
      ...prefill,
      lineItems: prefill?.lineItems && prefill.lineItems.length ? prefill.lineItems : [blankLineItem("Package fee 配套费", "")],
    });
  }

  function startEdit(row: InvoiceRow) {
    setEditingId(row.id);
    setInvoiceNoTouched(true);
    setFormOpen(true);
    setErr(null);
    setForm({
      entryId: row.entryId ? String(row.entryId) : "",
      entryLineNo: row.entryLineNo ? String(row.entryLineNo) : "",
      customerId: row.customerId ? String(row.customerId) : "",
      invoiceNo: row.invoiceNo || "",
      issueDate: row.issueDate || new Date().toISOString().slice(0, 10),
      currency: (row.currency || baseCurrency || "SGD").toUpperCase(),
      fxRate: String(row.fxRate || 1),
      status: row.status === "draft" ? "draft" : "issued",
      billToName: row.billToName || row.customerName || "",
      memo: row.memo || "",
      paymentAccountName: row.paymentAccountName || TEMPLATE_PAYMENT_DEFAULTS.paymentAccountName,
      paymentBankName: row.paymentBankName || TEMPLATE_PAYMENT_DEFAULTS.paymentBankName,
      paymentBankAddress: row.paymentBankAddress || TEMPLATE_PAYMENT_DEFAULTS.paymentBankAddress,
      paymentAccountNumber: row.paymentAccountNumber || TEMPLATE_PAYMENT_DEFAULTS.paymentAccountNumber,
      paymentSwiftCode: row.paymentSwiftCode || TEMPLATE_PAYMENT_DEFAULTS.paymentSwiftCode,
      officialStamp: row.officialStamp || "",
      lineItems:
        row.lineItems?.length?.valueOf()
          ? row.lineItems.map((item) => ({
              particulars: item.particulars || "",
              paymentMethod: item.paymentMethod || "Fund Transfer 转账",
              amount: String(item.amount ?? ""),
            }))
          : [blankLineItem("Package fee 配套费", String(row.totalTxn || ""))],
    });
  }

  useEffect(() => {
    if (!activeOrgId || orgSwitching) return;
    setBusy(true);
    setErr(null);
    refreshData()
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [activeOrgId, orgSwitching]);

  useEffect(() => {
    if (!form.customerId) return;
    const customer = customerById.get(form.customerId);
    if (!customer) return;
    setForm((current) => {
      if (current.billToName.trim() && current.billToName.trim() !== customer.name) return current;
      return { ...current, billToName: customer.name };
    });
  }, [form.customerId, customerById]);

  useEffect(() => {
    if (!formOpen || editingId || invoiceNoTouched || !form.issueDate) return;
    fillNextInvoiceNo(form.issueDate).catch(() => void 0);
  }, [formOpen, editingId, invoiceNoTouched, form.issueDate]);

  useEffect(() => {
    if (params.get("tab") !== "invoices") return;
    if (params.get("new") !== "1") return;
    const prefillKey = [
      params.get("customerId") || "",
      params.get("issueDate") || "",
      params.get("currency") || "",
      params.get("fxRate") || "",
      params.get("amountTxn") || "",
      params.get("description") || "",
      params.get("memo") || "",
      params.get("entryId") || "",
      params.get("entryLineNo") || "",
    ].join("|");
    if (prefillKeyRef.current === prefillKey) return;
    prefillKeyRef.current = prefillKey;
    openNewForm({
      customerId: params.get("customerId") || "",
      issueDate: params.get("issueDate") || new Date().toISOString().slice(0, 10),
      currency: (params.get("currency") || baseCurrency || "SGD").toUpperCase(),
      fxRate: params.get("fxRate") || "1",
      memo: params.get("memo") || "",
      entryId: params.get("entryId") || "",
      entryLineNo: params.get("entryLineNo") || "",
      billToName: customerById.get(params.get("customerId") || "")?.name || "",
      lineItems: [blankLineItem(params.get("description") || "Package fee 配套费", params.get("amountTxn") || "")],
    });
  }, [params, baseCurrency, customerById]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{tr("已开发票", "Issued invoices")}</div>
            <div className="mt-1 text-sm text-zinc-500">
              {tr("按你提供的 PDF 模版维护发票编号、Bill to、款项明细与收款信息。", "Manage invoice number, bill to, line items, and remittance info based on the PDF template.")}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
              onClick={() => {
                updateParams((next) => next.set("tab", "invoices"));
                openNewForm();
              }}
              type="button"
            >
              {tr("新开发票", "New invoice")}
            </button>
            {params.get("customerId") ? (
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => {
                  updateParams((next) => {
                    next.delete("customerId");
                    next.set("tab", "invoices");
                  });
                }}
                type="button"
              >
                {tr("清除客户筛选", "Clear customer filter")}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {formOpen ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold">{editingId ? tr("编辑发票", "Edit invoice") : tr("新开发票", "New invoice")}</div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => {
                  setFormOpen(false);
                  setEditingId(null);
                  setInvoiceNoTouched(false);
                  clearInvoicePrefillParams();
                }}
                type="button"
              >
                {tr("取消", "Cancel")}
              </button>
              <button
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                disabled={saving}
                onClick={() => void submitInvoice(false)}
                type="button"
              >
                {editingId ? tr("保存发票", "Save invoice") : tr("创建发票", "Create invoice")}
              </button>
              <button
                className="rounded-md border border-blue-700 bg-white px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                disabled={saving}
                onClick={() => void submitInvoice(true)}
                type="button"
              >
                {editingId ? tr("保存并下载 PDF", "Save & Download PDF") : tr("创建并下载 PDF", "Create & Download PDF")}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div>
              <label className="text-xs text-zinc-600">{tr("客户", "Customer")}</label>
              <select
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                value={form.customerId}
                onChange={(e) => {
                  const customerId = e.target.value;
                  const customer = customerById.get(customerId);
                  setForm((current) => ({
                    ...current,
                    customerId,
                    billToName: customer?.name || current.billToName,
                  }));
                  updateParams((next) => {
                    next.set("tab", "invoices");
                    if (customerId) next.set("customerId", customerId);
                    else next.delete("customerId");
                  });
                }}
              >
                <option value="">{tr("请选择", "Select")}</option>
                {customers
                  .filter((customer) => (customer.isActive ?? true) || String(customer.id) === form.customerId)
                  .map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.code ? `${customer.code} ` : ""}
                      {customer.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-600">{tr("发票号码", "Invoice No.")}</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={form.invoiceNo}
                onChange={(e) => {
                  setInvoiceNoTouched(true);
                  setForm((current) => ({ ...current, invoiceNo: e.target.value.toUpperCase() }));
                }}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-600">{tr("日期", "Date")}</label>
              <input
                className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                type="date"
                value={form.issueDate}
                onChange={(e) => {
                  const issueDate = e.target.value;
                  setInvoiceNoTouched(false);
                  setForm((current) => ({ ...current, issueDate }));
                }}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-600">{tr("状态", "Status")}</label>
              <select
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                value={form.status}
                onChange={(e) => setForm((current) => ({ ...current, status: e.target.value as "draft" | "issued" }))}
              >
                <option value="issued">{tr("已开立", "Issued")}</option>
                <option value="draft">{tr("草稿", "Draft")}</option>
              </select>
            </div>
          </div>

          <div className="mt-4 overflow-auto rounded-lg border border-zinc-100">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-600">
                <tr>
                  <th className="px-3 py-2 text-left">{tr("模板必填项", "Template required field")}</th>
                  <th className="px-3 py-2 text-left">{tr("填写内容", "Value")}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: "Bill to 付款单位",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.billToName}
                        onChange={(e) => setForm((current) => ({ ...current, billToName: e.target.value }))}
                      />
                    ),
                  },
                  {
                    label: "Currency 币种",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.currency}
                        onChange={(e) => setForm((current) => ({ ...current, currency: e.target.value.toUpperCase() }))}
                      />
                    ),
                  },
                  {
                    label: "Account name 收款人",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.paymentAccountName}
                        onChange={(e) => setForm((current) => ({ ...current, paymentAccountName: e.target.value }))}
                      />
                    ),
                  },
                  {
                    label: "Bank name 银行名",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.paymentBankName}
                        onChange={(e) => setForm((current) => ({ ...current, paymentBankName: e.target.value }))}
                      />
                    ),
                  },
                  {
                    label: "Bank address 银行地址",
                    input: (
                      <textarea
                        className="min-h-[72px] w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.paymentBankAddress}
                        onChange={(e) => setForm((current) => ({ ...current, paymentBankAddress: e.target.value }))}
                      />
                    ),
                  },
                  {
                    label: "Account number 银行账户",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.paymentAccountNumber}
                        onChange={(e) => setForm((current) => ({ ...current, paymentAccountNumber: e.target.value }))}
                      />
                    ),
                  },
                  {
                    label: "Swift code 国际汇款号",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.paymentSwiftCode}
                        onChange={(e) => setForm((current) => ({ ...current, paymentSwiftCode: e.target.value.toUpperCase() }))}
                      />
                    ),
                  },
                  {
                    label: "Official Stamp 公章",
                    input: (
                      <input
                        className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                        value={form.officialStamp}
                        onChange={(e) => setForm((current) => ({ ...current, officialStamp: e.target.value }))}
                        placeholder={tr("可留空，后续盖章", "Optional, add stamp later")}
                      />
                    ),
                  },
                ].map((row) => (
                  <tr key={row.label} className="border-t border-zinc-100">
                    <td className="px-3 py-2 align-top text-zinc-700">{row.label}</td>
                    <td className="px-3 py-2">{row.input}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">{tr("收款事项", "Line items")}</div>
              <button
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => setForm((current) => ({ ...current, lineItems: [...current.lineItems, blankLineItem()] }))}
                type="button"
              >
                {tr("增加行", "Add line")}
              </button>
            </div>
            <div className="overflow-auto rounded-lg border border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 text-left">S/N</th>
                    <th className="px-3 py-2 text-left">Particulars 收款事项</th>
                    <th className="px-3 py-2 text-left">Payment mode 付款方式</th>
                    <th className="px-3 py-2 text-right">Amount 金额</th>
                    <th className="px-3 py-2 text-right">{tr("操作", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {form.lineItems.map((item, idx) => (
                    <tr key={idx} className="border-t border-zinc-100">
                      <td className="px-3 py-2 text-zinc-600">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <input
                          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                          value={item.particulars}
                          onChange={(e) =>
                            setForm((current) => ({
                              ...current,
                              lineItems: current.lineItems.map((line, lineIdx) => (lineIdx === idx ? { ...line, particulars: e.target.value } : line)),
                            }))
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                          value={item.paymentMethod}
                          onChange={(e) =>
                            setForm((current) => ({
                              ...current,
                              lineItems: current.lineItems.map((line, lineIdx) => (lineIdx === idx ? { ...line, paymentMethod: e.target.value } : line)),
                            }))
                          }
                        >
                          {PAYMENT_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-right text-sm"
                          type="number"
                          step="0.01"
                          value={item.amount}
                          onChange={(e) =>
                            setForm((current) => ({
                              ...current,
                              lineItems: current.lineItems.map((line, lineIdx) => (lineIdx === idx ? { ...line, amount: e.target.value } : line)),
                            }))
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
                          disabled={form.lineItems.length <= 1}
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              lineItems: current.lineItems.filter((_, lineIdx) => lineIdx !== idx),
                            }))
                          }
                          type="button"
                        >
                          {tr("删除", "Delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs text-zinc-600">{tr("备注", "Memo")}</label>
              <textarea
                className="mt-1 min-h-[96px] w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={form.memo}
                onChange={(e) => setForm((current) => ({ ...current, memo: e.target.value }))}
              />
            </div>
            <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-4">
              <div className="text-sm font-semibold">{tr("模板汇总", "Template summary")}</div>
              <div className="mt-2 text-sm text-zinc-600">
                INVOICE 发票 · Invoice No. {form.invoiceNo || "-"}
              </div>
              <div className="mt-1 text-sm text-zinc-600">
                Bill to: {form.billToName || "-"} · Date: {form.issueDate || "-"}
              </div>
              <div className="mt-3 text-lg font-semibold text-zinc-900">
                TOTAL 合计 ({form.currency || "SGD"}) {totalTxn.toFixed(2)}
              </div>
              <div className="mt-3 space-y-2 border-t border-zinc-200 pt-3 text-sm text-zinc-700">
                {form.lineItems.map((item, idx) => (
                  <div key={idx} className="rounded-md bg-white px-3 py-2">
                    <div className="font-medium">
                      {idx + 1}. {item.particulars || "-"}
                    </div>
                    <div className="mt-1 text-zinc-600">
                      Payment mode: {item.paymentMethod || "-"}
                    </div>
                    <div className="mt-1 text-zinc-600">
                      Amount: {form.currency || "SGD"} {(Math.round((Number(item.amount) || 0) * 100) / 100).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {err ? <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        {err && !formOpen ? <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : null}
        <div className="overflow-auto rounded-lg border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-600">
              <tr>
                <th className="px-3 py-2 text-left">{tr("发票号", "Invoice No.")}</th>
                <th className="px-3 py-2 text-left">{tr("日期", "Date")}</th>
                <th className="px-3 py-2 text-left">{tr("客户", "Customer")}</th>
                <th className="px-3 py-2 text-left">{tr("状态", "Status")}</th>
                <th className="px-3 py-2 text-right">{tr("金额", "Amount")}</th>
                <th className="px-3 py-2 text-right">{tr("操作", "Action")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredInvoices.map((invoice) => (
                <tr key={invoice.id} className="border-t border-zinc-100">
                  <td className="px-3 py-2 font-medium text-zinc-800">{invoice.invoiceNo}</td>
                  <td className="px-3 py-2">{invoice.issueDate}</td>
                  <td className="px-3 py-2">{invoice.billToName || invoice.customerName || "-"}</td>
                  <td className="px-3 py-2">{invoice.status === "draft" ? tr("草稿", "Draft") : tr("已开立", "Issued")}</td>
                  <td className="px-3 py-2 text-right">
                    {invoice.currency} {Number(invoice.totalTxn || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                        onClick={() => startEdit(invoice)}
                        type="button"
                      >
                        {tr("编辑", "Edit")}
                      </button>
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                        onClick={() => downloadPdf(invoice.id)}
                        type="button"
                      >
                        {tr("下载 PDF", "Download PDF")}
                      </button>
                      <button
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                        onClick={() => openPrintPreview(invoice.id)}
                        type="button"
                      >
                        {tr("预览", "Preview")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filteredInvoices.length ? (
                <tr>
                  <td className="px-3 py-8 text-center text-sm text-zinc-500" colSpan={6}>
                    {busy ? tr("加载中...", "Loading...") : tr("暂无发票", "No invoices")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
